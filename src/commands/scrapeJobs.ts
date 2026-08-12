import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import type { Arguments, Argv } from "yargs";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobDB, type JobDBConfig, type JobIdentity } from "../jobDB";
import { getJobDescription } from "../linkedin";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import { retryWithBackoff, sleepWithJitter } from "../utils/delayUtils";

const jobsDataFolder = "data";
const rootDirectory = path.resolve(__dirname, "..", "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs");

fs.mkdirSync(dataDirectory, { recursive: true });

export interface ScrapeJobTarget extends JobIdentity {
	url: string;
}

/**
 * `scrape-jobs` retrieves LinkedIn public job-detail pages. Indeed descriptions
 * are already supplied by the source-aware acquisition provider, so an Indeed
 * URL must never be sent to the LinkedIn page scraper.
 */
export function isLinkedInJobUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			/(^|\.)linkedin\.com$/i.test(parsed.hostname) &&
			/^\/jobs\/(?:view|c\/view)(?:\/|$)/i.test(parsed.pathname)
		);
	} catch {
		return false;
	}
}

/** Keep legacy artifacts without a source field working by identifying LinkedIn from the URL. */
export function filterLinkedInScrapeTargets(
	jobs: ScrapeJobTarget[],
): ScrapeJobTarget[] {
	return jobs.filter((job) => isLinkedInJobUrl(job.url));
}

/**
 * Extract the numeric job ID from a LinkedIn job URL
 * @param url LinkedIn job URL
 * @returns Numeric job ID or undefined if not found
 */
export function extractJobId(url: string): string | undefined {
	// Extract the numeric ID from various LinkedIn URL patterns
	const patterns = [
		/\/jobs\/view\/[^/]+-(\d+)/, // /jobs/view/job-title-12345
		/\/jobs\/view\/\?[^=]*=(\d+)/, // /jobs/view/?position=12345
		/\/jobs\/view\/(\d+)/, // /jobs/view/12345
		/\/jobs\/c\/view\/(\d+)/, // /jobs/c/view/12345
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}

	// Fallback: try to find any sequence of digits in the URL
	const digitMatch = url.match(/\d+/);
	return digitMatch ? digitMatch[0] : undefined;
}

/**
 * Remove duplicate targets from historical input files and jobs whose JD was
 * already persisted during the active jobDB retention window.
 */
export function filterJobsNeedingDescriptions(
	jobs: ScrapeJobTarget[],
	seenJobKeys: Set<string> = new Set<string>(),
	jobDB?: Pick<JobDB, "isJobDescriptionScraped">,
): ScrapeJobTarget[] {
	return jobs.filter((job) => {
		const linkedInJobId = job.id || extractJobId(job.url);
		const key = linkedInJobId
			? `linkedin:${linkedInJobId}`
			: `url:${job.url.trim().toLowerCase()}`;

		if (seenJobKeys.has(key)) {
			return false;
		}
		seenJobKeys.add(key);

		return !jobDB?.isJobDescriptionScraped(job);
	});
}

/**
 * Find all clothed_jobs_*.json files matching the input file pattern
 * @param inputFilePattern Input file pattern (e.g., "./data/clothed_jobs_*.json")
 * @returns Array of file paths
 */
async function findClothedJobFiles(
	inputFilePattern: string,
): Promise<string[]> {
	try {
		// Extract directory and pattern from the input file pattern
		const inputDir = path.dirname(inputFilePattern);
		const pattern = path.basename(inputFilePattern);

		// Get the base pattern without wildcard
		const patternBase = pattern.replace(/\*/, ".*");

		const files = await fs.promises.readdir(inputDir);
		const clothedJobFiles = files
			.filter((file) => new RegExp(`^${patternBase}$`).test(file))
			.map((file) => path.join(inputDir, file));

		if (clothedJobFiles.length === 0) {
			log(
				"ScrapeJobs",
				`No clothed_jobs_*.json files found matching pattern: ${inputFilePattern}`,
				"warn",
			);
			return [];
		}

		log(
			"ScrapeJobs",
			`Found ${clothedJobFiles.length} clothed job files`,
			"info",
			{
				files: clothedJobFiles,
				pattern: inputFilePattern,
			},
		);

		return clothedJobFiles;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		log("ScrapeJobs", `Error reading directory: ${errorMessage}`, "error", {
			error: errorMessage,
		});
		return [];
	}
}

/**
 * Core batch job scraping logic with retry mechanisms and jitter delays
 * @param urls Array of LinkedIn job URLs to scrape
 * @param options { headless: boolean, outputFile: string, sleepMin: number, sleepMax: number, maxRetries: number }
 * @param stats Statistics collector instance
 * @returns Promise of void
 */
export async function scrapeJobsBatch(
	jobs: ScrapeJobTarget[],
	options: {
		headless: boolean;
		outputFile: string;
		sleepMin?: number;
		sleepMax?: number;
		maxRetries?: number;
		jobDB?: JobDB;
	},
	stats: ReturnType<typeof createStatisticsCollector>,
): Promise<void> {
	const {
		headless,
		outputFile,
		sleepMin = 2.5,
		sleepMax = 4.5,
		maxRetries = 3,
		jobDB,
	} = options;
	if (jobs.length === 0) {
		log("ScrapeJobs", "No new job descriptions need scraping.", "info");
		return;
	}
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

	const page = await browser.newPage();

	try {
		log(
			"ScrapeJobs",
			`Starting batch scraping of ${jobs.length} job URLs`,
			"log",
			{
				urlCount: jobs.length,
				outputFile,
				sleepMin,
				sleepMax,
				maxRetries,
			},
		);

		for (let i = 0; i < jobs.length; i++) {
			const job = jobs[i];
			const url = job.url;
			const jobId = job.id || extractJobId(url) || `unknown_${i}`;

			log("ScrapeJobs", `Scraping job ${i + 1}/${jobs.length}: ${url}`, "log", {
				currentIndex: i + 1,
				totalUrls: jobs.length,
				jobId,
				url,
			});

			let jobResult: unknown = null;
			let hasError = false;
			let apiCallSucceeded = false;

			try {
				stats.incrementCounter("api.totalCalls", 1);
				stats.incrementCounter("network.connections", 1);
				// Use retry mechanism with exponential backoff for job scraping
				jobResult = await retryWithBackoff(
					async () => {
						const attemptStartedAt = performance.now();
						try {
							return await new Promise((resolve, reject) => {
								const subscription = getJobDescription(page, { url }).subscribe(
									{
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
									},
								);
							});
						} finally {
							stats.recordHistogram(
								"api.responseTime",
								performance.now() - attemptStartedAt,
							);
						}
					},
					{
						maxRetries,
						baseDelay: 1000,
						maxDelay: 10000,
						backoffFactor: 2,
						jitter: true,
					},
					(attempt, error, delay) => {
						stats.incrementCounter("scrape.retries", 1);
						stats.incrementCounter("api.retries", 1);
						stats.incrementCounter("api.failedCalls", 1);
						stats.incrementCounter("network.retries", 1);
						stats.incrementCounter("api.totalCalls", 1);
						stats.incrementCounter("network.connections", 1);
						if (error.message.toLowerCase().includes("timeout")) {
							stats.incrementCounter("network.timeouts", 1);
						}
						log(
							"ScrapeJobs",
							`Retry attempt ${attempt} for job ${jobId}: ${error.message}`,
							"warn",
							{
								jobId,
								url,
								attempt,
								delay,
								error: error.message,
							},
						);
					},
				);
				apiCallSucceeded = true;
				stats.incrementCounter("api.successfulCalls", 1);

				if (
					jobResult &&
					typeof jobResult === "object" &&
					"descriptionText" in jobResult
				) {
					// Write the job to the output file immediately
					await fs.promises.appendFile(
						outputFile,
						`${JSON.stringify(jobResult)}\n`,
						"utf-8",
					);
					stats.incrementCounter("files.written", 1);
					if (jobDB) {
						const result = jobResult as Record<string, unknown>;
						await jobDB.markJobDescriptionScraped(
							{
								id: jobId,
								title:
									typeof result.title === "string" ? result.title : job.title,
								company:
									typeof result.company === "string"
										? result.company
										: job.company,
								url,
							},
							jobId,
						);
						stats.incrementCounter("jobDB.descriptionsRecorded", 1);
					}
					stats.incrementCounter("jobs.successful", 1);
					stats.recordSuccess("job.scrape", { jobId, url });
					log(
						"ScrapeJobs",
						`Job ${jobId} scraped and written to ${outputFile}`,
						"log",
						{
							jobId,
							url,
							outputFile,
						},
					);
				} else {
					stats.incrementCounter("jobs.failed", 1);
					hasError = true;
					stats.recordError(new Error("No description text extracted"), {
						jobId,
						url,
					});
					log(
						"ScrapeJobs",
						`Failed to scrape job ${jobId}: No description text extracted`,
						"warn",
						{
							jobId,
							url,
						},
					);
					jobResult = { url, error: "No description text extracted" };
				}
			} catch (err) {
				stats.incrementCounter("jobs.failed", 1);
				if (!apiCallSucceeded) {
					stats.incrementCounter("api.failedCalls", 1);
				}
				hasError = true;
				const errorMessage = err instanceof Error ? err.message : String(err);
				stats.recordError(
					err instanceof Error ? err : new Error(errorMessage),
					{ jobId, url },
				);
				log(
					"ScrapeJobs",
					`Error scraping URL ${url}: ${errorMessage}`,
					"error",
					{
						jobId,
						url,
						error: errorMessage,
					},
				);
				jobResult = { url, error: errorMessage };
			}

			// Write failed jobs to the output file
			if (hasError && jobResult) {
				await fs.promises.appendFile(
					outputFile,
					`${JSON.stringify(jobResult)}\n`,
					"utf-8",
				);
				stats.incrementCounter("files.written", 1);
			}

			// Sleep between requests with jitter
			if (i < jobs.length - 1) {
				await sleepWithJitter(sleepMin, sleepMax);
				log(
					"ScrapeJobs",
					`Slept between ${sleepMin} and ${sleepMax} seconds before next request...`,
					"log",
					{
						sleepMin,
						sleepMax,
					},
				);
			}
		}

		await browser.close();
		log(
			"ScrapeJobs",
			`Batch scraping completed. Processed ${jobs.length} jobs`,
			"log",
			{
				totalUrls: jobs.length,
				outputFile,
			},
		);
	} catch (error: unknown) {
		await browser.close();
		throw error;
	}
}

export const addScrapeJobsCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "scrape-jobs",
		describe:
			"Scrape LinkedIn job URLs from clothed_jobs_*.json files into a single output file (Indeed descriptions are acquired directly)",
		builder: (yargs: Argv<GlobalArgs>) => {
			return (yargs as unknown as Argv<GlobalArgs & ScrapeJobsArgs>)
				.option("headless", {
					alias: "hdl",
					type: "boolean",
					description:
						"Whether or not execute puppeteer in headless mode. Defaults to true",
					default: true,
				})
				.option("input-file", {
					alias: "i",
					type: "string",
					description:
						"Input file pattern for clothed_jobs_*.json files. Mixed source files are supported; non-LinkedIn URLs are skipped.",
					default: "./data/clothed_jobs_*.json",
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					description:
						"Output path for newline-delimited JSON job records (default: ./data/scraped_jobs_<dynamically_generated_timestamp>.json)",
					default: "",
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
				.option("max-retries", {
					alias: "r",
					type: "number",
					description:
						"Maximum number of retry attempts for failed requests. Defaults to 3.",
					default: 3,
				})
				.option("use-jobdb", {
					type: "boolean",
					description:
						"Use the 30-day jobDB checkpoint to suppress duplicate JD downloads (default: true)",
					default: true,
				});
		},
		handler: async (argv: Arguments<GlobalArgs & ScrapeJobsArgs>) => {
			if (!argv.disableFileLogging) {
				const logDir =
					typeof argv.logDir === "string" ? argv.logDir : defaultLogDirectory;
				const logFile =
					typeof argv.logFile === "string" ? argv.logFile : "astroex.log";
				initializeFileLogging(
					logDir,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_${logFile}`,
					"scrape-jobs",
				);
			}
			log("ScrapeJobs", "Command started", "info", { params: argv });

			// Initialize statistics collection
			const stats = createStatisticsCollector("scrape-jobs");
			stats.startCollection();

			const startTime = performance.now();
			log("ScrapeJobs", "Preparing batch description scrape", "debug");

			// Defensive extraction and defaults
			const headless =
				typeof argv.headless === "boolean" ? argv.headless : true;
			const inputFile = argv.inputFile;
			const outputFile =
				argv.outputFile ||
				path.join(
					dataDirectory,
					`scraped_jobs_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
			const sleepMin =
				typeof argv.sleepMin === "number" && !Number.isNaN(argv.sleepMin)
					? argv.sleepMin
					: 2.5;
			const sleepMax =
				typeof argv.sleepMax === "number" && !Number.isNaN(argv.sleepMax)
					? argv.sleepMax
					: 4.5;
			const maxRetries =
				typeof argv.maxRetries === "number" && !Number.isNaN(argv.maxRetries)
					? argv.maxRetries
					: 3;
			const useJobDB = argv["use-jobdb"] ?? true;
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
					"ScrapeJobs",
					`jobDB ready with ${jobDB.size()} active entries (${expiredEntriesRemoved} expired entries removed)`,
					"info",
					{
						enabled: useJobDB,
						expirationMs: JOB_DB_RETENTION_MS,
						expiredEntriesRemoved,
					},
				);

				// Find all clothed_jobs_*.json files
				const fileDiscoveryTimer = stats.startTimer("file-discovery");
				const clothedJobFiles = await findClothedJobFiles(inputFile as string);
				stats.endTimer(fileDiscoveryTimer);

				if (clothedJobFiles.length === 0) {
					throw new Error(
						"No clothed_jobs_*.json files found matching the specified pattern. Please run jobCloth first or provide a valid input file pattern.",
					);
				}

				// Extract all job identities from found files
				const allJobs: ScrapeJobTarget[] = [];
				const urlExtractionTimer = stats.startTimer("url-extraction");
				log(
					"ScrapeJobs",
					`Extracting URLs from ${clothedJobFiles.length} files...`,
					"log",
					{
						fileCount: clothedJobFiles.length,
					},
				);

				for (const filePath of clothedJobFiles) {
					const fileReadTimer = stats.startTimer(
						`file-read-${path.basename(filePath)}`,
					);
					try {
						const fileContent = await fs.promises.readFile(filePath, "utf-8");
						stats.incrementCounter("files.opened", 1);
						stats.incrementCounter("files.read", 1);
						const jobs = JSON.parse(fileContent);

						if (Array.isArray(jobs)) {
							stats.incrementCounter("data.filesProcessed", 1);
							const fileJobs = jobs
								.filter(
									(job: unknown) =>
										(job as Record<string, unknown>).url &&
										typeof (job as Record<string, unknown>).url === "string",
								)
								.map((job: unknown): ScrapeJobTarget => {
									const record = job as Record<string, unknown>;
									const url = (record.url as string).replace(
										/^(https?:\/\/(?:www\.)?linkedin\.com){1,2}(https?:\/\/)/i,
										"$2",
									);
									return {
										id:
											typeof record.id === "string"
												? record.id
												: extractJobId(url),
										title: typeof record.title === "string" ? record.title : "",
										company:
											typeof record.company === "string" ? record.company : "",
										location:
											typeof record.location === "string"
												? record.location
												: undefined,
										url,
									};
								});

							allJobs.push(...fileJobs);
							stats.incrementCounter("jobs.loaded", fileJobs.length);
							log(
								"ScrapeJobs",
								`Extracted ${fileJobs.length} jobs from ${path.basename(filePath)}`,
								"log",
								{
									fileName: path.basename(filePath),
									jobCount: fileJobs.length,
								},
							);
						} else {
							stats.recordWarning(
								`Skipping file: ${path.basename(filePath)} does not contain a JSON array`,
								{ fileName: path.basename(filePath) },
							);
							log(
								"ScrapeJobs",
								`Skipping file: ${path.basename(filePath)} does not contain a JSON array`,
								"warn",
								{
									fileName: path.basename(filePath),
								},
							);
						}
					} catch (error: unknown) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						stats.recordError(
							error instanceof Error ? error : new Error(errorMessage),
							{
								fileName: path.basename(filePath),
								error: errorMessage,
							},
						);
						log(
							"ScrapeJobs",
							`Error reading file ${filePath}: ${errorMessage}`,
							"error",
							{
								fileName: path.basename(filePath),
								error: errorMessage,
							},
						);
					} finally {
						stats.endTimer(fileReadTimer);
					}
				}
				stats.endTimer(urlExtractionTimer);

				if (allJobs.length === 0) {
					throw new Error(
						"No valid job URLs found in any clothed_jobs_*.json files. Please ensure the files contain job objects with 'url' properties.",
					);
				}

				const linkedInJobs = filterLinkedInScrapeTargets(allJobs);
				const nonLinkedInJobsSkipped = allJobs.length - linkedInJobs.length;
				if (nonLinkedInJobsSkipped > 0) {
					stats.incrementCounter("data.recordsFiltered", nonLinkedInJobsSkipped);
					log(
						"ScrapeJobs",
						`Skipped ${nonLinkedInJobsSkipped} non-LinkedIn job(s); Indeed descriptions are retained from acquisition.`,
						"info",
						{ nonLinkedInJobsSkipped },
					);
				}
				if (linkedInJobs.length === 0) {
					throw new Error(
						"No LinkedIn job URLs found in the supplied clothed files. Indeed descriptions are already captured by acquire-jobs.",
					);
				}

				const jobsToScrape = filterJobsNeedingDescriptions(
					linkedInJobs,
					new Set<string>(),
					jobDB,
				);
				const duplicatesRemoved = linkedInJobs.length - jobsToScrape.length;
				stats.incrementCounter("data.recordsProcessed", allJobs.length);
				stats.incrementCounter("data.recordsFiltered", duplicatesRemoved);
				stats.incrementCounter("data.duplicatesRemoved", duplicatesRemoved);

				log(
					"ScrapeJobs",
					`Found ${jobsToScrape.length} new LinkedIn JDs to scrape from ${linkedInJobs.length} LinkedIn input records`,
					"log",
					{
						inputJobs: allJobs.length,
						linkedInJobs: linkedInJobs.length,
						nonLinkedInJobsSkipped,
						jobsToScrape: jobsToScrape.length,
						duplicatesRemoved,
					},
				);

				// Create empty output file at the beginning
				const fileInitializationTimer = stats.startTimer("file-initialization");
				try {
					await fs.promises.writeFile(outputFile, "", "utf-8");
				} finally {
					stats.endTimer(fileInitializationTimer);
				}
				stats.incrementCounter("files.written");
				log("ScrapeJobs", `Initialized output file: ${outputFile}`, "log", {
					outputFile,
				});

				// Scrape all URLs (each job will be written immediately)
				await scrapeJobsBatch(
					jobsToScrape,
					{ headless, outputFile, sleepMin, sleepMax, maxRetries, jobDB },
					stats,
				);
				stats.recordSuccess("scrape-jobs.complete", {
					inputJobs: allJobs.length,
					linkedInJobs: linkedInJobs.length,
					nonLinkedInJobsSkipped,
					jobsScraped: jobsToScrape.length,
					duplicatesRemoved,
				});

				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				log(
					"ScrapeJobs",
					`Scrape-jobs command completed in ${duration}.`,
					"log",
					{
						duration,
						totalJobs: jobsToScrape.length,
						duplicatesRemoved,
						outputFile,
						statistics: summary,
					},
				);

				// Export statistics to file
				const statsFile = path.join(
					dataDirectory,
					`scrape-jobs-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fs.promises.writeFile(statsFile, stats.export("json"), "utf-8");
				log("ScrapeJobs", `Statistics exported to: ${statsFile}`, "info");
			} catch (error: unknown) {
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Record error in statistics
				stats.recordError(
					error instanceof Error ? error : new Error(String(error)),
				);

				log(
					"ScrapeJobs",
					`Scrape-jobs command failed after ${duration}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
					{
						duration,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			} finally {
				if (jobDB) {
					await jobDB.close();
				}
				// Always end statistics collection
				const summary = stats.endCollection();
				log("ScrapeJobs", "Final statistics:", "info", { summary });

				await closeFileLogging();
				setTimeout(() => process.exit(0), 1000);
			}
		},
	});
};

interface ScrapeJobsArgs {
	headless: boolean;
	inputFile: string;
	outputFile: string;
	sleepMin: number;
	sleepMax: number;
	maxRetries: number;
	"use-jobdb": boolean;
}
