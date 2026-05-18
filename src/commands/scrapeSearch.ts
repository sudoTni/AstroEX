import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import { defer, type Observable, of } from "rxjs";
import { fromPromise } from "rxjs/internal-compatibility";
import { catchError, map, switchMap } from "rxjs/operators";
import type { Arguments, Argv } from "yargs";
import {
	createStatisticsCollector,
	type StatisticsCollector,
} from "../statistics";
import { JobDB, type JobDBConfig } from "../jobDB";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import { retryWithBackoff, sleepWithJitter } from "../utils/delayUtils";

const jobsDataFolder: string = `data`;
const rootDirectory = path.resolve(__dirname, "..", "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs");

fs.mkdirSync(dataDirectory, { recursive: true });

interface SearchParams {
	searchText: string;
	locationText: string;
	pageNumber: number;
}

/**
 * Core search scraping logic with dynamic pagination and retry mechanisms.
 * Scrapes job search results from LinkedIn API for given search terms.
 * @param searchParams Array of search parameters
 * @param options { headless: boolean, sleepMin: number, sleepMax: number, outFile: string }
 * @returns Promise of array of job results
 */
export async function scrapeSearchResults(
	searchParams: SearchParams[],
	options: {
		headless: boolean;
		sleepMin: number;
		sleepMax: number;
		outFile: string;
	},
	stats: StatisticsCollector,
	jobDB: JobDB,
): Promise<unknown[]> {
	const { headless, sleepMin, sleepMax, outFile } = options;
	const browserLaunchTimer = stats.startTimer("browser.launch");
	const browser = await puppeteer.launch({
		headless,
		args: [
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-setuid-sandbox",
			"--no-first-run",
			"--no-sandbox",
			"--no-zygote",
			"--single-process",
		],
	});
	stats.endTimer(browserLaunchTimer);
	stats.incrementCounter("browser.instances", 1);

	const pageCreationTimer = stats.startTimer("browser.page");
	const page = await browser.newPage();
	stats.endTimer(pageCreationTimer);
	const results: unknown[] = [];

	try {
		// Group search parameters by search term to handle pagination per term
		const searchTermGroups = new Map<string, SearchParams[]>();
		const searchGroupingTimer = stats.startTimer("search.grouping");
		for (const param of searchParams) {
			const key = `${param.searchText}|${param.locationText}`;
			if (!searchTermGroups.has(key)) {
				searchTermGroups.set(key, []);
			}
			searchTermGroups.get(key)?.push(param);
		}
		stats.endTimer(searchGroupingTimer);
		stats.incrementCounter("search.terms", searchTermGroups.size);

		// Process each search term group
		stats.incrementCounter("search.terms.processed", searchTermGroups.size);
		for (const [key, params] of searchTermGroups) {
			const [searchText, locationText] = key.split("|");
			const searchTermTimer = stats.startTimer(`search.term.${key}`);
			log(
				"ScrapeSearch",
				`Starting search term: "${searchText}" in location: ${locationText || "All"}`,
				"log",
				{
					searchText,
					locationText,
					totalPages: params.length,
				},
			);

			const searchResults: unknown[] = [];

			// Process pages for this search term with dynamic pagination
			let currentPage = 0;
			let continuePagination = true;

			while (continuePagination && currentPage < 1000) {
				// Safety limit
				const url = `https://linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(searchText)}&start=${currentPage * 25}${locationText ? `&location=${encodeURIComponent(locationText.replace(/"/g, ""))}` : ""}&f_TPR=r86400&f_WT=2`;

				log(
					"ScrapeSearch",
					`Scraping page ${currentPage + 1} for search: ${searchText}`,
					"log",
					{
						searchText,
						locationText,
						pageNumber: currentPage,
						url,
					},
				);

				try {
					const pageScrapeTimer = stats.startTimer("search.page");

					// Use retry mechanism with exponential backoff for page scraping
					const jobResults = await retryWithBackoff(
						async () => {
							return await new Promise((resolve, reject) => {
								const subscription = scrapeSearchPage(page, {
									url,
									stats,
								}).subscribe({
									next: (data) => {
										resolve(data);
										subscription.unsubscribe();
									},
									error: (err) => {
										reject(err);
										subscription.unsubscribe();
									},
									complete: () => {
										resolve(null);
									},
								});
							});
						},
						{
							maxRetries: 3,
							baseDelay: 1000,
							maxDelay: 10000,
							backoffFactor: 2,
							jitter: true,
						},
						(attempt, error, delay) => {
							stats.incrementCounter("search.retries", 1);
							log(
								"ScrapeSearch",
								`Retry attempt ${attempt} for page ${currentPage + 1}: ${error.message}`,
								"warn",
								{
									searchText,
									locationText,
									pageNumber: currentPage,
									attempt,
									delay,
								},
							);
						},
					);

					stats.endTimer(pageScrapeTimer);

					if (jobResults && Array.isArray(jobResults)) {
						// Filter out jobs that are already in JobDB
						const uniqueJobs: unknown[] = [];
						let skippedCount = 0;
						for (const job of jobResults) {
							if (jobDB.isJobMatched(job as any)) {
								skippedCount++;
								stats.incrementCounter("search.jobs.skipped.jobDB", 1);
							} else {
								uniqueJobs.push(job);
							}
						}

						if (skippedCount > 0) {
							log(
								"ScrapeSearch",
								`Skipped ${skippedCount} previously seen jobs using JobDB`,
								"log",
								{ skippedCount }
							);
						}

						stats.incrementCounter("search.pages.successful", 1);
						stats.incrementCounter("data.jobsExtracted", uniqueJobs.length);
						stats.incrementCounter("data.recordsProcessed", uniqueJobs.length);
						stats.recordHistogram("search.jobsPerPage", uniqueJobs.length);

						log(
							"ScrapeSearch",
							`Extracted ${uniqueJobs.length} new jobs from page ${currentPage + 1} (Total returned: ${jobResults.length})`,
							"log",
							{
								searchText,
								locationText,
								pageNumber: currentPage,
								jobCount: jobResults.length,
								uniqueCount: uniqueJobs.length,
							},
						);
						searchResults.push(...uniqueJobs);

						// Update the JSON file with current total results
						results.push(...uniqueJobs);
						const fileWriteTimer = stats.startTimer("file.write");
						await fs.promises.writeFile(
							outFile,
							JSON.stringify(results, null, 2),
							"utf-8",
						);
						stats.endTimer(fileWriteTimer);
						stats.incrementCounter("files.written", 1);
						log(
							"ScrapeSearch",
							`Updated output file with ${results.length} total jobs: ${outFile}`,
							"log",
							{
								totalJobs: results.length,
								currentSearch: searchText,
								currentPage: currentPage + 1,
							},
						);

						// Dynamic pagination logic
						if (jobResults.length === 0) {
							// No jobs found - likely end of results
							stats.incrementCounter("search.pages.empty", 1);
							log(
								"ScrapeSearch",
								`Page ${currentPage + 1} returned 0 jobs - stopping pagination for search term "${searchText}"`,
								"log",
								{
									searchText,
									locationText,
									pageNumber: currentPage,
									jobCount: jobResults.length,
								},
							);
							continuePagination = false;
						} else if (uniqueJobs.length === 0 && skippedCount > 0) {
							// All jobs on this page were already seen - we've reached previously processed jobs
							stats.incrementCounter("search.pages.allSkipped", 1);
							log(
								"ScrapeSearch",
								`Page ${currentPage + 1} contained only previously seen jobs (${skippedCount} skipped) - stopping pagination early to maximize efficiency`,
								"log",
								{
									searchText,
									locationText,
									pageNumber: currentPage,
									skippedCount,
								},
							);
							continuePagination = false;
						} else if (jobResults.length < 10) {
							// Few jobs found - likely end of meaningful results
							stats.incrementCounter("search.pages.partial", 1);
							log(
								"ScrapeSearch",
								`Page ${currentPage + 1} returned ${jobResults.length} jobs (less than 10) - stopping pagination for search term "${searchText}"`,
								"log",
								{
									searchText,
									locationText,
									pageNumber: currentPage,
									jobCount: jobResults.length,
								},
							);
							continuePagination = false;
						}
					} else {
						stats.incrementCounter("search.pages.failed", 1);
						stats.recordError(new Error("No job-search-card found"));
						log(
							"ScrapeSearch",
							`No job-search-card found on page ${currentPage + 1} - stopping pagination for search term "${searchText}"`,
							"log",
							{
								searchText,
								locationText,
								pageNumber: currentPage,
							},
						);
						continuePagination = false;
					}
				} catch (err) {
					stats.incrementCounter("search.pages.failed", 1);
					const errorMessage = err instanceof Error ? err.message : String(err);
					stats.recordError(new Error(errorMessage), {
						searchText,
						locationText,
						error: errorMessage,
						pageNumber: currentPage,
					});
					log(
						"ScrapeSearch",
						`Error scraping search ${searchText} on page ${currentPage + 1}: ${errorMessage}`,
						"error",
						{
							searchText,
							locationText,
							error: errorMessage,
							pageNumber: currentPage,
						},
					);
					continuePagination = false;
				}

				// Sleep between requests with jitter
				if (sleepMin > 0) {
					await sleepWithJitter(sleepMin, sleepMax);
					log(
						"ScrapeSearch",
						`Slept between ${sleepMin} and ${sleepMax} seconds before next page...`,
						"log",
						{
							sleepMin,
							sleepMax,
						},
					);
				}

				currentPage++;
			}
			stats.endTimer(searchTermTimer);
			stats.incrementCounter("data.recordsFiltered", searchResults.length);

			log(
				"ScrapeSearch",
				`Completed search term "${searchText}" with ${searchResults.length} total jobs`,
				"log",
				{
					searchText,
					locationText,
					totalJobsForTerm: searchResults.length,
				},
			);

			// Sleep between search terms with jitter
			if (sleepMin > 0 && searchTermGroups.size > 1) {
				await sleepWithJitter(sleepMin, sleepMax);
				log(
					"ScrapeSearch",
					`Slept between ${sleepMin} and ${sleepMax} seconds before next search term...`,
					"log",
					{
						sleepMin,
						sleepMax,
					},
				);
			}
		}

		const browserCloseTimer = stats.startTimer("browser.close");
		await browser.close();
		stats.endTimer(browserCloseTimer);
		stats.incrementCounter("browser.instances.closed", 1);

		log(
			"ScrapeSearch",
			`Final scraped data written to ${outFile} with ${results.length} total jobs`,
			"log",
			{
				totalJobs: results.length,
				outFile,
			},
		);
		return results;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		stats.recordError(new Error(errorMessage));
		await browser.close();
		throw error;
	}
}

/**
 * Scrape job search results from a single page
 */
function scrapeSearchPage(
	page: puppeteer.Page,
	options: { url: string; stats: unknown },
): Observable<unknown[]> {
	const _pageLoadTimer = (options.stats as StatisticsCollector).startTimer(
		"search.pageLoad",
	);
	return defer(() =>
		fromPromise(page.goto(options.url, { waitUntil: "networkidle0" })),
	).pipe(
		switchMap(() => page.content()),
		map((htmlContent: string) => {
			// Check if .job-search-card element exists
			const hasJobSearchCard =
				htmlContent.includes('class="job-search-card"') ||
				htmlContent.includes("job-search-card");

			if (!hasJobSearchCard) {
				log(
					"ScrapeSearch",
					"No job-search-card found on page - indicating final page reached",
					"log",
					{
						url: options.url,
					},
				);
				return []; // Return empty array to indicate no more results
			}

			// Parse the HTML content to extract job listings
			const jobs: unknown[] = [];

			// Match individual job cards based on the actual HTML structure
			const jobCardPattern =
				/<div[^>]*class="[^"]*base-search-card[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g;
			const jobCards = htmlContent.match(jobCardPattern) || [];
			(options.stats as StatisticsCollector).incrementCounter(
				"search.cardsFound",
				jobCards.length,
			);

			log("ScrapeSearch", `Found ${jobCards.length} job cards on page`, "log", {
				url: options.url,
				cardCount: jobCards.length,
			});

			for (const card of jobCards) {
				// Debug: Show the first few characters of the card
				if (jobCards.length > 0 && jobs.length === 0) {
					log(
						"ScrapeSearch",
						`Debug: Sample card content (first 200 chars): ${card.substring(0, 200)}...`,
						"log",
						{
							url: options.url,
						},
					);
				}

				// Extract title from base-search-card__title
				const titleMatch = card.match(
					/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([^<]*?)<\/h3>/,
				);
				// Extract company from base-search-card__subtitle (within an <a> tag)
				const companyMatch = card.match(
					/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*">[\s\S]*?<a[^>]*>([^<]*?)<\/a>/,
				);
				// Extract location from job-search-card__location
				const locationMatch = card.match(
					/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([^<]*?)<\/span>/,
				);
				// Extract URL from the full link
				const urlMatch = card.match(/href="([^"]*jobs\/view\/[^"]*)"/);

				// Debug: Log what each regex found
				if (jobCards.length > 0 && jobs.length === 0) {
					log(
						"ScrapeSearch",
						`Debug: titleMatch: ${titleMatch ? "Found" : "Not found"}`,
						"log",
						{
							url: options.url,
						},
					);
					log(
						"ScrapeSearch",
						`Debug: companyMatch: ${companyMatch ? "Found" : "Not found"}`,
						"log",
						{
							url: options.url,
						},
					);
					log(
						"ScrapeSearch",
						`Debug: locationMatch: ${locationMatch ? "Found" : "Not found"}`,
						"log",
						{
							url: options.url,
						},
					);
					log(
						"ScrapeSearch",
						`Debug: urlMatch: ${urlMatch ? "Found" : "Not found"}`,
						"log",
						{
							url: options.url,
						},
					);
				}

				if (titleMatch && companyMatch && urlMatch) {
					jobs.push({
						id: urlMatch[1].split("-").pop()?.match(/\d+/)?.[0] || "unknown",
						title: titleMatch[1]?.trim() || "",
						company: companyMatch[1]?.trim() || "",
						location: locationMatch?.[1]?.trim() || "",
						url: `https://linkedin.com${urlMatch[1]}`.replace(
							/^(https?:\/\/(?:www\.)?linkedin\.com){1,2}(https?:\/\/)/i,
							"$2",
						),
						descriptionHtml: "",
					});
				}
			}

			log(
				"ScrapeSearch",
				`Successfully extracted ${jobs.length} jobs from page`,
				"log",
				{
					url: options.url,
					extractedJobs: jobs.length,
				},
			);

			// If no jobs were extracted from a page that has job-search-card,
			// it indicates the end of results for this search
			if (jobs.length === 0) {
				log(
					"ScrapeSearch",
					"Page contains job-search-card but 0 jobs extracted - indicating final page reached",
					"log",
					{
						url: options.url,
						cardCount: jobCards.length,
						extractedJobs: jobs.length,
					},
				);
			}
			(options.stats as StatisticsCollector).endTimer(_pageLoadTimer);
			return jobs;
		}),
		catchError((error) => {
			(options.stats as StatisticsCollector).incrementCounter(
				"api.failedCalls",
				1,
			);
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			(options.stats as StatisticsCollector).recordError(
				new Error(errorMessage),
				{ url: options.url },
			);
			log(
				"ScrapeSearch",
				`Error scraping search page: ${errorMessage}`,
				"error",
				{
					url: options.url,
					error: errorMessage,
				},
			);
			return of([]);
		}),
	);
}

export const addScrapeSearchCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "scrape-search",
		describe: "Recursively scrape job search results from LinkedIn API",
		builder: (yargs: Argv<GlobalArgs>) => {
			return (yargs as unknown as Argv<GlobalArgs & ScrapeSearchArgs>)
				.option("headless", {
					alias: "hdl",
					type: "boolean",
					description:
						"Whether or not execute puppeteer in headless mode. Defaults to true",
					default: true,
				})
				.option("sleep-min", {
					alias: "smin",
					type: "number",
					description:
						"Minimum delay in seconds between requests. Defaults to 2.5. Used with --sleep-max for jitter range.",
					default: 2.5,
				})
				.option("sleep-max", {
					alias: "smax",
					type: "number",
					description:
						"Maximum delay in seconds between requests. Defaults to 4.5. Used with --sleep-min for jitter range.",
					default: 4.5,
				})
				.option("retry-max", {
					alias: "r",
					type: "number",
					description:
						"Maximum number of retry attempts for failed requests. Defaults to 3.",
					default: 3,
				})
				.option("search-terms", {
					alias: "t",
					type: "string",
					description:
						"Comma-separated list of search terms to use. If not specified, uses all predefined technologies.",
				})
				.option("locations", {
					alias: "L",
					type: "string",
					description:
						'Comma-separated list of locations to search in. If not specified, searches globally. Example: --locations \'"","Albany, NY"\'',
				})
				.option("max-pages", {
					alias: "p",
					type: "number",
					description:
						"Maximum number of pages to scrape per search term. If not specified, will scrape all available pages until no more results are found.",
				})
				.option("use-jobdb", {
					type: "boolean",
					description:
						"Enable jobDB functionality to prevent duplicate scraping by company/title with expiration (default: true)",
					default: true,
				});
		},
		handler: async (argv: Arguments<GlobalArgs & ScrapeSearchArgs>) => {
			log(
				"ScrapeSearch",
				`Command parameters: ${JSON.stringify(argv)}`,
				"info",
				{
					params: argv,
				},
			);
			if (!argv.disableFileLogging) {
				const logDir =
					typeof argv.logDir === "string" ? argv.logDir : defaultLogDirectory;
				const logFile =
					typeof argv.logFile === "string" ? argv.logFile : "astroex.log";
				initializeFileLogging(
					logDir,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_ScrapeSearch_${logFile}`,
					"ScrapeSearch",
				);
			}

			// Initialize statistics collection
			const stats = createStatisticsCollector("scrape-search");
			stats.startCollection();

			const startTime = performance.now();
			log("ScrapeSearch", "Starting scrape-search command... ");

			// Defensive extraction and defaults
			const headless =
				typeof argv.headless === "boolean" ? argv.headless : true;
			const sleepMin =
				typeof argv.sleepMin === "number" && !Number.isNaN(argv.sleepMin)
					? argv.sleepMin
					: 2.5;
			const sleepMax =
				typeof argv.sleepMax === "number" && !Number.isNaN(argv.sleepMax)
					? argv.sleepMax
					: 4.5;
			const _retryMax =
				typeof argv.retryMax === "number" && !Number.isNaN(argv.retryMax)
					? argv.retryMax
					: 3;
			const maxPages =
				typeof argv.maxPages === "number" && !Number.isNaN(argv.maxPages)
					? argv.maxPages
					: 1000; // Use a large but finite number

			// Get search terms from external file
			const rootDirectory = path.resolve(__dirname, "..", "..");
			const searchTermsFile = path.join(
				rootDirectory,
				"user_data",
				"search_terms.txt",
			);

			let searchTerms: string[] = [];
			const fileReadTimer = stats.startTimer("file.read");
			try {
				const fileContent = await fs.promises.readFile(
					searchTermsFile,
					"utf-8",
				);
				searchTerms = fileContent
					.split("\n")
					.map((line: string) => line.trim())
					.filter((line: string) => line.length > 0 && !line.startsWith("#"));

				log(
					"ScrapeSearch",
					`Loaded ${searchTerms.length} search terms from external file`,
					"log",
					{
						searchTermsFile,
						searchTermCount: searchTerms.length,
					},
				);
				stats.incrementCounter("files.read", 1);
				stats.recordSuccess("file.read");
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				stats.recordError(new Error(errorMessage), { searchTermsFile });
				log(
					"ScrapeSearch",
					`Error reading search terms file: ${errorMessage}. Using fallback search terms.`,
					"warn",
					{
						searchTermsFile,
						error: errorMessage,
					},
				);

				// Fallback to basic search terms if external file fails
				searchTerms = [
					"cybersecurity",
					"information security",
					"security analyst",
					"security engineer",
					"cybersecurity analyst",
					"cybersecurity engineer",
					"infosec",
					"security specialist",
					"security consultant",
				];
				stats.incrementCounter("files.read.failed", 1);
			}
			stats.endTimer(fileReadTimer);

			// Override with command line search terms if provided
			if (argv.searchTerms) {
				const searchTermCount = searchTerms.length;
				searchTerms = argv.searchTerms
					.split(",")
					.map((term: string) => term.trim())
					.filter((term: string) => term.length > 0);

				log(
					"ScrapeSearch",
					`Using command line search terms instead of external file`,
					"log",
					{
						searchTerms,
						previousCount: searchTermCount,
						newCount: searchTerms.length,
					},
				);
				stats.incrementCounter("search.terms.overridden", 1);
			}

			// Get locations - default to empty string for global search
			let locations = [""];
			if (
				typeof argv.locations === "string" &&
				argv.locations.trim().length > 0
			) {
				const locationString = argv.locations.trim();

				try {
					// Try to parse as JSON array first (most reliable)
					locations = JSON.parse(locationString);
				} catch (_error) {
					// Fallback: handle comma-separated values with proper quote preservation
					const rawLocations = locationString.split(",");

					locations = rawLocations
						.map((location: string) => {
							// Remove quotes and trim whitespace
							return location.replace(/^["']|["']$/g, "").trim();
						})
						.filter((location: string) => location.length > 0);

					// If the first location was an empty string (""), add it back for global search
					if (
						locationString.startsWith(",") ||
						locationString.startsWith('","') ||
						locationString.startsWith(",'")
					) {
						locations = ["", ...locations];
					}
				}
			}

			log(
				"ScrapeSearch",
				`Configured locations: ${JSON.stringify(locations)}`,
				"log",
				{
					locations,
				},
			);

			// Dynamic pagination: Generate search parameters on-demand
			// Instead of pre-generating all pages, we'll process each search term individually
			const searchParams: SearchParams[] = [];
			const searchParamsTimer = stats.startTimer("search.parameters.creation");

			// For now, we'll keep the pre-generation for backwards compatibility
			// but mark it for future optimization
			for (const term of searchTerms) {
				for (const location of locations) {
					let page = 0;
					while (page < maxPages) {
						searchParams.push({
							searchText: term,
							locationText: location,
							pageNumber: page,
						});
						page++;
					}
				}
			}
			stats.endTimer(searchParamsTimer);
			stats.incrementCounter("search.parameters.total", searchParams.length);

			log(
				"ScrapeSearch",
				`Generated ${searchParams.length} search parameters`,
				"log",
				{
					searchTerms,
					locations,
					maxPages,
					totalParams: searchParams.length,
				},
			);

			// Log first few parameters for verification
			const sampleParams = searchParams.slice(0, 5);
			log(
				"ScrapeSearch",
				`Sample search parameters: ${JSON.stringify(sampleParams, null, 2)}`,
				"log",
				{
					sampleParams,
				},
			);

			const outFile = path.join(
				dataDirectory,
				`scraped_search_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
			);

			try {
				// Initialize JobDB early on
				const jobDBConfig: JobDBConfig = {
					dbFilePath: path.join(dataDirectory, "jobDB.json"),
					defaultExpirationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
					enableJobDB: argv["use-jobdb"] ?? true,
					backupEnabled: false, // Don't backup heavily here to avoid I/O bottlenecks
				};
				const jobDB = new JobDB(jobDBConfig);
				stats.startTimer("jobDB.initialization");
				await jobDB.initialize();
				await jobDB.load();
				stats.endTimer("jobDB.initialization");

				await scrapeSearchResults(
					searchParams,
					{ headless, sleepMin, sleepMax, outFile },
					stats,
					jobDB,
				);
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				log(
					"ScrapeSearch",
					`Scrape-search command completed in ${duration}.`,
					"log",
					{
						duration,
						searchTerms: searchTerms.length,
						locations: locations.length,
						totalParameters: searchParams.length,
						totalJobs: summary.data.recordsProcessed,
						statistics: summary,
					},
				);

				// Export statistics to file
				const statsFile = path.join(
					dataDirectory,
					`scrape-search-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fs.promises.writeFile(statsFile, stats.export("json"), "utf-8");
				log("ScrapeSearch", `Statistics exported to: ${statsFile}`, "info");
			} catch (error: unknown) {
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Record error in statistics
				stats.recordError(
					error instanceof Error ? error : new Error(String(error)),
				);

				const errorMessage =
					error instanceof Error ? error.message : String(error);
				log(
					"ScrapeSearch",
					`Scrape-search command failed after ${duration}: ${errorMessage}`,
					"error",
					{ duration, error: errorMessage },
				);
			} finally {
				// Always end statistics collection
				const summary = stats.endCollection();
				log("ScrapeSearch", "Final statistics:", "info", { summary });

				await closeFileLogging();
				setTimeout(() => process.exit(0), 1000);
			}
		},
	});
};

interface ScrapeSearchArgs {
	headless: boolean;
	sleepMin: number;
	sleepMax: number;
	retryMax: number;
	searchTerms?: string;
	locations?: string;
	maxPages: number;
	"use-jobdb"?: boolean;
}
