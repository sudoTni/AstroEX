import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import { JobDB, type JobDBConfig } from "../jobDB";

// Job interface for type safety
interface JobInterface {
	id: string;
	title: string;
	company: string;
	location: string;
	url: string;
	descriptionHtml: string;
	postedDate?: string;
}

/**
 * Stream processor for memory-efficient data processing
 */
export class StreamProcessor<T> {
	private items: T[] = [];
	private batchSize: number;
	private processBatch: (batch: T[]) => Promise<void>;

	constructor(batchSize: number, processBatch: (batch: T[]) => Promise<void>) {
		this.batchSize = batchSize;
		this.processBatch = processBatch;
	}

	async add(item: T): Promise<void> {
		this.items.push(item);

		if (this.items.length >= this.batchSize) {
			await this.flush();
		}
	}

	async flush(): Promise<void> {
		if (this.items.length === 0) return;

		const batch = [...this.items];
		this.items = [];

		try {
			await this.processBatch(batch);
		} catch (error) {
			log("ProcessData", `Error processing batch: ${error}`, "error");
			throw error;
		}
	}

	async finish(): Promise<void> {
		await this.flush();
	}
}

/**
 * Stream processing function for memory-efficient job data processing
 */
async function streamProcessJobData(
	inputDir: string,
	outputFile: string,
	companyFilters: string,
	titleFilters: string,
	stats: any,
	jobDB: JobDB,
): Promise<{
	filesProcessed: number;
	recordsMerged: number;
	duplicatesRemoved: number;
	filteredEntries: number;
	outputRecordCount: number;
}> {
	const startTime = performance.now();

	// Sets for deduplication (much more memory efficient than storing full objects)
	const uniqueIds = new Set<string>();
	const titleCompanyMap = new Map<string, JobInterface>();
	const filteredJobs: JobInterface[] = [];

	let filesProcessed = 0;
	let recordsMerged = 0;
	let duplicatesRemoved = 0;
	let filteredEntries = 0;
	let _totalRecords = 0;

	// Load filter lists
	const rootDirectory = path.resolve(__dirname, "..", "..");
	const companyFiltersFile = path.join(
		rootDirectory,
		"user_data",
		"company_filters.txt",
	);
	const titleFiltersFile = path.join(
		rootDirectory,
		"user_data",
		"title_filters.txt",
	);

	let defaultCompaniesToFilter: string[] = [];
	let defaultTitlesToFilter: string[] = [];

	try {
		const [companyContent, titleContent] = await Promise.all([
			fs.readFile(companyFiltersFile, "utf-8").catch(() => ""),
			fs.readFile(titleFiltersFile, "utf-8").catch(() => ""),
		]);

		defaultCompaniesToFilter = companyContent
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));

		defaultTitlesToFilter = titleContent
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
	} catch (error) {
		log("ProcessData", `Error loading filter files: ${error}`, "warn");
	}

	// Parse additional filters from arguments
	const additionalCompanies = companyFilters
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const additionalTitles = titleFilters
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	// Combine default and additional filters
	const allCompaniesToFilter = [
		...defaultCompaniesToFilter,
		...additionalCompanies,
	];
	const allTitlesToFilter = [...defaultTitlesToFilter, ...additionalTitles];

	log(
		"ProcessData",
		`Loaded ${allCompaniesToFilter.length} company filters and ${allTitlesToFilter.length} title filters`,
	);

	// Find all scraped_search_* files
	const files = await fs.readdir(inputDir);
	const scrapedSearchFiles = files.filter(
		(file) => file.startsWith("scraped_search_") && file.endsWith(".json"),
	);

	if (scrapedSearchFiles.length === 0) {
		log(
			"ProcessData",
			"No scraped_search_*.json files found. Skipping processing.",
			"warn",
		);
		return {
			filesProcessed: 0,
			recordsMerged: 0,
			duplicatesRemoved: 0,
			filteredEntries: 0,
			outputRecordCount: 0,
		};
	}

	stats.incrementCounter("files.found", scrapedSearchFiles.length);

	log("ProcessData", `Found ${scrapedSearchFiles.length} files to process`);

	// Process each file
	for (const inputFile of scrapedSearchFiles) {
		const inputPath = path.join(inputDir, inputFile);
		log("ProcessData", `Processing file: ${inputFile}`);

		try {
			const fileContent = await fs.readFile(inputPath, "utf-8");
			const jobs: JobInterface[] = JSON.parse(fileContent);

			if (!Array.isArray(jobs)) {
				log("ProcessData", `Skipping ${inputFile}: not a JSON array`, "warn");
				continue;
			}

			log("ProcessData", `Processing ${jobs.length} jobs from ${inputFile}`);
			recordsMerged += jobs.length;
			_totalRecords += jobs.length;

			// Process jobs with stream processing and deduplication
			for (const job of jobs) {
				// Check JobDB first
				if (jobDB.isJobMatched(job as any)) {
					duplicatesRemoved++;
					stats.incrementCounter("process.jobs.skipped.jobDB", 1);
					continue;
				}

				// Check for duplicates by ID
				if (uniqueIds.has(job.id)) {
					duplicatesRemoved++;
					continue;
				}

				// Check for duplicates by title/company combination
				const titleCompanyKey = `${job.title.toLowerCase()}::${job.company.toLowerCase()}`;
				if (titleCompanyMap.has(titleCompanyKey)) {
					duplicatesRemoved++;
					continue;
				}

				// Apply filters
				const companyName = (job.company || "").toLowerCase();
				const jobTitle = (job.title || "").toLowerCase();

				const isCompanyFiltered = allCompaniesToFilter.some((filterName) =>
					companyName.includes(filterName),
				);

				const isTitleFiltered = allTitlesToFilter.some((filterTerm) =>
					jobTitle.includes(filterTerm),
				);

				if (isCompanyFiltered || isTitleFiltered) {
					filteredEntries++;
					continue;
				}

				// Add to processed results
				uniqueIds.add(job.id);
				titleCompanyMap.set(titleCompanyKey, job);
				filteredJobs.push(job);

				// Periodic memory cleanup and progress logging
				if (filteredJobs.length % 1000 === 0) {
					log(
						"ProcessData",
						`Processed ${filteredJobs.length} jobs so far, ${duplicatesRemoved} duplicates removed, ${filteredEntries} filtered`,
					);

					// Small delay to allow garbage collection
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}

			filesProcessed++;
			stats.incrementCounter("files.processed", 1);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			stats.recordError(new Error(errorMessage), { inputFile });
			log(
				"ProcessData",
				`Error processing file ${inputFile}: ${errorMessage}`,
				"error",
			);
		}
	}

	// Write output file
	log("ProcessData", `Writing ${filteredJobs.length} jobs to ${outputFile}`);

	const _writeTimer = stats.startTimer("file.write");
	await fs.writeFile(
		outputFile,
		JSON.stringify(filteredJobs, null, 2),
		"utf-8",
	);
	stats.endTimer("file.write");
	stats.incrementCounter("files.written", 1);

	const endTime = performance.now();
	const duration = formatDuration(endTime - startTime);

	log("ProcessData", `Stream processing completed in ${duration}`, "info", {
		duration,
		filesProcessed,
		recordsMerged,
		duplicatesRemoved,
		filteredEntries,
		outputRecordCount: filteredJobs.length,
		uniqueJobs: uniqueIds.size,
		memoryEfficiency: "Sets used for deduplication instead of full objects",
	});

	return {
		filesProcessed,
		recordsMerged,
		duplicatesRemoved,
		filteredEntries,
		outputRecordCount: filteredJobs.length,
	};
}

export const addProcessDataCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "processData",
		describe:
			"Processes scraped job data files using stream processing for memory efficiency. By default, processes all scraped_search_*.json files in ./data directory.",
		builder: (yy: Argv<GlobalArgs>) => {
			return (yy as Argv<GlobalArgs & ProcessDataCli>)
				.option("input-dir", {
					alias: "i",
					type: "string",
					description:
						"Path to the input directory containing scraped job data files (processes all scraped_search_*.json files by default)",
					default: "./data",
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					description:
						"Path to the output JSON file to save processed job data (appends timestamp by default)",
					default: "./data/processed_jobs.json",
				})
				.option("company-filters", {
					type: "string",
					description: "Comma-separated list of company names to filter out.",
					default: "",
				})
				.option("title-filters", {
					type: "string",
					description: "Comma-separated list of job titles to filter out.",
					default: "",
				})
				.option("batch-size", {
					alias: "b",
					type: "number",
					description: "Batch size for stream processing. Defaults to 1000.",
					default: 1000,
				})
				.option("sleep-min", {
					alias: "smin",
					type: "number",
					description:
						"Minimum sleep between batches in seconds. Defaults to 0.01 (10ms).",
					default: 0.01,
				})
				.option("sleep-max", {
					alias: "smax",
					type: "number",
					description:
						"Maximum sleep between batches in seconds. Defaults to 0.1 (100ms).",
					default: 0.1,
				})
				.option("use-jobdb", {
					type: "boolean",
					description:
						"Enable jobDB functionality to prevent duplicate processing by company/title with expiration (default: true)",
					default: true,
				})
				.check((argv) => {
					if (typeof argv["input-dir"] !== "string")
						throw new Error("input-dir must be a string");
					if (typeof argv["output-file"] !== "string")
						throw new Error("output-file must be a string");
					if (typeof argv["company-filters"] !== "string")
						throw new Error("company-filters must be a string");
					if (typeof argv["title-filters"] !== "string")
						throw new Error("title-filters must be a string");
					if (typeof argv["batch-size"] !== "number")
						throw new Error("batch-size must be a number");
					if (typeof argv["sleep-min"] !== "number")
						throw new Error("sleep-min must be a number");
					if (typeof argv["sleep-max"] !== "number")
						throw new Error("sleep-max must be a number");
					return true;
				}) as Argv<GlobalArgs & ProcessDataCli>;
		},
		handler: async (argv: Arguments<GlobalArgs & ProcessDataCli>) => {
			// Initialize statistics collection
			const stats = createStatisticsCollector("processData");
			stats.startCollection();

			const startTime = performance.now();

			if (!argv.disableFileLogging) {
				const logDir = typeof argv.logDir === "string" ? argv.logDir : "./logs";
				const logFile =
					typeof argv.logFile === "string" ? argv.logFile : "astroex.log";
				initializeFileLogging(
					logDir,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_ProcessData_${logFile}`,
					"ProcessData",
				);
			}
			log("ProcessData", "Starting stream data processing command...");

			// Map dashed args to camelCase
			const inputDir = argv["input-dir"];
			let outputFile = argv["output-file"];

			// Append timestamp to default output file as promised by description
			if (outputFile === "./data/processed_jobs.json") {
				outputFile = `./data/processed_jobs_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`;
			}
			const companyFilters = argv["company-filters"];
			const titleFilters = argv["title-filters"];
			const batchSize = argv["batch-size"];
			const sleepMin = argv["sleep-min"];
			const sleepMax = argv["sleep-max"];

			log(
				"ProcessData",
				`Command parameters: ${JSON.stringify({
					inputDir,
					outputFile,
					companyFilters,
					titleFilters,
					batchSize,
					sleepMin,
					sleepMax,
				})}`,
			);

			try {
				// Initialize JobDB early on
				const jobDBConfig: JobDBConfig = {
					dbFilePath: path.join(path.resolve(__dirname, "..", ".."), "data", "jobDB.json"),
					defaultExpirationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
					enableJobDB: argv["use-jobdb"] ?? true,
					backupEnabled: false,
				};
				const jobDB = new JobDB(jobDBConfig);
				stats.startTimer("jobDB.initialization");
				await jobDB.initialize();
				await jobDB.load();
				stats.endTimer("jobDB.initialization");

				const fileStats = await streamProcessJobData(
					inputDir,
					outputFile,
					companyFilters,
					titleFilters,
					stats,
					jobDB,
				);

				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				log(
					"ProcessData",
					`Stream data processing completed in ${duration}.`,
					"log",
					{
						duration,
						filesProcessed: fileStats.filesProcessed,
						recordsMerged: fileStats.recordsMerged,
						duplicatesRemoved: fileStats.duplicatesRemoved,
						filteredEntries: fileStats.filteredEntries,
						outputRecordCount: fileStats.outputRecordCount,
						statistics: summary,
					},
				);

				// Export statistics to file
				const statsFile = path.join(
					path.dirname(outputFile),
					`process-data-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fs.writeFile(statsFile, stats.export("json"), "utf-8");
				log("ProcessData", `Statistics exported to: ${statsFile}`, "info");
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
					"ProcessData",
					`Stream data processing failed after ${duration}: ${errorMessage}`,
					"error",
					{ duration, error: errorMessage },
				);
			} finally {
				// Always end statistics collection
				const summary = stats.endCollection();
				log("ProcessData", "Final statistics:", "info", { summary });

				await closeFileLogging();
				setTimeout(() => process.exit(0), 1000);
			}
		},
	});
};

// Use dashed CLI options but map them to camelCase in our typed argv via yargs' .check
type ProcessDataCli = GlobalArgs & {
	"input-dir": string;
	"output-file": string;
	"company-filters": string;
	"title-filters": string;
	"batch-size": number;
	"sleep-min": number;
	"sleep-max": number;
	"use-jobdb"?: boolean;
};
