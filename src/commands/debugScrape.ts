import * as fs from "node:fs"; // Use sync fs for marker file
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

export const addDebugScrapeCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> => {
	console.log("DebugScrape: addDebugScrapeCommand called."); // Keep this console.log for initial command detection
	return yargs.command({
		command: "debug-scrape",
		describe:
			"Debug mode: scrape a single job description from a URL for verification and tuning",
		builder: (yargs: Argv<GlobalArgs>) => {
			return yargs.option("url", {
				type: "string",
				description: "URL of the LinkedIn job post to scrape",
				demandOption: true,
			});
		},
		handler: async (argv: Arguments<GlobalArgs & { url: string }>) => {
			// Initialize statistics collection
			const stats = createStatisticsCollector("debug-scrape");
			stats.startCollection();

			const startTime = performance.now();

			// Write a marker file immediately to confirm handler execution
			const markerFilePath = path.join(
				process.cwd(),
				"debug_scrape_started.txt",
			);
			try {
				fs.writeFileSync(
					markerFilePath,
					`Debug scrape started at ${new Date().toISOString()}`,
					"utf-8",
				);
				stats.incrementCounter("files.written", 1);
				stats.incrementCounter("files.opened", 1);
				log("DebugScrape", "Marker file created.", "info", {
					markerFilePath: markerFilePath,
				});
			} catch (markerError: unknown) {
				const errorMessage =
					markerError instanceof Error
						? markerError.message
						: String(markerError);
				stats.recordError(new Error(errorMessage), { markerFilePath });
				log(
					"DebugScrape",
					`Error writing marker file: ${errorMessage}`,
					"error",
					{ error: errorMessage, markerFilePath: markerFilePath },
				);
			}

			log("DebugScrape", `Handler started for URL: ${argv.url}`, "info", {
				url: argv.url,
			});
			stats.incrementCounter("jobs.processed", 1);

			// Normalize global logging options: in our codebase, yargs defines dashed options.
			// Access via bracket-notation to avoid undefined camelCase properties.
			const logDir = (argv as Record<string, unknown>)["log-dir"] ?? "./logs";
			const logFileName = `${formatDate(new Date(), "yyyyMMdd_HHmmss")}_debug_scrape.log`;

			try {
				if (!(argv as Record<string, unknown>)["disable-file-logging"]) {
					log(
						"DebugScrape",
						`Initializing file logging at ${String(logDir)}/${logFileName}`,
						"info",
						{ logDir: String(logDir), logFileName },
					);
					initializeFileLogging(
						String(logDir),
						String(logFileName),
						"DebugScrape",
					); // initialize expects strings
				} else {
					log("DebugScrape", "File logging is disabled.", "info");
				}
			} catch (initLogError: unknown) {
				const errorMessage =
					initLogError instanceof Error
						? initLogError.message
						: String(initLogError);
				stats.recordError(new Error(errorMessage));
				log(
					"DebugScrape",
					`Error initializing file logging: ${errorMessage}`,
					"error",
					{
						error:
							initLogError instanceof Error
								? initLogError.message
								: String(initLogError),
					},
				);
			}

			let browser: puppeteer.Browser | null = null;
			try {
				const browserLaunchTimer = stats.startTimer("browser.launch");
				browser = await puppeteer.launch({ headless: true });
				stats.endTimer(browserLaunchTimer);
				stats.incrementCounter("browser.instances", 1);
				log("DebugScrape", "Puppeteer browser launched.", "info");

				const pageCreationTimer = stats.startTimer("browser.page");
				const page = await browser.newPage();
				stats.endTimer(pageCreationTimer);

				log(
					"DebugScrape",
					"Starting job description observable subscription.",
					"info",
				);

				const scrapingTimer = stats.startTimer("scraping");
				const jobData$ = getJobDescription(page, { url: argv.url });
				const jobData = await new Promise((resolve, reject) => {
					const subscription = jobData$.subscribe({
						next: (data) => {
							log("DebugScrape", "Received job data from observable.", "info");
							stats.incrementCounter("api.successfulCalls", 1);
							stats.incrementCounter("api.totalCalls", 1);
							resolve(data);
							subscription.unsubscribe();
						},
						error: (err) => {
							const errorMessage =
								err instanceof Error ? err.message : String(err);
							stats.incrementCounter("api.failedCalls", 1);
							stats.incrementCounter("api.totalCalls", 1);
							stats.recordError(new Error(errorMessage), { url: argv.url });
							log(
								"DebugScrape",
								`Error in job description observable: ${errorMessage}`,
								"error",
								{ error: errorMessage },
							);
							reject(err);
							subscription.unsubscribe();
						},
					});
				});
				stats.endTimer(scrapingTimer);

				log("DebugScrape", "Scraped job data:", "info", { jobData: jobData });
				stats.incrementCounter("data.jobsExtracted", 1);
				stats.incrementCounter("data.recordsProcessed", 1);

				// Write scraped data to a temp file for inspection
				const tempFilePath = path.join(
					process.cwd(),
					"debug_scrape_output.json",
				);
				const fileWriteTimer = stats.startTimer("file.write");
				await fs.promises.writeFile(
					tempFilePath,
					JSON.stringify(jobData, null, 2),
					"utf-8",
				);
				stats.endTimer(fileWriteTimer);
				stats.incrementCounter("files.written", 1);
				stats.incrementCounter("files.opened", 1);
				log("DebugScrape", `Scraped data written to ${tempFilePath}`, "info", {
					filePath: tempFilePath,
				});

				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				log(
					"DebugScrape",
					`Debug-scrape command completed in ${duration}.`,
					"log",
					{
						duration,
						url: argv.url,
						statistics: summary,
					},
				);

				// Export statistics to file
				const statsFile = path.join(
					process.cwd(),
					`debug-scrape-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fs.promises.writeFile(statsFile, stats.export("json"), "utf-8");
				log("DebugScrape", `Statistics exported to: ${statsFile}`, "info");

				await closeFileLogging();
				if (browser) {
					const browserCloseTimer = stats.startTimer("browser.close");
					await browser.close();
					stats.endTimer(browserCloseTimer);
					stats.incrementCounter("browser.instances.closed", 1);
					log("DebugScrape", "Puppeteer browser closed.", "info");
				}
				// Delay exit to allow logs to flush
				setTimeout(() => process.exit(0), 2000); // Increased delay
			} catch (error: unknown) {
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Record error in statistics
				stats.recordError(
					error instanceof Error ? error : new Error(String(error)),
				);

				log(
					"DebugScrape",
					`Debug-scrape command failed after ${duration}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
					{
						duration,
						error: error instanceof Error ? error.message : String(error),
					},
				);
				if (browser) {
					const browserCloseTimer = stats.startTimer("browser.close");
					await browser.close();
					stats.endTimer(browserCloseTimer);
					stats.incrementCounter("browser.instances.closed", 1);
					log("DebugScrape", "Puppeteer browser closed after error.", "info");
				}
				await closeFileLogging();
				setTimeout(() => process.exit(1), 2000); // Increased delay
			} finally {
				// Always end statistics collection
				const summary = stats.endCollection();
				log("DebugScrape", "Final statistics:", "info", { summary });
			}
		},
	});
};
