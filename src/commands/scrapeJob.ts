/**
 * AstroEX Job Scraper Command
 * Version 5.0.0
 *
 * This module provides functionality to scrape individual job descriptions from LinkedIn.
 * It handles authentication walls, rate limiting, and data extraction with fallback mechanisms.
 *
 * Version 2.7.0 Improvements:
 * - Fixed unnecessary escape character in regex pattern (line 30)
 * - Improved error handling and recovery mechanisms
 * - Enhanced JSON-LD data extraction with better fallback logic
 * - Optimized performance with better selector handling
 * - Improved logging and debugging capabilities
 *
 * @author tjenkel
 * @contributors llpujol
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import type { Arguments, Argv } from "yargs";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobDB, type JobDBConfig, type JobIdentity } from "../jobDB";
import { getJobDescription } from "../linkedin";
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

/** Build the checkpoint identity only after a job page supplied its metadata. */
export function getScrapedJobIdentity(
	jobResult: unknown,
	fallbackUrl: string,
): JobIdentity | undefined {
	if (!jobResult || typeof jobResult !== "object") return undefined;

	const job = jobResult as Record<string, unknown>;
	const title = typeof job.title === "string" ? job.title.trim() : "";
	const company = typeof job.company === "string" ? job.company.trim() : "";
	if (!title || !company) return undefined;

	const url = typeof job.url === "string" && job.url ? job.url : fallbackUrl;
	return { id: extractJobId(url), title, company, url };
}

/**
 * Core individual job scraping logic, extracted for workflow integration.
 * Scrapes a single job description from a LinkedIn job URL.
 * @param url LinkedIn job URL
 * @param options { headless: boolean, sleep: number, outFile: string }
 * @returns Promise of job result
 */
export async function scrapeJobUrl(
	url: string,
	options: {
		headless: boolean;
		sleep: number;
		outFile: string;
		jobDB?: Pick<JobDB, "markJobDescriptionScraped">;
	},
	stats: StatisticsCollector,
): Promise<unknown> {
	const { headless, sleep, outFile, jobDB } = options;
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

	try {
		log("ScrapeJob", `Scraping job URL: ${url}`, "log", { url });

		// Sleep before processing if specified
		if (sleep > 0) {
			log(
				"ScrapeJob",
				`Sleeping for ${sleep} seconds before processing...`,
				"log",
				{
					sleepSeconds: sleep,
				},
			);
			await new Promise((res) => setTimeout(res, sleep * 1000));
		}

		let jobResult: unknown = null;
		const scrapingTimer = stats.startTimer("scraping");
		const requestStartedAt = performance.now();
		stats.incrementCounter("api.totalCalls", 1);
		stats.incrementCounter("network.connections", 1);
		try {
			jobResult = await new Promise((resolve, reject) => {
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
			stats.endTimer(scrapingTimer);
			stats.recordHistogram(
				"api.responseTime",
				performance.now() - requestStartedAt,
			);
			stats.incrementCounter("api.successfulCalls", 1);

			if (
				jobResult &&
				typeof jobResult === "object" &&
				"descriptionText" in jobResult
			) {
				const fileWriteTimer = stats.startTimer("file.write");
				await fs.promises.writeFile(
					outFile,
					JSON.stringify(jobResult, null, 2),
					"utf-8",
				);
				stats.endTimer(fileWriteTimer);
				stats.incrementCounter("files.written", 1);
				stats.incrementCounter("jobs.successful", 1);
				const jobIdentity = getScrapedJobIdentity(jobResult, url);
				if (jobDB && jobIdentity) {
					await jobDB.markJobDescriptionScraped(jobIdentity, jobIdentity.id);
					stats.incrementCounter("jobDB.descriptionsRecorded", 1);
				}
				stats.recordSuccess("job.scrape", { url, outputFile: outFile });
				log("ScrapeJob", `Job data written to ${outFile}`);
			} else {
				stats.incrementCounter("jobs.failed", 1);
				stats.recordError(new Error("No description text extracted"));
			}
		} catch (err) {
			stats.endTimer(scrapingTimer);
			stats.recordHistogram(
				"api.responseTime",
				performance.now() - requestStartedAt,
			);
			stats.incrementCounter("api.failedCalls", 1);
			stats.incrementCounter("jobs.failed", 1);
			const errorMessage = err instanceof Error ? err.message : String(err);
			if (/timeout|timed out/i.test(errorMessage)) {
				stats.incrementCounter("network.timeouts", 1);
			}
			stats.recordError(new Error(errorMessage), { url });
			log("ScrapeJob", `Error scraping URL ${url}: ${errorMessage}`, "error", {
				url,
				error: errorMessage,
			});
			jobResult = {
				url,
				error: errorMessage,
			};
		}

		const browserCloseTimer = stats.startTimer("browser.close");
		await browser.close();
		stats.endTimer(browserCloseTimer);
		stats.incrementCounter("browser.instances.closed", 1);
		return jobResult;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		stats.recordError(new Error(errorMessage));
		await browser.close();
		throw error;
	}
}

export const addScrapeJobCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "scrape-job",
		describe: "Scrape an individual job listing from LinkedIn",
		builder: (yargs: Argv<GlobalArgs>) => {
			return (yargs as unknown as Argv<GlobalArgs & ScrapeJobArgs>)
				.option("headless", {
					alias: "hdl",
					type: "boolean",
					description:
						"Whether or not execute puppeteer in headless mode. Defaults to true",
					default: true,
				})
				.option("url", {
					alias: "u",
					type: "string",
					description: "LinkedIn job URL to scrape",
					demandOption: true,
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					description: "Output file path for the scraped job data",
					default: "",
				})
				.option("sleep", {
					alias: "s",
					type: "number",
					description: "Delay in seconds before processing. Defaults to 2.",
					default: 2,
				})
				.option("use-jobdb", {
					type: "boolean",
					description:
						"Use the 30-day jobDB checkpoint to skip an already saved job description (default: true)",
					default: true,
				});
		},
		handler: async (argv: Arguments<GlobalArgs & ScrapeJobArgs>) => {
			if (!argv.disableFileLogging) {
				const logDir =
					typeof argv.logDir === "string" ? argv.logDir : defaultLogDirectory;
				const logFile =
					typeof argv.logFile === "string" ? argv.logFile : "astroex.log";
				initializeFileLogging(
					logDir,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_ScrapeJob_${logFile}`,
					"ScrapeJob",
				);
			}
			log("ScrapeJob", "Command started", "info", { params: argv });

			// Initialize statistics collection
			const stats = createStatisticsCollector("scrape-job");
			stats.startCollection();

			const startTime = performance.now();
			log("ScrapeJob", "Preparing job-page scrape", "debug");

			// Defensive extraction and defaults
			const headless =
				typeof argv.headless === "boolean" ? argv.headless : true;
			const sleep =
				typeof argv.sleep === "number" && !Number.isNaN(argv.sleep)
					? argv.sleep
					: 0;
			const url = argv.url;
			const jobId = extractJobId(url) || "unknown";
			const outFile =
				argv.outputFile ||
				path.join(
					dataDirectory,
					`scraped_job_${jobId}_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
			const useJobDB = argv["use-jobdb"] ?? true;
			let jobDB: JobDB | undefined;

			try {
				stats.incrementCounter("jobs.processed", 1);
				stats.incrementCounter("data.recordsProcessed", 1);

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

				if (jobDB.isJobDescriptionUrlScraped(url)) {
					stats.incrementCounter("jobs.skipped", 1);
					stats.incrementCounter("data.recordsFiltered", 1);
					log(
						"ScrapeJob",
						"Skipping job with an active jobDB description checkpoint",
						"info",
						{ url },
					);
				} else {
					await scrapeJobUrl(url, { headless, sleep, outFile, jobDB }, stats);
				}

				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				log(
					"ScrapeJob",
					`Scrape-job command completed in ${duration}.`,
					"log",
					{
						duration,
						jobId,
						outputFile: outFile,
						statistics: summary,
					},
				);

				// Export statistics to file
				const statsFile = path.join(
					dataDirectory,
					`scrape-job-stats_${jobId}_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fs.promises.writeFile(statsFile, stats.export("json"), "utf-8");
				log("ScrapeJob", `Statistics exported to: ${statsFile}`, "info");
			} catch (error: unknown) {
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Record error in statistics
				stats.recordError(
					error instanceof Error ? error : new Error(String(error)),
				);

				log(
					"ScrapeJob",
					`Scrape-job command failed after ${duration}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
					{
						duration,
						jobId,
						error: error instanceof Error ? error.message : String(error),
					},
				);
			} finally {
				if (jobDB) {
					await jobDB.close();
				}
				// Always end statistics collection
				const summary = stats.endCollection();
				log("ScrapeJob", "Final statistics:", "info", { summary });

				await closeFileLogging();
				setTimeout(() => process.exit(0), 1000);
			}
		},
	});
};

interface ScrapeJobArgs {
	headless: boolean;
	url: string;
	outputFile?: string;
	sleep: number;
	"use-jobdb": boolean;
}
