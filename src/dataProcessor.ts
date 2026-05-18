import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JobInterface } from "./models";
import { log } from "./utils";

interface ProcessingStats {
	filesProcessed: number;
	recordsMerged: number;
	duplicatesRemoved: number;
	filteredEntries: number;
	outputRecordCount: number;
	stacks: string[];
	memoryUsage: {
		peakMemory: number;
		averageMemory: number;
		totalMemory: number;
	};
}

// Cache for filter files to avoid repeated reads
const filterCache = new Map<string, string[]>();

// Memory monitoring utilities
/**
 * Memory monitoring utility for tracking memory usage during data processing
 * Provides methods to record memory readings, calculate statistics, and monitor
 * memory usage patterns to optimize performance and prevent memory issues.
 *
 * Features:
 * - Tracks current, peak, and average memory usage
 * - Configurable maximum number of readings for rolling window
 * - Calculates memory usage percentage
 * - Provides comprehensive memory statistics
 *
 * @example
 * ```typescript
 * const monitor = new MemoryMonitor(100);
 *
 * // Record memory usage during processing
 * const currentUsage = monitor.recordReading();
 * console.log(`Current memory: ${Math.round(currentUsage / 1024 / 1024)}MB`);
 *
 * // Get comprehensive stats
 * const stats = monitor.getMemoryStats();
 * console.log(`Peak memory: ${Math.round(stats.peak / 1024 / 1024)}MB`);
 * console.log(`Memory usage: ${stats.usagePercentage.toFixed(2)}%`);
 * ```
 */
class MemoryMonitor {
	private memoryReadings: number[] = [];
	private maxReadings: number = 100;

	constructor(maxReadings: number = 100) {
		this.maxReadings = maxReadings;
	}

	recordReading(): number {
		const memoryUsage = process.memoryUsage();
		const usedMemory = memoryUsage.heapUsed + memoryUsage.external;
		this.memoryReadings.push(usedMemory);

		if (this.memoryReadings.length > this.maxReadings) {
			this.memoryReadings.shift();
		}

		return usedMemory;
	}

	getPeakMemory(): number {
		return Math.max(...this.memoryReadings);
	}

	getAverageMemory(): number {
		if (this.memoryReadings.length === 0) return 0;
		return (
			this.memoryReadings.reduce((sum, reading) => sum + reading, 0) /
			this.memoryReadings.length
		);
	}

	getTotalMemory(): number {
		return process.memoryUsage().heapTotal + process.memoryUsage().external;
	}

	getMemoryStats(): {
		current: number;
		peak: number;
		average: number;
		total: number;
		usagePercentage: number;
	} {
		const current = this.recordReading();
		const peak = this.getPeakMemory();
		const average = this.getAverageMemory();
		const total = this.getTotalMemory();
		const usagePercentage = (current / total) * 100;

		return { current, peak, average, total, usagePercentage };
	}
}

const memoryMonitor = new MemoryMonitor();

/**
 * Optimized file reader with caching for filter files
 */
async function readFilterFile(
	filePath: string,
	fallback: string[],
): Promise<string[]> {
	try {
		// Check cache first
		if (filterCache.has(filePath)) {
			const cached = filterCache.get(filePath);
			if (cached) return cached;
		}

		const content = await fs.readFile(filePath, "utf-8");
		const filters = content
			.split("\n")
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0 && !line.startsWith("#"));

		// Cache the result
		filterCache.set(filePath, filters);
		return filters;
	} catch (error: unknown) {
		log(
			"ProcessData",
			`Error reading filter file ${filePath}: ${error}. Using fallback.`,
			"warn",
		);
		return fallback;
	}
}

/**
 * Batch read description files with error handling and memory optimization
 */
async function batchReadDescriptions(
	jobs: JobInterface[],
	descriptionDir: string,
): Promise<Map<string, string>> {
	const descriptionMap = new Map<string, string>();
	const descriptionFileNames = jobs.map((job) => `linkedin_job_${job.id}.txt`);
	const descriptionFilePaths = descriptionFileNames.map((fileName) =>
		path.join(descriptionDir, fileName),
	);

	// Process in batches to control memory usage
	const BATCH_SIZE = 50; // Process 50 files at a time
	const totalBatches = Math.ceil(descriptionFilePaths.length / BATCH_SIZE);

	log(
		"ProcessData",
		`Reading ${descriptionFilePaths.length} description files in ${totalBatches} batches`,
		"info",
	);

	for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
		const startIndex = batchIndex * BATCH_SIZE;
		const endIndex = Math.min(
			startIndex + BATCH_SIZE,
			descriptionFilePaths.length,
		);
		const batchPaths = descriptionFilePaths.slice(startIndex, endIndex);
		const batchJobs = jobs.slice(startIndex, endIndex);

		// Use Promise.allSettled for concurrent reading with error handling
		const readPromises = batchPaths.map(async (filePath, index) => {
			try {
				const content = await fs.readFile(filePath, "utf-8");
				// Clear memory immediately after reading
				if (content.length > 1024 * 1024) {
					// If file is larger than 1MB
					log(
						"ProcessData",
						`Large description file: ${filePath} (${Math.round(content.length / 1024)}KB)`,
						"warn",
					);
				}
				return { success: true, content, jobId: batchJobs[index].id };
			} catch (error) {
				// Only log non-ENOENT errors
				if ((error as { code?: string }).code !== "ENOENT") {
					log(
						"ProcessData",
						`Error reading description file: ${error}`,
						"error",
					);
				}
				return { success: false, content: "", jobId: batchJobs[index].id };
			}
		});

		const batchResults = await Promise.allSettled(readPromises);

		// Process batch results and clear batch from memory
		batchResults.forEach((result, _index) => {
			if (result.status === "fulfilled" && result.value.success) {
				descriptionMap.set(result.value.jobId, result.value.content);
			}
		});

		// Clear batch variables from memory
		batchPaths.length = 0;
		batchJobs.length = 0;

		// Record memory usage after each batch
		const memoryStats = memoryMonitor.getMemoryStats();
		log(
			"ProcessData",
			`Batch ${batchIndex + 1}/${totalBatches} completed. Memory usage: ${Math.round(memoryStats.current / 1024 / 1024)}MB (${Math.round(memoryStats.usagePercentage)}%)`,
			"info",
		);

		// Small delay between batches to allow garbage collection
		if (batchIndex < totalBatches - 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	return descriptionMap;
}

/**
 * Process job data from input files or directories with comprehensive data pipeline
 * Handles reading, sorting, deduplication, filtering, and writing of job data.
 * Includes memory optimization and detailed processing statistics.
 *
 * @param inputPath Path to input file or directory containing job data
 * @param outputFile Path where processed data will be saved
 * @param companyFiltersString Comma-separated string of company filters to apply
 * @param titleFiltersString Comma-separated string of title filters to apply
 * @returns Promise<ProcessingStats> Object containing processing statistics and metrics
 * @throws Error if input path cannot be read or output file cannot be written
 *
 * @example
 * ```typescript
 * const stats = await processJobData(
 *   './jobs',
 *   './processed_jobs.json',
 *   'unwantedcompany1,unwantedcompany2',
 *   'manager,director'
 * );
 *
 * console.log(`Processed ${stats.filesProcessed} files`);
 * console.log(`Removed ${stats.duplicatesRemoved} duplicates`);
 * console.log(`Memory usage: ${Math.round(stats.memoryUsage.peakMemory / 1024 / 1024)}MB`);
 * ```
 */
export async function processJobData(
	inputPath: string,
	outputFile: string,
	companyFiltersString: string,
	titleFiltersString: string,
): Promise<ProcessingStats> {
	log("ProcessData", `Processing input: ${inputPath} `);

	// Initialize memory monitoring
	memoryMonitor.recordReading();
	let allJobs: JobInterface[] = [];
	let filesProcessed = 0;
	let recordsMerged = 0;

	try {
		// Check if input is a file or directory
		const stats = await fs.stat(inputPath);

		if (stats.isFile()) {
			// Handle single file input
			log("ProcessData", `Processing single file: ${inputPath} `);
			try {
				const fileContent = await fs.readFile(inputPath, "utf-8");
				const jobs: JobInterface[] = JSON.parse(fileContent);
				if (Array.isArray(jobs)) {
					log("ProcessData", `Read ${jobs.length} records from file.`);

					// Batch read description files for better performance
					const descriptionDir = path.dirname(inputPath);
					const descriptionMap = await batchReadDescriptions(
						jobs,
						descriptionDir,
					);

					// Add descriptions to jobs
					for (const job of jobs) {
						const description = descriptionMap.get(job.id);
						if (description) {
							job.descriptionHtml = description;
						}
					}
					allJobs = jobs;
					filesProcessed = 1;
					recordsMerged = jobs.length;
				} else {
					log(
						"ProcessData",
						`Skipping file: Content is not a JSON array. 🤔`,
						"warn",
					);
					const memoryStats = memoryMonitor.getMemoryStats();
					return {
						filesProcessed: 0,
						recordsMerged: 0,
						duplicatesRemoved: 0,
						filteredEntries: 0,
						outputRecordCount: 0,
						stacks: [],
						memoryUsage: {
							peakMemory: memoryStats.peak,
							averageMemory: memoryStats.average,
							totalMemory: memoryStats.total,
						},
					};
				}
			} catch (error: unknown) {
				log(
					"ProcessData",
					`Error reading or parsing file ${inputPath}: ${error}`,
					"error",
				);
				throw new Error(`Failed to read input file: ${inputPath}`);
			}
		} else if (stats.isDirectory()) {
			// Handle directory input (original logic)
			log("ProcessData", `Reading JSON files from directory: ${inputPath} `);
			const files = await fs.readdir(inputPath);
			const jsonFiles = files.filter((file) => file.endsWith(".json"));

			if (jsonFiles.length === 0) {
				log(
					"ProcessData",
					`No JSON files found in ${inputPath}. Skipping processing. 🤷`,
					"warn",
				);
				const memoryStats = memoryMonitor.getMemoryStats();
				return {
					filesProcessed: 0,
					recordsMerged: 0,
					duplicatesRemoved: 0,
					filteredEntries: 0,
					outputRecordCount: 0,
					stacks: [],
					memoryUsage: {
						peakMemory: memoryStats.peak,
						averageMemory: memoryStats.average,
						totalMemory: memoryStats.total,
					},
				};
			}

			for (const file of jsonFiles) {
				const filePath = path.join(inputPath, file);
				log("ProcessData", `Processing file: ${file} `);
				try {
					const fileContent = await fs.readFile(filePath, "utf-8");
					const jobs: JobInterface[] = JSON.parse(fileContent);
					if (Array.isArray(jobs)) {
						log("ProcessData", `Read ${jobs.length} records from ${file}.`);

						// Batch read description files for better performance
						const descriptionMap = await batchReadDescriptions(jobs, inputPath);

						// Add descriptions to jobs
						for (const job of jobs) {
							const description = descriptionMap.get(job.id);
							if (description) {
								job.descriptionHtml = description;
							}
						}
						allJobs = allJobs.concat(jobs);
						filesProcessed++;
						recordsMerged += jobs.length;
					} else {
						log(
							"ProcessData",
							`Skipping file ${file}: Content is not a JSON array. 🤔`,
							"warn",
						);
					}
				} catch (error: unknown) {
					log(
						"ProcessData",
						`Error reading or parsing file ${file}: ${error}`,
						"error",
					);
					// Continue processing other files
				}
			}
		} else {
			throw new Error(
				`Input path is neither a file nor a directory: ${inputPath}`,
			);
		}
	} catch (error: unknown) {
		log(
			"ProcessData",
			`Error reading input path ${inputPath}: ${error}`,
			"error",
		);
		throw new Error(`Failed to read input path: ${inputPath}`);
	}

	// Record memory usage after file reading
	const memoryStatsAfterReading = memoryMonitor.getMemoryStats();
	log(
		"ProcessData",
		`Finished reading files. Processed ${filesProcessed} files, merged ${recordsMerged} records. Memory usage: ${Math.round(memoryStatsAfterReading.current / 1024 / 1024)}MB (${Math.round(memoryStatsAfterReading.usagePercentage)}%)`,
	);

	// Data Processing Pipeline
	log("ProcessData", "Starting data processing pipeline... 🛠️");

	// Record memory usage before sorting
	const memoryStatsBeforeSorting = memoryMonitor.getMemoryStats();
	let processedJobs = sortJobs(allJobs);

	// Record memory usage after sorting
	const memoryStatsAfterSorting = memoryMonitor.getMemoryStats();
	log(
		"ProcessData",
		`Sorting complete. Memory usage: ${Math.round(memoryStatsAfterSorting.current / 1024 / 1024)}MB (+${Math.round((memoryStatsAfterSorting.current - memoryStatsBeforeSorting.current) / 1024 / 1024)}MB)`,
		"info",
	);

	const { uniqueJobs, duplicatesRemoved } = removeDuplicates(processedJobs);

	// Record memory usage after duplicate removal
	const memoryStatsAfterDedup = memoryMonitor.getMemoryStats();
	log(
		"ProcessData",
		`Duplicate removal complete. Memory usage: ${Math.round(memoryStatsAfterDedup.current / 1024 / 1024)}MB (+${Math.round((memoryStatsAfterDedup.current - memoryStatsAfterSorting.current) / 1024 / 1024)}MB)`,
		"info",
	);

	const { filteredJobs, filteredEntries, stacks } = await filterJobs(
		uniqueJobs,
		companyFiltersString,
		titleFiltersString,
	);

	processedJobs = filteredJobs;

	// Record memory usage after filtering
	const memoryStatsAfterFiltering = memoryMonitor.getMemoryStats();
	log(
		"ProcessData",
		`Pipeline steps complete. Removed ${duplicatesRemoved} duplicates. Filtered ${filteredEntries} entries. Memory usage: ${Math.round(memoryStatsAfterFiltering.current / 1024 / 1024)}MB (+${Math.round((memoryStatsAfterFiltering.current - memoryStatsAfterDedup.current) / 1024 / 1024)}MB)`,
	);

	log("ProcessData", `Saving processed data to: ${outputFile} `);
	try {
		// Record memory usage before writing
		const memoryStatsBeforeWriting = memoryMonitor.getMemoryStats();
		await fs.writeFile(
			outputFile,
			JSON.stringify(processedJobs, null, 2),
			"utf-8",
		);
		// Record memory usage after writing
		const memoryStatsAfterWriting = memoryMonitor.getMemoryStats();
		log(
			"ProcessData",
			`Processed data saved successfully! Memory usage: ${Math.round(memoryStatsAfterWriting.current / 1024 / 1024)}MB (+${Math.round((memoryStatsAfterWriting.current - memoryStatsBeforeWriting.current) / 1024 / 1024)}MB)`,
			"info",
		);
	} catch (error: unknown) {
		log(
			"ProcessData",
			`Error writing output file ${outputFile}: ${error}`,
			"error",
		);
		throw new Error(`Failed to write output file: ${outputFile}`);
	}

	const memoryStats = memoryMonitor.getMemoryStats();
	const stats: ProcessingStats = {
		filesProcessed,
		recordsMerged,
		duplicatesRemoved,
		filteredEntries,
		outputRecordCount: processedJobs.length,
		stacks,
		memoryUsage: {
			peakMemory: memoryStats.peak,
			averageMemory: memoryStats.average,
			totalMemory: memoryStats.total,
		},
	};

	return stats;
}

// Sort jobs chronologically by postedDate
function sortJobs(jobs: JobInterface[]): JobInterface[] {
	log("ProcessData", "Sorting jobs by postedDate... ⏳");
	// Create a copy to avoid modifying the original array in place if needed elsewhere
	const sortedJobs = [...jobs];
	sortedJobs.sort((a, b) => {
		// Assuming postedDate is in a format that allows direct string comparison for chronological order
		if (a.postedDate < b.postedDate) {
			return -1;
		}
		if (a.postedDate > b.postedDate) {
			return 1;
		}
		return 0;
	});
	log("ProcessData", "Sorting complete. ");
	return sortedJobs;
}

// Remove duplicate jobs based on the 'id' field and the combination of 'title' and 'company'
function removeDuplicates(jobs: JobInterface[]): {
	uniqueJobs: JobInterface[];
	duplicatesRemoved: number;
} {
	log(
		"ProcessData",
		"Removing duplicate jobs by id and title/company combination... 🧹",
	);
	const uniqueJobsMap = new Map<string, JobInterface>();
	const titleCompanyMap = new Map<string, JobInterface>();
	let duplicatesRemoved = 0;

	for (const job of jobs) {
		// Check for duplicates by ID first (existing logic)
		if (uniqueJobsMap.has(job.id)) {
			log(
				"ProcessData",
				`Removing duplicate job by ID: "${job.title}" at "${job.company}" (ID: ${job.id})`,
				"info",
			);
			duplicatesRemoved++;
			continue; // Skip if duplicate ID
		}

		// Create a composite key for title and company
		const titleCompanyKey = `${job.title.toLowerCase()}::${job.company.toLowerCase()}`;

		// Check for duplicates by title and company
		if (titleCompanyMap.has(titleCompanyKey)) {
			log(
				"ProcessData",
				`Removing duplicate job by title/company: "${job.title}" at "${job.company}" (ID: ${job.id})`,
				"info",
			);
			duplicatesRemoved++;
			continue; // Skip if duplicate title/company
		}

		// If not a duplicate by either criteria, add to both maps
		uniqueJobsMap.set(job.id, job);
		titleCompanyMap.set(titleCompanyKey, job);
	}

	log(
		"ProcessData",
		`Duplicate removal complete. Found ${duplicatesRemoved} duplicates. `,
	);
	return { uniqueJobs: Array.from(uniqueJobsMap.values()), duplicatesRemoved };
}

// Filter jobs based on company name and job title
async function filterJobs(
	jobs: JobInterface[],
	companyFiltersString: string,
	titleFiltersString: string,
): Promise<{
	filteredJobs: JobInterface[];
	filteredEntries: number;
	stacks: string[];
}> {
	log("ProcessData", "Filtering jobs by company name and job title... ");

	// Load filter lists from external files
	const rootDirectory = path.resolve(__dirname, "..");
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
	const stacksFile = path.join(
		rootDirectory,
		"user_data",
		"stacks.txt",
	);

	// Load filter files concurrently for better performance
	const [defaultCompaniesToFilter, defaultTitlesToFilter, defaultStacks] =
		await Promise.all([
			readFilterFile(companyFiltersFile, [
				"jobs via dice",
				"lensa",
				"jobot",
				"talentify.io",
				"piper companies",
				"talent",
				"motion recruitment",
				"braintrust",
				"recruit",
				"teksystems",
				"robert half",
				"zachary piper",
			]),
			readFilterFile(titleFiltersFile, [
				"grc",
				"compliance",
				"product",
				"application",
				"manager",
				"director",
				"red",
				"penetration test",
				"pentest",
				"devops",
				"devsecops",
			]),
			readFilterFile(stacksFile, []),
		]);

	// Parse additional filters from arguments
	const additionalCompanies = companyFiltersString
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const additionalTitles = titleFiltersString
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	// Combine default and additional filters
	const allCompaniesToFilter = [
		...defaultCompaniesToFilter,
		...additionalCompanies,
	];
	const allTitlesToFilter = [...defaultTitlesToFilter, ...additionalTitles];

	let filteredJobs = jobs;
	let filteredEntries = 0;

	// Apply company filters
	if (allCompaniesToFilter.length > 0) {
		const companyFilteredJobs = filteredJobs.filter((job) => {
			const companyName = (job.company || "").toLowerCase();
			const isFiltered = allCompaniesToFilter.some((filterName) => {
				if (companyName.includes(filterName)) {
					log(
						"ProcessData",
						`Filtering job by company name: "${job.title}" at "${job.company}" because it includes "${filterName}".`,
						"info",
					);
					return true;
				}
				return false;
			});
			return !isFiltered;
		});

		filteredEntries += filteredJobs.length - companyFilteredJobs.length;
		filteredJobs = companyFilteredJobs;
	}

	// Apply title filters
	if (allTitlesToFilter.length > 0) {
		const titleFilteredJobs = filteredJobs.filter((job) => {
			const jobTitle = (job.title || "").toLowerCase();
			const isFiltered = allTitlesToFilter.some((filterTerm) => {
				if (jobTitle.includes(filterTerm)) {
					log(
						"ProcessData",
						`Filtering job by title: "${job.title}" at "${job.company}" because it includes "${filterTerm}".`,
						"info",
					);
					return true;
				}
				return false;
				/**
				 * Stream processor for handling large datasets with controlled memory usage
				 * Processes items in batches to optimize memory usage and performance.
				 * Automatically flushes batches when they reach the specified size.
				 *
				 * Features:
				 * - Configurable batch size for memory optimization
				 * - Automatic batch flushing when size threshold is reached
				 * - Memory usage monitoring during batch processing
				 * - Comprehensive error handling for batch operations
				 *
				 * @template T Type of items to be processed
				 * @example
				 * ```typescript
				 * const processor = new StreamProcessor(100, async (batch) => {
				 *   // Process batch of 100 items
				 *   console.log(`Processing batch of ${batch.length} items`);
				 * });
				 *
				 * // Add items to the processor
				 * for (const item of largeDataset) {
				 *   await processor.add(item);
				 * }
				 *
				 * // Process any remaining items
				 * await processor.finish();
				 * ```
				 */
			});
			return !isFiltered;
		});

		filteredEntries += filteredJobs.length - titleFilteredJobs.length;
		filteredJobs = titleFilteredJobs;
	}

	log(
		"ProcessData",
		`Filtering complete. Removed ${filteredEntries} entries. `,
	);
	return { filteredJobs, filteredEntries, stacks: defaultStacks };
}

/**
 * Stream processor for handling large datasets with controlled memory usage
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

		// Record memory usage before processing batch
		const memoryStatsBefore = memoryMonitor.getMemoryStats();
		log(
			"ProcessData",
			`Processing batch of ${batch.length} items. Memory usage: ${Math.round(memoryStatsBefore.current / 1024 / 1024)}MB`,
			"info",
		);

		try {
			await this.processBatch(batch);
		} catch (error) {
			log("ProcessData", `Error processing batch: ${error}`, "error");
			throw error;
		}

		// Record memory usage after processing batch
		const memoryStatsAfter = memoryMonitor.getMemoryStats();
		log(
			"ProcessData",
			`Batch processed. Memory usage: ${Math.round(memoryStatsAfter.current / 1024 / 1024)}MB (+${Math.round((memoryStatsAfter.current - memoryStatsBefore.current) / 1024 / 1024)}MB)`,
			"info",
		);
	}

	async finish(): Promise<void> {
		await this.flush();
	}
}

// Enhanced logging function with structured output and optional context
