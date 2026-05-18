import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import type { Arguments, Argv } from "yargs";
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

const jobsDataFolder: string = `data`;
const rootDirectory = path.resolve(__dirname, "..", "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs");

fs.mkdirSync(dataDirectory, { recursive: true });

/**
 * Extract the numeric job ID from a LinkedIn job URL
 * @param url LinkedIn job URL
 * @returns Numeric job ID or undefined if not found
 */
function extractJobId(url: string): string | undefined {
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
	urls: string[],
	options: {
		headless: boolean;
		outputFile: string;
		sleepMin?: number;
		sleepMax?: number;
		maxRetries?: number;
	},
	stats: any,
): Promise<void> {
	const {
		headless,
		outputFile,
		sleepMin = 2.5,
		sleepMax = 4.5,
		maxRetries = 3,
	} = options;
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
			`Starting batch scraping of ${urls.length} job URLs`,
			"log",
			{
				urlCount: urls.length,
				outputFile,
				sleepMin,
				sleepMax,
				maxRetries,
			},
		);

		for (let i = 0; i < urls.length; i++) {
			const url = urls[i];
			const jobId = extractJobId(url) || `unknown_${i}`;

			log("ScrapeJobs", `Scraping job ${i + 1}/${urls.length}: ${url}`, "log", {
				currentIndex: i + 1,
				totalUrls: urls.length,
				jobId,
				url,
			});

			let jobResult: unknown = null;
			let hasError = false;

			try {
				// Use retry mechanism with exponential backoff for job scraping
				jobResult = await retryWithBackoff(
					async () => {
						return await new Promise((resolve, reject) => {
							const subscription = getJobDescription(page, { url }).subscribe({
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
						maxRetries,
						baseDelay: 1000,
						maxDelay: 10000,
						backoffFactor: 2,
						jitter: true,
					},
					(attempt, error, delay) => {
						stats.incrementCounter("scrape.retries", 1);
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

				if (
					jobResult &&
					typeof jobResult === "object" &&
					"descriptionText" in jobResult
				) {
					// Write the job to the output file immediately
					await fs.promises.appendFile(
						outputFile,
						`${JSON.stringify(jobResult, null, 2)}\n`,
						"utf-8",
					);
					stats.incrementCounter("jobs.successful", 1);
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
				hasError = true;
				const errorMessage = err instanceof Error ? err.message : String(err);
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
					`${JSON.stringify(jobResult, null, 2)}\n`,
					"utf-8",
				);
			}

			// Sleep between requests with jitter
			if (i < urls.length - 1) {
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
			`Batch scraping completed. Processed ${urls.length} jobs`,
			"log",
			{
				totalUrls: urls.length,
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
			"Scrape all job URLs from clothed_jobs_*.json files into a single output file",
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
						"Input file pattern for clothed_jobs_*.json files (default: ./data/clothed_jobs_*.json)",
					default: "./data/clothed_jobs_*.json",
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					description:
						"Output file path for scraped jobs data (default: ./data/scraped_jobs_<dynamically_generated_timestamp>.json)",
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
				});
		},
		handler: async (argv: Arguments<GlobalArgs & ScrapeJobsArgs>) => {
			log("ScrapeJobs", `Command parameters: ${JSON.stringify(argv)}`, "info", {
				params: argv,
			});
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

			// Initialize statistics collection
			const stats = createStatisticsCollector("scrape-jobs");
			stats.startCollection();

			const startTime = performance.now();
			log("ScrapeJobs", "Starting scrape-jobs command... ");

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

			try {
				// Find all clothed_jobs_*.json files
				stats.startTimer("file-discovery");
				const clothedJobFiles = await findClothedJobFiles(inputFile as string);
				stats.endTimer("file-discovery");

				if (clothedJobFiles.length === 0) {
					stats.incrementCounter("operations.failed");
					stats.recordError(
						new Error(
							"No clothed_jobs_*.json files found matching the specified pattern. Please run jobCloth first or provide a valid input file pattern.",
						),
					);
					throw new Error(
						"No clothed_jobs_*.json files found matching the specified pattern. Please run jobCloth first or provide a valid input file pattern.",
					);
				}

				stats.incrementCounter("files.read", clothedJobFiles.length);
				stats.incrementCounter("data.filesProcessed", clothedJobFiles.length);

				// Extract all URLs from found files
				const allUrls: string[] = [];
				stats.startTimer("url-extraction");
				log(
					"ScrapeJobs",
					`Extracting URLs from ${clothedJobFiles.length} files...`,
					"log",
					{
						fileCount: clothedJobFiles.length,
					},
				);

				for (const filePath of clothedJobFiles) {
					try {
						stats.startTimer(`file-read-${path.basename(filePath)}`);
						const fileContent = await fs.promises.readFile(filePath, "utf-8");
						const jobs = JSON.parse(fileContent);
						stats.endTimer(`file-read-${path.basename(filePath)}`);

						if (Array.isArray(jobs)) {
							const fileUrls = jobs
								.filter(
									(job: unknown) =>
										(job as Record<string, unknown>).url &&
										typeof (job as Record<string, unknown>).url === "string",
								)
								.map((job: unknown) =>
									(job as Record<string, string>).url.replace(
										/^(https?:\/\/(?:www\.)?linkedin\.com){1,2}(https?:\/\/)/i,
										"$2",
									),
								);

							allUrls.push(...fileUrls);
							stats.incrementCounter("data.recordsFiltered", fileUrls.length);
							log(
								"ScrapeJobs",
								`Extracted ${fileUrls.length} URLs from ${path.basename(filePath)}`,
								"log",
								{
									fileName: path.basename(filePath),
									urlCount: fileUrls.length,
								},
							);
						} else {
							stats.incrementCounter("operations.failed");
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
						stats.incrementCounter("operations.failed");
						stats.incrementCounter("files.read");
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
					}
				}
				stats.endTimer("url-extraction");

				if (allUrls.length === 0) {
					stats.incrementCounter("operations.failed");
					stats.recordError(
						new Error(
							"No valid job URLs found in any clothed_jobs_*.json files. Please ensure the files contain job objects with 'url' properties.",
						),
					);
					throw new Error(
						"No valid job URLs found in any clothed_jobs_*.json files. Please ensure the files contain job objects with 'url' properties.",
					);
				}

				log(
					"ScrapeJobs",
					`Found ${allUrls.length} total URLs to scrape`,
					"log",
					{
						totalUrls: allUrls.length,
					},
				);

				// Create empty output file at the beginning
				stats.startTimer("file-initialization");
				await fs.promises.writeFile(outputFile, "", "utf-8");
				stats.endTimer("file-initialization");
				stats.incrementCounter("files.written");
				stats.incrementCounter("files.opened");
				log("ScrapeJobs", `Initialized output file: ${outputFile}`, "log", {
					outputFile,
				});

				// Scrape all URLs (each job will be written immediately)
				await scrapeJobsBatch(
					allUrls,
					{ headless, outputFile, sleepMin, sleepMax, maxRetries },
					stats,
				);

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
						totalUrls: allUrls.length,
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
}
