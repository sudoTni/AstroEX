import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import { type Observable, defer, throwError } from "rxjs";
import { fromPromise } from "rxjs/internal-compatibility";
import { catchError } from "rxjs/operators";
import type { Arguments, Argv } from "yargs";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobDB, type JobDBConfig, type JobIdentity } from "../jobDB";
import {
	type StatisticsCollector,
	createStatisticsCollector,
} from "../statistics";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import { retryWithBackoff, sleepWithJitter } from "../utils/delayUtils";
import { withSpinner } from "../utils/spinner";

const jobsDataFolder = "data";
const rootDirectory = path.resolve(__dirname, "..", "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs");

fs.mkdirSync(dataDirectory, { recursive: true });

interface SearchParams {
	searchText: string;
	locationText: string;
	pageNumber: number;
}

export function buildLinkedInSearchUrl(
	searchText: string,
	locationText: string,
	start: number,
): string {
	return `https://linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(searchText)}&start=${start}${locationText ? `&location=${encodeURIComponent(locationText.replace(/"/g, ""))}` : ""}&f_TPR=r86400&f_WT=2`;
}

/** Remove jobs already seen by jobDB or earlier in the current scrape run. */
export function filterUnseenSearchJobs(
	jobs: JobIdentity[],
	seenJobKeys: Set<string>,
	jobDB?: Pick<JobDB, "isJobSeen">,
): JobIdentity[] {
	return jobs.filter((job) => {
		const stableId = job.id?.trim();
		const key = stableId
			? `id:${stableId}`
			: `fallback:${job.url || `${job.company.trim().toLowerCase()}|${job.title.trim().toLowerCase()}`}`;

		if (seenJobKeys.has(key) || jobDB?.isJobSeen(job)) {
			return false;
		}

		seenJobKeys.add(key);
		return true;
	});
}

/** Filter jobs by allowed company names (case-insensitive inclusion filter). */
export function filterCompanySearchJobs(
	jobs: JobIdentity[],
	companyFilters?: string[],
): JobIdentity[] {
	if (!companyFilters || companyFilters.length === 0) {
		return jobs;
	}
	const normalizedFilters = companyFilters
		.map((c) => c.toLowerCase().trim())
		.filter((c) => c.length > 0);
	if (normalizedFilters.length === 0) {
		return jobs;
	}
	return jobs.filter((job) => {
		const companyName = (job.company || "").toLowerCase();
		return normalizedFilters.some((filter) => companyName.includes(filter));
	});
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
		statusEveryQuery?: boolean;
		sleepSpinner?: boolean;
		maxPages?: number;
		maxRetries?: number;
		jobDB?: JobDB;
		companyFilters?: string[];
	},
	stats: StatisticsCollector,
): Promise<JobIdentity[]> {
	const {
		headless,
		sleepMin,
		sleepMax,
		outFile,
		statusEveryQuery = true,
		sleepSpinner = true,
		maxPages = 100,
		maxRetries = 3,
		jobDB,
		companyFilters,
	} = options;
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
	await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
	const results: JobIdentity[] = [];
	const seenJobKeys = new Set<string>();

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
		const totalSearchTerms = searchTermGroups.size;
		let searchedCount = 0;
		let queryCount = 0;

		for (const [key, params] of searchTermGroups) {
			const [searchText, locationText] = key.split("|");
			const searchTermTimer = stats.startTimer(`search.term.${key}`);
			const currentSearchNumber = searchedCount + 1;
			const termsLeft = totalSearchTerms - currentSearchNumber;
			const progressPercentage = Math.round(
				(currentSearchNumber / totalSearchTerms) * 100,
			);

			const searchResults: JobIdentity[] = [];

			// Process pages for this search term with dynamic pagination
			let currentPage = 0;
			let resultOffset = 0;
			let continuePagination = true;

			while (continuePagination && currentPage < maxPages) {
				// Safety limit
				const url = buildLinkedInSearchUrl(
					searchText,
					locationText,
					resultOffset,
				);
				let pageAttempt = 0;

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
							pageAttempt++;
							queryCount++;
							stats.incrementCounter("search.queries", 1);
							stats.incrementCounter("api.totalCalls", 1);
							stats.incrementCounter("network.connections", 1);

							if (statusEveryQuery) {
								log(
									"ScrapeSearch",
									`[STATUS] Query ${queryCount}: search term ${currentSearchNumber}/${totalSearchTerms} (${progressPercentage}%), "${searchText}" — location: ${locationText || "All"}, page ${currentPage + 1}, attempt ${pageAttempt}; ${termsLeft} terms remaining`,
									"info",
									{
										queryCount,
										pageAttempt,
										searchedCount,
										currentSearchNumber,
										totalSearchTerms,
										termsLeft,
										progressPercentage,
										searchText,
										locationText,
										pageNumber: currentPage,
										totalPages: params.length,
										url,
									},
								);
							}

							return await withSpinner(
								`Waiting for ScrapeSearch query results for "${searchText}" (page ${currentPage + 1})...`,
								() =>
									new Promise((resolve, reject) => {
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
									}),
								{ enabled: sleepSpinner, addNewline: true },
							);
						},
						{
							maxRetries,
							baseDelay: 1000,
							maxDelay: 10000,
							backoffFactor: 2,
							jitter: true,
						},
						(attempt, error, delay) => {
							stats.incrementCounter("search.retries", 1);
							stats.incrementCounter("api.retries", 1);
							stats.incrementCounter("network.retries", 1);
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
					stats.incrementCounter("api.successfulCalls", 1);

					stats.endTimer(pageScrapeTimer);

					if (jobResults && Array.isArray(jobResults)) {
						let matchingCompanyJobs = jobResults;
						let companyFilteredCount = 0;
						if (companyFilters && companyFilters.length > 0) {
							matchingCompanyJobs = filterCompanySearchJobs(
								jobResults,
								companyFilters,
							);
							companyFilteredCount =
								jobResults.length - matchingCompanyJobs.length;
						}

						const uniqueJobResults = filterUnseenSearchJobs(
							matchingCompanyJobs,
							seenJobKeys,
							jobDB,
						);
						const duplicatesRemoved =
							matchingCompanyJobs.length - uniqueJobResults.length;

						stats.incrementCounter("search.pages.successful", 1);
						stats.incrementCounter("data.jobsExtracted", jobResults.length);
						stats.incrementCounter("data.recordsProcessed", jobResults.length);
						stats.incrementCounter(
							"data.recordsFiltered",
							duplicatesRemoved + companyFilteredCount,
						);
						stats.incrementCounter("data.duplicatesRemoved", duplicatesRemoved);
						if (companyFilteredCount > 0) {
							stats.incrementCounter(
								"data.companyFilteredOut",
								companyFilteredCount,
							);
						}
						stats.recordHistogram("search.jobsPerPage", jobResults.length);

						log(
							"ScrapeSearch",
							`Extracted ${jobResults.length} jobs from page ${currentPage + 1}`,
							"log",
							{
								searchText,
								locationText,
								pageNumber: currentPage,
								jobCount: jobResults.length,
							},
						);
						if (companyFilteredCount > 0) {
							log(
								"ScrapeSearch",
								`Filtered out ${companyFilteredCount} jobs not matching company filter ${JSON.stringify(companyFilters)}`,
								"info",
								{
									companyFilteredCount,
									companyFilters,
									pageNumber: currentPage,
									searchText,
								},
							);
						}
						if (duplicatesRemoved > 0) {
							log(
								"ScrapeSearch",
								`Skipped ${duplicatesRemoved} jobs already seen within the 30-day jobDB window or this run`,
								"info",
								{
									duplicatesRemoved,
									newJobs: uniqueJobResults.length,
									pageNumber: currentPage,
									searchText,
								},
							);
						}
						searchResults.push(...uniqueJobResults);

						// Results are checkpointed after each search term. Rewriting the
						// whole array on every page makes large searches O(n²) in I/O.
						results.push(...uniqueJobResults);
						if (jobDB && uniqueJobResults.length > 0) {
							const jobsRecorded =
								await jobDB.addSearchedJobs(uniqueJobResults);
							stats.incrementCounter("jobDB.searchEntriesAdded", jobsRecorded);
						}
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
						resultOffset += jobResults.length;
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
					await withSpinner(
						`Sleeping ${sleepMin}-${sleepMax} seconds before the next ScrapeSearch page query...`,
						() => sleepWithJitter(sleepMin, sleepMax),
						{ enabled: sleepSpinner, addNewline: true },
					);
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
			const fileWriteTimer = stats.startTimer("file.write");
			await fs.promises.writeFile(
				outFile,
				JSON.stringify(results, null, 2),
				"utf-8",
			);
			stats.endTimer(fileWriteTimer);
			stats.incrementCounter("files.written", 1);
			stats.endTimer(searchTermTimer);
			searchedCount++;
			const remainingTerms = totalSearchTerms - searchedCount;

			log(
				"ScrapeSearch",
				`Completed search term "${searchText}" with ${searchResults.length} total jobs (${searchedCount}/${totalSearchTerms} searched, ${remainingTerms} remaining)`,
				"log",
				{
					searchedCount,
					totalSearchTerms,
					termsLeft: remainingTerms,
					searchText,
					locationText,
					totalJobsForTerm: searchResults.length,
				},
			);

			// Sleep between search terms with jitter
			if (sleepMin > 0 && searchTermGroups.size > 1) {
				await withSpinner(
					`Sleeping ${sleepMin}-${sleepMax} seconds before the next ScrapeSearch term...`,
					() => sleepWithJitter(sleepMin, sleepMax),
					{ enabled: sleepSpinner, addNewline: true },
				);
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
): Observable<JobIdentity[]> {
	const stats = options.stats as StatisticsCollector;
	const requestStartedAt = performance.now();

	return defer(async () => {
		const pageLoadTimer = stats.startTimer("search.pageLoad");
		const response = await page.goto(options.url, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		stats.endTimer(pageLoadTimer);
		stats.recordHistogram(
			"api.responseTime",
			performance.now() - requestStartedAt,
		);
		if (response && response.status() >= 400) {
			throw new Error(`LinkedIn search returned HTTP ${response.status()}`);
		}

		const contentParseTimer = stats.startTimer("search.contentParse");
		const jobs = await page.$$eval("div.base-search-card", (cards) =>
			cards.flatMap((card) => {
				const anchor = card.querySelector<HTMLAnchorElement>(
					"a.base-card__full-link",
				);
				const href = anchor?.href.split("?")[0] ?? "";
				const id = href.match(/-(\d+)$/)?.[1];
				const title =
					card.querySelector("span.sr-only")?.textContent?.trim() ?? "";
				const company =
					card
						.querySelector("h4.base-search-card__subtitle a")
						?.textContent?.trim() ?? "";
				if (!id || !title || !company) return [];
				return [
					{
						id,
						title,
						company,
						location:
							card
								.querySelector("span.job-search-card__location")
								?.textContent?.trim() ?? "",
						url: href,
						descriptionHtml: "",
					},
				];
			}),
		);
		stats.endTimer(contentParseTimer);
		stats.incrementCounter("search.cardsFound", jobs.length);
		log(
			"ScrapeSearch",
			`Extracted ${jobs.length} structured job cards`,
			"log",
			{
				url: options.url,
				jobCount: jobs.length,
			},
		);
		return jobs;
	}).pipe(
		catchError((error) => {
			stats.recordHistogram(
				"api.responseTime",
				performance.now() - requestStartedAt,
			);
			stats.incrementCounter("api.failedCalls", 1);
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			if (/timeout|timed out/i.test(errorMessage)) {
				stats.incrementCounter("network.timeouts", 1);
			}
			log(
				"ScrapeSearch",
				`Error scraping search page: ${errorMessage}`,
				"error",
				{
					url: options.url,
					error: errorMessage,
				},
			);
			return throwError(error);
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
						"Minimum delay in seconds between requests. Defaults to 3. Used with --sleep-max for jitter range.",
					default: 3,
				})
				.option("sleep-max", {
					alias: "smax",
					type: "number",
					description:
						"Maximum delay in seconds between requests. Defaults to 7. Used with --sleep-min for jitter range.",
					default: 7,
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
						'Comma-separated list of locations to search in. If not specified, searches globally. Example: --locations \'"","Example City, NY"\'',
				})
				.option("max-pages", {
					alias: "p",
					type: "number",
					description:
						"Maximum number of pages to scrape per search term. If not specified, will scrape all available pages until no more results are found.",
				})
				.option("status-every-query", {
					type: "boolean",
					description:
						"Output a ScrapeSearch progress status line before every LinkedIn query.",
					default: true,
				})
				.option("sleep-spinner", {
					type: "boolean",
					description:
						"Display a spinner during ScrapeSearch query execution and delays between page queries and search terms.",
					default: true,
				})
				.option("use-jobdb", {
					type: "boolean",
					description:
						"Prevent jobs discovered in the last 30 days from entering scrape-search output.",
					default: true,
				})
				.option("company-filters", {
					alias: ["c", "company", "company-filter"],
					type: "string",
					description:
						"Comma-separated list of company names to filter for. Only listings belonging to matching companies will be scraped.",
				});
		},
		handler: async (argv: Arguments<GlobalArgs & ScrapeSearchArgs>) => {
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
			log("ScrapeSearch", "Command started", "info", { params: argv });

			// Initialize statistics collection
			const stats = createStatisticsCollector("scrape-search");
			stats.startCollection();

			const startTime = performance.now();
			log("ScrapeSearch", "Preparing search acquisition", "debug");

			// Defensive extraction and defaults
			const headless =
				typeof argv.headless === "boolean" ? argv.headless : true;
			const sleepMin =
				typeof argv.sleepMin === "number" && !Number.isNaN(argv.sleepMin)
					? argv.sleepMin
					: 3;
			const sleepMax =
				typeof argv.sleepMax === "number" && !Number.isNaN(argv.sleepMax)
					? argv.sleepMax
					: 7;
			const retryMax =
				typeof argv.retryMax === "number" && !Number.isNaN(argv.retryMax)
					? argv.retryMax
					: 3;
			const statusEveryQuery =
				typeof argv.statusEveryQuery === "boolean"
					? argv.statusEveryQuery
					: true;
			const sleepSpinner =
				typeof argv.sleepSpinner === "boolean" ? argv.sleepSpinner : true;
			const useJobDB = argv["use-jobdb"] ?? true;
			const maxPages =
				typeof argv.maxPages === "number" && !Number.isNaN(argv.maxPages)
					? argv.maxPages
					: 1000; // Use a large but finite number

			let companyFilters: string[] | undefined;
			const rawCompanyFilters =
				argv["company-filters"] || argv.companyFilters || argv.company;
			if (
				typeof rawCompanyFilters === "string" &&
				rawCompanyFilters.trim().length > 0
			) {
				companyFilters = rawCompanyFilters
					.split(",")
					.map((c: string) => c.trim())
					.filter((c: string) => c.length > 0);

				log(
					"ScrapeSearch",
					`Configured company inclusion filter: ${JSON.stringify(companyFilters)}`,
					"info",
					{ companyFilters },
				);
				stats.incrementCounter("search.companyFilter.active", 1);
			}

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
				stats.incrementCounter("files.opened", 1);
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
					"Using command line search terms instead of external file",
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

			// Pagination is performed inside scrapeSearchResults. One seed per
			// term/location avoids allocating maxPages × terms placeholder objects.
			const searchParams: SearchParams[] = [];
			const searchParamsTimer = stats.startTimer("search.parameters.creation");

			for (const term of searchTerms) {
				for (const location of locations) {
					searchParams.push({
						searchText: term,
						locationText: location,
						pageNumber: 0,
					});
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

			let jobDB: JobDB | undefined;
			try {
				const jobDBConfig: JobDBConfig = {
					dbFilePath: path.join(dataDirectory, "jobDB.json"),
					defaultExpirationMs: JOB_DB_RETENTION_MS,
					enableJobDB: useJobDB,
				};
				jobDB = new JobDB(jobDBConfig);
				await jobDB.initialize();
				await jobDB.load();
				const expiredEntriesRemoved = await jobDB.cleanupExpired();
				stats.incrementCounter(
					"jobDB.expiredEntriesRemoved",
					expiredEntriesRemoved,
				);
				log(
					"ScrapeSearch",
					`jobDB ready with ${jobDB.size()} active entries (${expiredEntriesRemoved} expired entries removed)`,
					"info",
					{
						enabled: useJobDB,
						expirationMs: JOB_DB_RETENTION_MS,
						expiredEntriesRemoved,
					},
				);

				const scrapedJobs = await scrapeSearchResults(
					searchParams,
					{
						headless,
						sleepMin,
						sleepMax,
						outFile,
						statusEveryQuery,
						sleepSpinner,
						maxPages,
						maxRetries: retryMax,
						jobDB,
						companyFilters,
					},
					stats,
				);
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);
				stats.recordSuccess("scrape-search.complete", {
					totalJobs: scrapedJobs.length,
					outputFile: outFile,
				});

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
						totalJobs: scrapedJobs.length,
						duplicatesRemoved: summary.data.duplicatesRemoved,
						companyFilteredOut:
							summary.metrics?.counters?.["data.companyFilteredOut"] || 0,
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
				if (jobDB) {
					await jobDB.close();
				}
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
	companyFilters?: string;
	company?: string;
	"company-filters"?: string;
	maxPages: number;
	statusEveryQuery: boolean;
	sleepSpinner: boolean;
	"use-jobdb": boolean;
}
