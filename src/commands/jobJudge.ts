import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as puppeteer from "puppeteer";
import type { Observable } from "rxjs";
import type { Arguments, Argv } from "yargs";
import { z } from "zod";
import { JobDB, type JobDBConfig } from "../jobDB";
import { getJobDescription } from "../linkedin";
import { type LLMRequest, llmService } from "../llmService";
import type { JobInterface } from "../models";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} from "../presets";
import { createStatisticsCollector } from "../statistics";
import { type GlobalArgs, getPreset, type JobJudgeArgs } from "../types";
import { log } from "../utils";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeCommandLogging,
	initializeLLMService,
	loadApplicationData,
	performCommandCleanup,
} from "../utils/sharedCommandUtils";

// Zod schema for job analysis results (same as in jobCloth)
const JobAnalysisResultSchema = z.object({
	jobTitle: z.string(),
	isVeryHighlyAligned: z.boolean().optional().default(false),
	rationale: z.string().optional().default(""),
	confidence: z.number().optional().default(0),
});
const JobAnalysisResultsArraySchema = z.array(JobAnalysisResultSchema);

const jobsDataFolder: string = `data`;
const rootDirectory = path.resolve(__dirname, "..", "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs");

/**
 * Finds processed job files matching a given wildcard pattern.
 * @param pattern The wildcard pattern (e.g., "./data/processed_jobs_*.json").
 * @returns An array of matching file paths.
 */
async function findProcessedJobFiles(pattern: string): Promise<string[]> {
	const patternParts = pattern.split("*");
	const prefix = patternParts[0];
	const suffix = patternParts[1];

	const resolvedPrefix = path.resolve(rootDirectory, prefix);
	const dir = path.dirname(resolvedPrefix);
	const baseNamePrefix = path.basename(resolvedPrefix);

	try {
		const files = await fs.promises.readdir(dir);
		const matchingFiles = files
			.filter((file) => {
				return file.startsWith(baseNamePrefix) && file.endsWith(suffix);
			})
			.map((file) => path.join(dir, file));
		return matchingFiles;
	} catch (error) {
		log("JobJudge", `Error finding processed job files: ${error}`, "error");
		return [];
	}
}

/**
 * Extracts job ID from URL using various patterns
 */
function extractJobIdFromUrl(url: string, filename?: string): string {
	// Try to extract ID from URL pattern: /jobs/view/.../ID?position= or /jobs/view/.../ID&position=
	const urlMatch = url.match(/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/);
	if (urlMatch) {
		return urlMatch[1];
	}

	// Fallback to other URL patterns
	const fallbackMatch = url.match(/\/jobs\/view\/[^/]+\/(\d+)/);
	if (fallbackMatch) {
		return fallbackMatch[1];
	}

	// Use filename as fallback
	if (filename) {
		const filenameMatch = filename.match(/^job_(\d+)\.json$/);
		if (filenameMatch) {
			return filenameMatch[1];
		}
		const processedMatch = filename.match(/^processed_jobs_(\d+)\.json$/);
		if (processedMatch) {
			return processedMatch[1];
		}
	}

	// Use URL hash as final fallback
	return crypto.createHash("md5").update(url).digest("hex").substring(0, 8);
}

/**
 * Parses job data from file content, handling both JSON arrays and newline-separated objects
 */
async function parseJobsFromFile(
	filePath: string,
	fileContent: string,
	filename?: string,
): Promise<JobInterface[]> {
	let jobs: JobInterface[] = [];

	// Handle both JSON array format and newline-separated JSON objects
	try {
		// First try to parse as JSON array
		const jobData = JSON.parse(fileContent);
		if (Array.isArray(jobData)) {
			jobs = jobData;
		} else if (jobData && typeof jobData === "object") {
			const jobWithId = { ...jobData };
			if (!jobWithId.id) {
				jobWithId.id = extractJobIdFromUrl(jobWithId.url || "", filename);
			}
			jobs = [jobWithId];
		} else {
			throw new Error(
				`File ${filePath} does not contain a valid job object or array.`,
			);
		}
	} catch (_parseError) {
		// If JSON array parsing fails, try newline-separated JSON objects
		log(
			"JobJudge",
			`Failed to parse as JSON array, trying newline-separated format...`,
			"warn",
		);
		const lines = fileContent.split("\n").filter((line) => line.trim());
		let currentJobJson = "";

		for (const line of lines) {
			currentJobJson += `${line}\n`;

			// Try to parse as complete JSON object
			try {
				const jobData = JSON.parse(currentJobJson);
				if (jobData && typeof jobData === "object") {
					const jobWithId = { ...jobData };

					// Extract job ID from URL if not present
					if (!jobWithId.id && jobWithId.url) {
						jobWithId.id = extractJobIdFromUrl(jobWithId.url);
					}

					jobs.push(jobWithId);
					currentJobJson = ""; // Reset for next job
				}
			} catch (_lineError) {}
		}
	}

	return jobs;
}

/**
 * Launches browser with standard configuration
 */
async function launchBrowser(
	argv: Arguments<GlobalArgs & JobJudgeArgs & { debugUrl?: string }>,
): Promise<puppeteer.Browser> {
	log("JobJudge", "Launching browser...", "info");
	console.log("JobJudge: Launching browser...");

	const browser = await puppeteer.launch({
		headless: argv.headless as boolean | "shell" | undefined,
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

	log("JobJudge", "Browser launched successfully", "info");
	console.log("JobJudge: Browser launched successfully");

	return browser;
}

/**
 * Creates a new browser page
 */
async function createPage(browser: puppeteer.Browser): Promise<puppeteer.Page> {
	log("JobJudge", "Creating new page...", "info");
	console.log("JobJudge: Creating new page...");

	const page = await browser.newPage();
	log("JobJudge", "Page created successfully", "info");
	console.log("JobJudge: Page created successfully");

	return page;
}

/**
 * Subscribes to job data observable and resolves promise
 */
async function getJobDataFromObservable(
	jobData$: Observable<unknown>,
): Promise<unknown> {
	log("JobJudge", "Creating Promise to handle observable...", "info");
	console.log("JobJudge: Creating Promise to handle observable...");

	return new Promise((resolve, reject) => {
		log("JobJudge", "Inside Promise, subscribing to observable...", "info");
		console.log("JobJudge: Inside Promise, subscribing to observable...");

		const subscription = jobData$.subscribe({
			next: (data) => {
				log("JobJudge", "Observable emitted data!", "info");
				console.log("JobJudge: Observable emitted data!");
				resolve(data);
				subscription.unsubscribe();
				log(
					"JobJudge",
					"Unsubscribed from observable after receiving data",
					"info",
				);
				console.log(
					"JobJudge: Unsubscribed from observable after receiving data",
				);
			},
			error: (err) => {
				log(
					"JobJudge",
					`Observable error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				console.error(
					`JobJudge: Observable error: ${err instanceof Error ? err.message : String(err)}`,
				);
				reject(err);
				subscription.unsubscribe();
				log("JobJudge", "Unsubscribed from observable after error", "info");
				console.log("JobJudge: Unsubscribed from observable after error");
			},
			complete: () => {
				// In case the observable completes without emitting (e.g., empty)
				log("JobJudge", "Observable completed without emitting data", "warn");
				console.log("JobJudge: Observable completed without emitting data");
				resolve(null);
				log("JobJudge", "Resolved Promise with null after completion", "info");
				console.log("JobJudge: Resolved Promise with null after completion");
			},
		});

		log(
			"JobJudge",
			"Subscription created, waiting for observable to emit...",
			"info",
		);
		console.log(
			"JobJudge: Subscription created, waiting for observable to emit...",
		);
	});
}

/**
 * Displays job data in readable format
 */
function displayJobData(jobData: unknown): void {
	console.log("\nEnhanced Job Details:");
	console.log("--------------------");

	const jobDataAny = jobData as unknown;
	console.log(`Title: ${(jobDataAny as { title: string }).title}`);
	console.log(`Company: ${(jobDataAny as { company: string }).company}`);
	console.log(`Location: ${(jobDataAny as { location: string }).location}`);
	if ((jobDataAny as { employmentType?: string }).employmentType)
		console.log(
			`Employment Type: ${(jobDataAny as { employmentType: string }).employmentType}`,
		);
	if ((jobDataAny as { seniorityLevel?: string }).seniorityLevel)
		console.log(
			`Seniority Level: ${(jobDataAny as { seniorityLevel: string }).seniorityLevel}`,
		);
	if ((jobDataAny as { jobFunction?: string }).jobFunction)
		console.log(
			`Job Function: ${(jobDataAny as { jobFunction: string }).jobFunction}`,
		);
	if ((jobDataAny as { industries?: string }).industries)
		console.log(
			`Industries: ${(jobDataAny as { industries: string }).industries}`,
		);
	if ((jobDataAny as { postedTime?: string }).postedTime)
		console.log(
			`Posted Time: ${(jobDataAny as { postedTime: string }).postedTime}`,
		);
	if ((jobDataAny as { applicants?: string }).applicants)
		console.log(
			`Applicants: ${(jobDataAny as { applicants: string }).applicants}`,
		);
	if ((jobDataAny as { salaryRange?: string }).salaryRange)
		console.log(
			`Salary Range: ${(jobDataAny as { salaryRange: string }).salaryRange}`,
		);
	console.log("--------------------");
}

/**
 * Writes job data to file
 */
async function writeJobDataToFile(jobData: unknown): Promise<void> {
	const tempFilePath = path.join(process.cwd(), "debug_scrape_output.json");
	log("JobJudge", `Writing to file: ${tempFilePath}`, "info");
	console.log(`JobJudge: Writing to file: ${tempFilePath}`);

	try {
		await fs.promises.writeFile(
			tempFilePath,
			JSON.stringify(jobData, null, 2),
			"utf-8",
		);
		log("JobJudge", `Scraped data written to ${tempFilePath}`, "info");
		console.log(`JobJudge: Scraped data written to ${tempFilePath}`);
	} catch (writeError: unknown) {
		log(
			"JobJudge",
			`Error writing to file: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
			"error",
		);
		console.error(
			`JobJudge: Error writing to file: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
		);
	}
}

/**
 * Performs cleanup operations
 */
async function performCleanup(browser: puppeteer.Browser): Promise<void> {
	log("JobJudge", "Debug scrape completed, cleaning up...", "info");
	console.log("JobJudge: Debug scrape completed, cleaning up...");

	try {
		log("JobJudge", "Closing file logging...", "info");
		console.log("JobJudge: Closing file logging...");
		await closeFileLogging();
		log("JobJudge", "File logging closed", "info");
		console.log("JobJudge: File logging closed");
	} catch (loggingError: unknown) {
		console.error(
			`JobJudge: Error closing file logging: ${loggingError instanceof Error ? loggingError.message : String(loggingError)}`,
		);
	}

	try {
		if (browser) {
			log("JobJudge", "Closing browser...", "info");
			console.log("JobJudge: Closing browser...");
			await browser.close();
			log("JobJudge", "Browser closed", "info");
			console.log("JobJudge: Browser closed");
		}
	} catch (browserError: unknown) {
		const browserErrorTyped = browserError as unknown;
		console.error(
			`JobJudge: Error closing browser: ${(browserErrorTyped as Error).message}`,
		);
	}
}

/**
 * Handles debug mode URL scraping
 */
async function _handleDebugMode(
	argv: Arguments<GlobalArgs & JobJudgeArgs & { debugUrl?: string }>,
	browser: puppeteer.Browser,
): Promise<void> {
	log("JobJudge", `Starting debug scrape for URL: ${argv.debugUrl}`, "info");
	console.log("JobJudge: Starting debug scrape...");

	let page: puppeteer.Page;
	let jobData$: Observable<unknown>;

	try {
		browser = await launchBrowser(argv);
		page = await createPage(browser);

		log("JobJudge", "Getting job description...", "info");
		console.log("JobJudge: Getting job description...");
		if (!argv.debugUrl) {
			throw new Error("Debug URL is required");
		}
		jobData$ = getJobDescription(page, { url: argv.debugUrl });
		log("JobJudge", "Job description observable created", "info");
		console.log("JobJudge: Job description observable created");
	} catch (error: unknown) {
		const errorTyped = error as unknown;
		log(
			"JobJudge",
			`Error during debug setup: ${(errorTyped as Error).message}`,
			"error",
		);
		console.error(
			`JobJudge: Error during debug setup: ${(errorTyped as Error).message}`,
		);
		throw error;
	}

	const jobData = await getJobDataFromObservable(jobData$);

	log("JobJudge", "Promise resolved, checking jobData...", "info");
	console.log("JobJudge: Promise resolved, checking jobData...");

	if (jobData) {
		log("JobJudge", "Job data received, writing to file...", "info");
		console.log("JobJudge: Job data received, writing to file...");
		log(
			"JobJudge",
			`Scraped job data:\n${JSON.stringify(jobData, null, 2)}`,
			"info",
		);
		console.log("Scraped job data:", JSON.stringify(jobData, null, 2));

		displayJobData(jobData);
		await writeJobDataToFile(jobData);
	} else {
		log("JobJudge", "Scraping completed but no job data was received.", "warn");
		console.log("JobJudge: Scraping completed but no job data was received.");
	}

	await performCleanup(browser);

	log("JobJudge", "Exiting process...", "info");
	console.log("JobJudge: Exiting process...");
	process.exit(0);
}

/**
 * Processes input files and returns job data
 */
async function _processInputFiles(
	argv: Arguments<GlobalArgs & JobJudgeArgs>,
	rootDirectory: string,
): Promise<JobInterface[]> {
	const resolvedInputPath = path.resolve(rootDirectory, argv["input-file"]);
	let processedJobs: JobInterface[] = [];

	// Handle input file(s)
	if (argv["input-file"] === "./data/scraped_jobs_*.json") {
		const matchingFiles = await findProcessedJobFiles(argv["input-file"]);
		if (matchingFiles.length === 0) {
			throw new Error(
				`No files matching pattern "${argv["input-file"]}" found.`,
			);
		}
		log("JobJudge", `Found ${matchingFiles.length} files matching pattern.`);

		for (const filePath of matchingFiles) {
			log("JobJudge", `Processing file: ${filePath}`);
			const fileContent = await fs.promises.readFile(filePath, "utf-8");
			const jobs = await parseJobsFromFile(
				filePath,
				fileContent,
				path.basename(filePath),
			);
			processedJobs.push(...jobs);
			log(
				"JobJudge",
				`Loaded ${jobs.length} jobs from ${path.basename(filePath)}`,
			);
		}
	} else {
		// Existing logic for single file or directory
		const stats = await fs.promises.stat(resolvedInputPath);
		if (stats.isDirectory()) {
			const files = await fs.promises.readdir(resolvedInputPath);
			const jsonFiles = files.filter((file) => file.endsWith(".json"));
			if (jsonFiles.length === 0) {
				throw new Error(
					`No JSON files found in directory: ${resolvedInputPath}`,
				);
			}
			log("JobJudge", `Found ${jsonFiles.length} JSON files in directory.`);
			for (const file of jsonFiles) {
				const filePath = path.join(resolvedInputPath, file);
				log("JobJudge", `Processing file: ${filePath}`);
				const fileContent = await fs.promises.readFile(filePath, "utf-8");
				const jobs = await parseJobsFromFile(filePath, fileContent, file);
				processedJobs.push(...jobs);
				log("JobJudge", `Loaded ${jobs.length} jobs from ${file}`);
			}
		} else {
			const fileContent = await fs.promises.readFile(
				resolvedInputPath,
				"utf-8",
			);
			processedJobs = await parseJobsFromFile(
				resolvedInputPath,
				fileContent,
				path.basename(resolvedInputPath),
			);
		}
	}

	return processedJobs;
}

/**
 * Loads previously processed job IDs from log file
 */
async function _loadProcessedJobIds(logFile: string): Promise<Set<string>> {
	const processedJobIds = new Set<string>();

	try {
		const logContent = await fs.promises.readFile(logFile, "utf-8");
		logContent.split("\n").forEach((id) => {
			const trimmedId = id.trim();
			if (trimmedId) {
				processedJobIds.add(trimmedId);
			}
		});
		log(
			"JobJudge",
			`Loaded ${processedJobIds.size} processed job IDs from log file.`,
		);
	} catch (error: unknown) {
		if ((error as { code?: string }).code === "ENOENT") {
			log(
				"JobJudge",
				"Log file not found. Starting with an empty processed job list.",
				"warn",
			);
		} else {
			log(
				"JobJudge",
				`Error reading log file: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			throw error;
		}
	}

	return processedJobIds;
}

/**
 * Creates fallback evaluation when LLM parsing fails
 */
function createFallbackEvaluation(
	job: JobInterface,
	_parsingError: string,
	maxRetries: number,
): z.infer<typeof JobAnalysisResultsArraySchema> {
	// Simple heuristic: check if job title contains keywords that suggest alignment
	const title = job.title?.toLowerCase() || "";
	const description = job.descriptionText?.toLowerCase() || "";
	const positiveKeywords = [
		"engineer",
		"developer",
		"software",
		"security",
		"analyst",
		"specialist",
	];
	const keywordMatches = positiveKeywords.filter(
		(keyword) => title.includes(keyword) || description.includes(keyword),
	).length;

	// Very conservative: only pass if multiple positive indicators
	const isPassVerdict = keywordMatches >= 2;

	return [
		{
			jobTitle: job.title || "Unknown",
			isVeryHighlyAligned: isPassVerdict,
			rationale: isPassVerdict
				? `Basic keyword matching passed (${keywordMatches} matches) after ${maxRetries} failed LLM attempts`
				: `Basic keyword matching failed (${keywordMatches} matches) - parsing error occurred after ${maxRetries} attempts`,
			confidence: keywordMatches > 0 ? Math.min(keywordMatches * 0.3, 1.0) : 0,
		},
	];
}

/**
 * Creates LLM request configuration for job evaluation
 */
async function createLLMRequestConfig(
	_job: JobInterface,
	effectivePreset: unknown,
	_placeholderData: unknown,
	userMessageContent: string,
	maxTokens: number,
): Promise<LLMRequest> {
	const effectivePresetTyped = effectivePreset as unknown;
	const _placeholderDataTyped = _placeholderData as unknown;
	const veritasSystemPrompt = await loadVeritasSystemPrompt();

	return {
		provider: (
			effectivePresetTyped as {
				provider:
					| "openai"
					| "gemini"
					| "mistral"
					| "openrouter"
					| "cerebras"
					| "poe";
			}
		).provider,
		model: (effectivePresetTyped as { modelId: string }).modelId,
		messages: [
			{ role: "system", content: veritasSystemPrompt },
			{ role: "user", content: userMessageContent },
		],
		temperature: (effectivePresetTyped as { temperature: number }).temperature,
		topP: (effectivePresetTyped as { topP: number }).topP,
		maxTokens: maxTokens,
		timeout: 30000,
		responseSchema: JobAnalysisResultsArraySchema,
	};
}

/**
 * Logs LLM payload if requested
 */
async function logLLMPayload(
	job: JobInterface,
	effectivePreset: unknown,
	llmRequest: LLMRequest,
	placeholderData: unknown,
	evalMode: number,
	argv: Arguments<GlobalArgs & JobJudgeArgs>,
): Promise<void> {
	if (!argv.logPayload) return;

	const actualPayload = {
		jobId: job.id,
		jobTitle: job.title,
		company: job.company,
		evaluationMode: evalMode,
		provider: (effectivePreset as { provider: string }).provider,
		model: llmRequest.model,
		systemPrompt: await loadVeritasSystemPrompt(),
		userMessage: placeholderData as Record<string, string>,
		parameters: {
			temperature: llmRequest.temperature,
			topP: llmRequest.topP,
			maxTokens: llmRequest.maxTokens,
		},
		timestamp: new Date().toISOString(),
		apiCallPayload: {
			model: llmRequest.model,
			messages: llmRequest.messages,
			temperature: llmRequest.temperature,
			top_p: llmRequest.topP,
			response_format: { type: "json_object" },
			stream: false,
			max_tokens: llmRequest.maxTokens,
		},
	};

	const payloadFileName = `job_${job.id}_payload_mode${evalMode}_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`;
	const payloadFilePath = path.join(argv["log-dir"] as string, payloadFileName);
	await fs.promises.writeFile(
		payloadFilePath,
		JSON.stringify(actualPayload, null, 2),
	);

	log("JobJudge", `Outbound LLM payload saved to: ${payloadFilePath}`, "info");
}

/**
 * Handles LLM call with retry logic and error recovery
 */
async function callLLMWithRetry(
	job: JobInterface,
	llmRequest: LLMRequest,
	argv: Arguments<GlobalArgs & JobJudgeArgs>,
): Promise<{
	resultArray: z.infer<typeof JobAnalysisResultsArraySchema>;
	parsingError: string | null;
	retryCount: number;
}> {
	const maxRetries = 3;
	let retryCount = 0;
	let parsingError: string | null = null;
	let resultArray: z.infer<typeof JobAnalysisResultsArraySchema> = [];

	// Retry loop for LLM calls
	let retrySuccess = false;
	while (retryCount < maxRetries && !retrySuccess) {
		try {
			log(
				"JobJudge",
				`Attempt ${retryCount + 1}/${maxRetries} for job ${job.id}`,
				"info",
			);

			// Make API call using centralized service
			const result = await llmService.call(llmRequest);

			// Display verbose response if requested
			if (argv.verbose) {
				displayVerboseResponse(result);
			}

			// Parse result for pass/fail determination - LLM service returns validated array
			resultArray = result.content as z.infer<
				typeof JobAnalysisResultsArraySchema
			>;
			if (resultArray && resultArray.length > 0) {
				retrySuccess = true; // Success - exit retry loop
				log(
					"JobJudge",
					`Successfully parsed LLM response on attempt ${retryCount + 1} for job ${job.id}`,
					"info",
				);
			} else {
				throw new Error("Empty result array from LLM service");
			}
		} catch (error: unknown) {
			const errorTyped = error as unknown;
			retryCount++;
			parsingError = (errorTyped as Error).message;
			log(
				"JobJudge",
				`Attempt ${retryCount} failed for job ${job.id}: ${parsingError}`,
				"warn",
			);

			if (retryCount >= maxRetries) {
				log(
					"JobJudge",
					`Max retries (${maxRetries}) reached for job ${job.id}`,
					"warn",
				);

				// Check if strict parsing is enabled
				if (argv.strictParsing) {
					log(
						"JobJudge",
						`Strict parsing enabled - stopping processing due to parsing failure for job ${job.id}`,
						"error",
					);
					throw new Error(
						`Strict parsing failed for job ${job.id} after ${maxRetries} attempts: ${parsingError}`,
					);
				}

				// Fallback: Try to extract basic information from raw response
				try {
					const fallbackResponse = {
						jobTitle: job.title || "Unknown",
						isVeryHighlyAligned: false, // Default to fail safe
						rationale: `Failed to parse LLM response after ${maxRetries} attempts - using fallback evaluation`,
						confidence: 0,
					};

					resultArray = [fallbackResponse];
					log(
						"JobJudge",
						`Applied fallback evaluation for job ${job.id} after ${maxRetries} failed attempts`,
						"warn",
					);
				} catch (_fallbackError: unknown) {
					// Ultimate fallback - basic pass/fail based on simple heuristics
					log(
						"JobJudge",
						`Fallback parsing also failed for job ${job.id}, using basic heuristics`,
						"error",
					);

					resultArray = createFallbackEvaluation(
						job,
						parsingError || "",
						maxRetries,
					);
				}
			} else {
				// Wait before retrying (exponential backoff)
				const waitTime = 2 ** retryCount * 1000; // 2s, 4s, 8s
				log(
					"JobJudge",
					`Waiting ${waitTime}ms before retry ${retryCount + 1} for job ${job.id}`,
					"info",
				);
				await new Promise((resolve) => setTimeout(resolve, waitTime));
			}
		}
	}

	return { resultArray, parsingError, retryCount };
}

/**
 * Performs LLM evaluation with retry logic
 */
async function evaluateJobWithLLM(
	job: JobInterface,
	effectivePreset: unknown,
	argv: Arguments<GlobalArgs & JobJudgeArgs>,
	evalMode: number,
	placeholderData: unknown,
	userMessageContent: string,
): Promise<{
	isPassVerdict: boolean;
	resultArray: z.infer<typeof JobAnalysisResultsArraySchema>;
	parsingError: string | null;
	retryCount: number;
}> {
	// Determine maxTokens with CLI override and preset fallback
	const maxTokens =
		(argv["max-tokens"] as number) ??
		(effectivePreset as { maxTokens?: number }).maxTokens ??
		16000;

	// Create LLM request using centralized service
	const llmRequest: LLMRequest = await createLLMRequestConfig(
		job,
		effectivePreset,
		placeholderData as Record<string, string>,
		userMessageContent,
		maxTokens,
	);

	// Add JSON Mode for OpenAI provider
	if ((effectivePreset as { provider: string }).provider === "openai") {
		(llmRequest as any).response_format = {
			type: "json_object",
		};
	}

	// Log outbound payload if requested
	await logLLMPayload(
		job,
		effectivePreset,
		llmRequest,
		placeholderData as Record<string, string>,
		evalMode,
		argv,
	);

	// Display verbose information if requested
	if (argv.verbose) {
		displayVerboseInfo(
			job,
			effectivePreset,
			llmRequest,
			await loadVeritasSystemPrompt(),
			(effectivePreset as { promptTemplate: string }).promptTemplate,
			evalMode,
		);
	}

	// Call LLM with retry logic
	const { resultArray, parsingError, retryCount } = await callLLMWithRetry(
		job,
		llmRequest,
		argv,
	);

	const isPassVerdict =
		resultArray.length > 0
			? resultArray[0].isVeryHighlyAligned || false
			: false;

	return { isPassVerdict, resultArray, parsingError, retryCount };
}

/**
 * Displays verbose information for debugging
 */
function displayVerboseInfo(
	job: JobInterface,
	effectivePreset: unknown,
	llmRequest: LLMRequest,
	veritasSystemPrompt: string,
	userMessageContent: string,
	evalMode: number,
): void {
	console.log("\n=== VERBOSE MODE - JOB JUDGE ===");
	console.log(`Job ID: ${job.id}`);
	console.log(`Job Title: ${job.title}`);
	console.log(`Company: ${job.company}`);
	console.log(
		`Evaluation Mode: ${evalMode} (${(effectivePreset as { name: string }).name})`,
	);
	console.log(
		`Provider: ${(effectivePreset as { provider: string }).provider}`,
	);
	console.log(`Model: ${llmRequest.model}`);
	console.log("\n--- Outgoing LLM Payload ---");
	console.log("System Prompt:");
	console.log(
		veritasSystemPrompt.substring(0, 500) +
			(veritasSystemPrompt.length > 500 ? "..." : ""),
	);
	console.log(`User Message (Job Description):`);
	console.log(
		userMessageContent.substring(0, 500) +
			(userMessageContent.length > 500 ? "..." : ""),
	);
	console.log("\n--- Outgoing LLM Request Payload ---");
	console.log(JSON.stringify(llmRequest, null, 2));
	console.log("=============================\n");
}

/**
 * Displays verbose response for debugging
 */
function displayVerboseResponse(result: unknown): void {
	console.log("--- Incoming LLM Response ---");
	if (typeof (result as { content: unknown }).content === "string") {
		const content = (result as { content: string }).content;
		console.log(
			content.substring(0, 2000) + (content.length > 2000 ? "..." : ""),
		);
	} else {
		console.log(
			JSON.stringify((result as { content: unknown }).content, null, 2),
		);
	}
	console.log("=============================\n");
}

/**
 * Saves job evaluation result to appropriate directory
 */
async function _saveJobEvaluationResult(
	job: JobInterface,
	isPassVerdict: boolean,
	tempDir: string,
	passDir: string,
	failDir: string,
	resultArray: z.infer<typeof JobAnalysisResultsArraySchema>,
	parsingError: string | null,
	retryCount: number,
	maxRetries: number,
): Promise<void> {
	const jobWithResult = {
		...job,
		evaluationResult: {
			mode: 4, // Default mode
			isPass: isPassVerdict,
			timestamp: new Date().toISOString(),
			parsingError: parsingError,
			fallbackUsed: !!parsingError,
			analysisResult: resultArray.length > 0 ? resultArray[0] : null,
			retryCount: retryCount,
			maxRetries: maxRetries,
			retrySuccess: retryCount < maxRetries,
		},
	};

	const jdFileName = `${job.id}.json`;
	const jdFilePath = path.join(tempDir, jdFileName);
	await fs.promises.writeFile(
		jdFilePath,
		JSON.stringify(jobWithResult, null, 2),
	);

	if (isPassVerdict) {
		log(
			"JobJudge",
			`Job ${job.id} passed evaluation! Moving to passed directory.`,
		);
		await fs.promises.rename(jdFilePath, path.join(passDir, jdFileName));
	} else {
		log(
			"JobJudge",
			`Job ${job.id} failed evaluation. Moving to failed directory.`,
		);
		await fs.promises.rename(jdFilePath, path.join(failDir, jdFileName));
	}
}

/**
 * Generates a comprehensive job evaluation report
 */
async function _generateJobEvaluationReport(
	passedJobs: JobInterface[],
	dataDirectory: string,
	processedJobs: JobInterface[],
	processedJobIds: Set<string>,
): Promise<void> {
	const totalJobsEvaluated = processedJobs.length;

	log("JobJudge", "\n--- Job Evaluation Report --- ");
	log("JobJudge", `Total Jobs Evaluated: ${totalJobsEvaluated}`);
	log("JobJudge", `Jobs Passed: ${passedJobs.length}`);
	log("JobJudge", `Jobs Failed: ${totalJobsEvaluated - passedJobs.length}`);

	if (passedJobs.length === 0) {
		log("JobJudge", "No jobs passed the evaluation in this run.");
		return;
	}

	const reportDir = path.join(dataDirectory, "job_judge_reports");
	await fs.promises.mkdir(reportDir, { recursive: true });
	const reportFileName = `job_judge_report_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.md`;
	const reportFilePath = path.join(reportDir, reportFileName);

	let reportContent = `# Job Judge Evaluation Report\n\n`;
	reportContent += `**Date:** ${formatDate(new Date(), "yyyy-MM-dd HH:mm:ss")}\n\n`;
	reportContent += `**Total Jobs Evaluated (in this run):** ${processedJobs.length - (processedJobIds.size - passedJobs.length)}\n`;
	reportContent += `**Jobs Skipped (already processed):** ${processedJobIds.size - passedJobs.length}\n`;
	reportContent += `**Jobs Passed Evaluation:** ${passedJobs.length}\n\n`;
	reportContent += `**Evaluation Mode Used:** 4\n\n`;

	if (passedJobs.length > 0) {
		reportContent += `## Passed Jobs\n\n`;
		passedJobs.forEach((job) => {
			reportContent += `### ${job.title}\n\n`;
			reportContent += `- **Company:** ${job.company}\n`;
			const salary =
				job.salaryRange ||
				(job.salaryMin > 0 || job.salaryMax > 0
					? `${job.salaryCurrency} ${job.salaryMin > 0 ? job.salaryMin.toLocaleString() : ""}${job.salaryMin > 0 && job.salaryMax > 0 ? " - " : ""}${job.salaryMax > 0 ? job.salaryMax.toLocaleString() : ""}`
					: "Not specified");
			reportContent += `- **Compensation:** ${salary}\n`;
			const location = job.remoteOk
				? `${job.location} (Remote OK)`
				: job.location;
			reportContent += `- **Location:** ${location}\n`;

			// Add the new fields we're extracting from LinkedIn
			if (job.employmentType) {
				reportContent += `- **Employment Type:** ${job.employmentType}\n`;
			}
			if (job.seniorityLevel) {
				reportContent += `- **Seniority Level:** ${job.seniorityLevel}\n`;
			}
			if (job.jobFunction) {
				reportContent += `- **Job Function:** ${job.jobFunction}\n`;
			}
			if (job.industries) {
				reportContent += `- **Industries:** ${job.industries}\n`;
			}
			if (job.postedDate) {
				const postedDate = new Date(job.postedDate);
				const formattedDate = Number.isNaN(postedDate.getTime())
					? job.postedDate
					: formatDate(postedDate, "yyyy-MM-dd");
				reportContent += `- **Posted Date:** ${formattedDate}\n`;
			}
			if (job.applicants) {
				reportContent += `- **Applicants:** ${job.applicants}\n`;
			}

			reportContent += `- **URL:** [${job.url}](${job.url})\n`;
			reportContent += `\n`;
		});

		reportContent += `## Passed Job URLs\n\n`;
		passedJobs.forEach((job) => {
			reportContent += `- [${job.title} at ${job.company}](${job.url})\n`;
		});
	} else {
		reportContent += "No jobs passed the evaluation in this run.\n";
	}

	await fs.promises.writeFile(reportFilePath, reportContent, "utf-8");
	log("JobJudge", `Comprehensive Markdown report saved to: ${reportFilePath}`);

	// Log passed jobs to console
	passedJobs.forEach((job) => {
		log("JobJudge", `Title: ${job.title}`);
		log("JobJudge", `Company: ${job.company}`);
		const salary =
			job.salaryRange ||
			(job.salaryMin > 0 || job.salaryMax > 0
				? `${job.salaryCurrency} ${job.salaryMin > 0 ? job.salaryMin.toLocaleString() : ""}${job.salaryMin > 0 && job.salaryMax > 0 ? " - " : ""}${job.salaryMax > 0 ? job.salaryMax.toLocaleString() : ""}`
				: "Not specified");
		log("JobJudge", `Compensation: ${salary}`);
		const location = job.remoteOk
			? `${job.location} (Remote OK)`
			: job.location;
		log("JobJudge", `Location: ${location}`);
		log("JobJudge", `URL: ${job.url}`);
		log("JobJudge", "-------------------------------------------");
	});
}

export const addJobJudgeCommand = (
	yargs: Argv<GlobalArgs>,
	jobJudgePresets: string[], // Add jobJudgePresets as an argument
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "jobJudge",
		describe:
			"Production-ready job evaluation using TypeScript native er44zzModes with centralized LLM service, circuit breaker patterns, and comprehensive error handling",
		builder: async (y: Argv<GlobalArgs>) => {
			// Make builder async
			// Remove these lines as presets are now passed as an argument
			// const allPresets = await loadPresets();
			// const jobJudgePresets = getAvailablePresets("jobJudge", allPresets);

			// Define options with explicit generic so TS knows final argv type includes required fields
			const yy = y as Argv<GlobalArgs & JobJudgeArgs & { debugUrl?: string }>;
			return (
				yy
					.option("input-file", {
						alias: "i",
						type: "string",
						description:
							"Input file path for the scraped JSON job data (from scrape-jobs command).",
						default: "./data/scraped_jobs_*.json",
						demandOption: false,
					})
					.option("headless", {
						alias: "hdl",
						type: "boolean",
						description:
							"Whether or not execute puppeteer in headless mode for description scraping. Defaults to true",
						default: true,
					})
					.option("eval-mode", {
						type: "number",
						description:
							"Evaluation mode (3 for jdd-g41m, 4 for jdd-gf2.0t). Defaults to 4",
						default: 4,
					})
					.option("preset", {
						type: "string",
						description: `Preset to use for job evaluation. Available: ${jobJudgePresets.join(", ")}`,
						choices: jobJudgePresets, // Dynamically set choices
						demandOption: true, // Preset is now mandatory
					})
					.option("verbose", {
						alias: "v",
						type: "boolean",
						description:
							"Display outgoing LLM payload and incoming response for debugging",
						default: false,
					})
					.option("debug-url", {
						type: "string",
						description:
							"Debug mode: scrape a single job description from this URL and exit.",
						implies: "headless",
					})
					// Ensure the global logging-related options exist for type compatibility
					.option("log-dir", {
						type: "string",
						description: "Directory where log files will be written",
						default: defaultLogDirectory,
					})
					.option("log-file", {
						type: "string",
						description: "Name of the log file. A timestamp will be prepended.",
						default: "astroex.log",
					})
					.option("disable-file-logging", {
						type: "boolean",
						description: "Disable writing logs to file",
						default: false,
					})
					.option("log-payload", {
						type: "boolean",
						description: "Save outbound LLM payload to ./logs folder",
						default: false,
					})
					.option("output-file", {
						type: "string",
						description:
							"Output directory for evaluated job files (files are moved to subdirectories based on evaluation result)",
						default: "./data/astroapply_eval_",
						demandOption: false,
					})
					.option("sleep", {
						alias: "s",
						type: "number",
						description:
							"Sleep duration in seconds between job evaluations to avoid rate limiting (1 = 1 second)",
						default: 2,
						demandOption: false,
					})
					.option("strict-parsing", {
						type: "boolean",
						description:
							"If true, stop processing when a job fails to parse. If false, use fallback evaluation (default: false)",
						default: false,
					})
					.option("use-jobdb", {
						type: "boolean",
						description:
							"Enable jobDB functionality to prevent duplicate processing by company/title with expiration (default: true)",
						default: true,
					})
					.option("max-tokens", {
						type: "number",
						description:
							"Maximum number of tokens for LLM responses (overrides preset value)",
						default: undefined,
					})
					.check(async (argv) => {
						// Make check async
						// Presets are already loaded and passed, so we can use them directly for validation
						const allPresets = await loadPresets(); // Still need to load all presets for getPreset
						if (
							!argv.preset ||
							!getPreset("jobJudge", argv.preset, allPresets)
						) {
							throw new Error(
								`Invalid or missing preset. Available presets for jobJudge: ${jobJudgePresets.join(", ")}`,
							);
						}
						return true;
					}) as Argv<GlobalArgs & JobJudgeArgs & { debugUrl?: string }>
			);
		},
		handler: async (
			argv: Arguments<
				GlobalArgs & JobJudgeArgs & { debugUrl?: string; verbose?: boolean }
			>,
		) => {
			log("JobJudge", `Command parameters: ${JSON.stringify(argv)}`, "info");

			initializeCommandLogging("JobJudge", argv);
			// Initialize statistics collection
			const stats = createStatisticsCollector("jobJudge");
			stats.startCollection();

			const startTime = performance.now();
			let browser: puppeteer.Browser | undefined;
			let tempDir: string | undefined;
			let jobDB: JobDB | undefined;

			try {
				// Debug mode: scrape single URL
				if (argv.debugUrl) {
					log(
						"JobJudge",
						`Starting debug scrape for URL: ${argv.debugUrl}`,
						"info",
					);
					console.log("JobJudge: Starting debug scrape...");

					let page: puppeteer.Page;
					let jobData$: Observable<unknown>;

					try {
						log("JobJudge", "Launching browser...", "info");
						console.log("JobJudge: Launching browser...");
						browser = await puppeteer.launch({
							headless: argv.headless as boolean | "shell" | undefined,
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
						log("JobJudge", "Browser launched successfully", "info");
						console.log("JobJudge: Browser launched successfully");

						log("JobJudge", "Creating new page...", "info");
						console.log("JobJudge: Creating new page...");
						page = await browser.newPage();
						log("JobJudge", "Page created successfully", "info");
						console.log("JobJudge: Page created successfully");

						log("JobJudge", "Getting job description...", "info");
						console.log("JobJudge: Getting job description...");
						if (!argv.debugUrl) {
							throw new Error("Debug URL is required");
						}
						jobData$ = getJobDescription(page, { url: argv.debugUrl });
						log("JobJudge", "Job description observable created", "info");
						console.log("JobJudge: Job description observable created");
					} catch (error: unknown) {
						const errorTyped = error as unknown;
						log(
							"JobJudge",
							`Error during debug setup: ${(errorTyped as Error).message}`,
							"error",
						);
						console.error(
							`JobJudge: Error during debug setup: ${(errorTyped as Error).message}`,
						);
						throw error;
					}

					type JobDescriptionResult = {
						url: string;
						title: string;
						company: string;
						location: string;
						postedTime: string;
						applicants: string;
						salaryRange: string;
						seniorityLevel: string;
						employmentType: string;
						jobFunction: string;
						industries: string;
						descriptionText: string;
					};

					log("JobJudge", "Creating Promise to handle observable...", "info");
					console.log("JobJudge: Creating Promise to handle observable...");

					const jobData = await new Promise<JobDescriptionResult | null>(
						(resolve, reject) => {
							log(
								"JobJudge",
								"Inside Promise, subscribing to observable...",
								"info",
							);
							console.log(
								"JobJudge: Inside Promise, subscribing to observable...",
							);

							const subscription = jobData$.subscribe({
								next: (data) => {
									log("JobJudge", "Observable emitted data!", "info");
									console.log("JobJudge: Observable emitted data!");
									resolve(data as JobDescriptionResult);
									subscription.unsubscribe();
									log(
										"JobJudge",
										"Unsubscribed from observable after receiving data",
										"info",
									);
									console.log(
										"JobJudge: Unsubscribed from observable after receiving data",
									);
								},
								error: (err) => {
									log(
										"JobJudge",
										`Observable error: ${err instanceof Error ? err.message : String(err)}`,
										"error",
									);
									console.error(
										`JobJudge: Observable error: ${err instanceof Error ? err.message : String(err)}`,
									);
									reject(err);
									subscription.unsubscribe();
									log(
										"JobJudge",
										"Unsubscribed from observable after error",
										"info",
									);
									console.log(
										"JobJudge: Unsubscribed from observable after error",
									);
								},
								complete: () => {
									// In case the observable completes without emitting (e.g., empty)
									log(
										"JobJudge",
										"Observable completed without emitting data",
										"warn",
									);
									console.log(
										"JobJudge: Observable completed without emitting data",
									);
									resolve(null);
									log(
										"JobJudge",
										"Resolved Promise with null after completion",
										"info",
									);
									console.log(
										"JobJudge: Resolved Promise with null after completion",
									);
								},
							});

							log(
								"JobJudge",
								"Subscription created, waiting for observable to emit...",
								"info",
							);
							console.log(
								"JobJudge: Subscription created, waiting for observable to emit...",
							);
						},
					);

					log("JobJudge", "Promise resolved, checking jobData...", "info");
					console.log("JobJudge: Promise resolved, checking jobData...");

					if (jobData) {
						log("JobJudge", "Job data received, writing to file...", "info");
						console.log("JobJudge: Job data received, writing to file...");
						log(
							"JobJudge",
							`Scraped job data:\n${JSON.stringify(jobData, null, 2)}`,
							"info",
						);
						console.log("Scraped job data:", JSON.stringify(jobData, null, 2));

						// Display enhanced fields in a more readable format
						console.log("\nEnhanced Job Details:");
						console.log("--------------------");
						console.log(`Title: ${jobData.title}`);
						console.log(`Company: ${jobData.company}`);
						console.log(`Location: ${jobData.location}`);
						if (jobData.employmentType)
							console.log(`Employment Type: ${jobData.employmentType}`);
						if (jobData.seniorityLevel)
							console.log(`Seniority Level: ${jobData.seniorityLevel}`);
						if (jobData.jobFunction)
							console.log(`Job Function: ${jobData.jobFunction}`);
						if (jobData.industries)
							console.log(`Industries: ${jobData.industries}`);
						if (jobData.postedTime)
							console.log(`Posted Time: ${jobData.postedTime}`);
						if (jobData.applicants)
							console.log(`Applicants: ${jobData.applicants}`);
						if (jobData.salaryRange)
							console.log(`Salary Range: ${jobData.salaryRange}`);
						console.log("--------------------");

						try {
							const tempFilePath = path.join(
								process.cwd(),
								"debug_scrape_output.json",
							);
							log("JobJudge", `Writing to file: ${tempFilePath}`, "info");
							console.log(`JobJudge: Writing to file: ${tempFilePath}`);

							await fs.promises.writeFile(
								tempFilePath,
								JSON.stringify(jobData, null, 2),
								"utf-8",
							);
							log(
								"JobJudge",
								`Scraped data written to ${tempFilePath}`,
								"info",
							);
							console.log(`JobJudge: Scraped data written to ${tempFilePath}`);
						} catch (writeError: unknown) {
							log(
								"JobJudge",
								`Error writing to file: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
								"error",
							);
							console.error(
								`JobJudge: Error writing to file: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
							);
						}
					} else {
						log(
							"JobJudge",
							"Scraping completed but no job data was received.",
							"warn",
						);
						console.log(
							"JobJudge: Scraping completed but no job data was received.",
						);
					}

					// Exit after debug scrape
					log("JobJudge", "Debug scrape completed, cleaning up...", "info");
					console.log("JobJudge: Debug scrape completed, cleaning up...");

					try {
						log("JobJudge", "Closing file logging...", "info");
						console.log("JobJudge: Closing file logging...");
						await closeFileLogging();
						log("JobJudge", "File logging closed", "info");
						console.log("JobJudge: File logging closed");
					} catch (loggingError: unknown) {
						console.error(
							`JobJudge: Error closing file logging: ${loggingError instanceof Error ? loggingError.message : String(loggingError)}`,
						);
					}

					try {
						if (browser) {
							log("JobJudge", "Closing browser...", "info");
							console.log("JobJudge: Closing browser...");
							await browser.close();
							log("JobJudge", "Browser closed", "info");
							console.log("JobJudge: Browser closed");
						}
					} catch (browserError: unknown) {
						const browserErrorTyped = browserError as unknown;
						console.error(
							`JobJudge: Error closing browser: ${(browserErrorTyped as Error).message}`,
						);
					}

					log("JobJudge", "Exiting process...", "info");
					console.log("JobJudge: Exiting process...");
					process.exit(0);
				}
				// Normal jobJudge execution
				else {
					log("JobJudge", "Starting job evaluation command... ⚖️");

					const passDir = path.join(dataDirectory, "astroapply_eval_pass");
					const failDir = path.join(dataDirectory, "astroapply_eval_fail");
					const dupeDir = path.join(dataDirectory, "astroapply_eval_dupe");
					tempDir = path.join(dataDirectory, "temp_job_descriptions");

					// Initialize jobDB
					const jobDBConfig: JobDBConfig = {
						dbFilePath: path.join(dataDirectory, "jobDB.json"),
						defaultExpirationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
						enableJobDB: argv["use-jobdb"] ?? true,
					};

					log("JobJudge", "=== jobDB Initialization ===");
					log(
						"JobJudge",
						`Initializing jobDB with configuration: enabled=${jobDBConfig.enableJobDB}, path=${jobDBConfig.dbFilePath}, expiration=${jobDBConfig.defaultExpirationMs}ms`,
					);

					stats.incrementCounter("jobDB.initializationAttempts", 1);
					const jobDBInitTimer = stats.startTimer("jobDB.initialization");

					const jobDB = new JobDB(jobDBConfig);
					log("JobJudge", "Calling jobDB.initialize()...");
					await jobDB.initialize();
					log("JobJudge", "jobDB.initialize() completed");

					log("JobJudge", "Calling jobDB.load()...");
					await jobDB.load();
					log("JobJudge", "jobDB.load() completed successfully");
					stats.recordSuccess("jobDB.initialization");

					// Clean up expired entries from jobDB
					log("JobJudge", "Cleaning up expired entries from jobDB...");
					const expiredEntriesRemoved = await jobDB.cleanupExpired();
					stats.incrementCounter(
						"jobDB.expiredEntriesRemoved",
						expiredEntriesRemoved,
					);
					if (expiredEntriesRemoved > 0) {
						log(
							"JobJudge",
							`✅ Cleaned up ${expiredEntriesRemoved} expired entries from jobDB.`,
						);
					} else {
						log("JobJudge", "ℹ️ No expired entries to clean up in jobDB.");
					}

					// Log initial jobDB statistics
					const initialStats = jobDB.getStats();
					log(
						"JobJudge",
						`📊 Initial jobDB stats: ${initialStats.totalEntries} total entries, ${initialStats.expiredEntries} expired entries`,
					);
					stats.incrementCounter(
						"jobDB.initialEntries",
						initialStats.totalEntries,
					);
					stats.incrementCounter(
						"jobDB.expiredEntries",
						initialStats.expiredEntries,
					);
					stats.endTimer(jobDBInitTimer);
					log("JobJudge", "=== jobDB Initialization Complete ===");

					const passedJobs: JobInterface[] = [];
					let processedJobs: JobInterface[] = [];

					// Load all presets and the Veritas system prompt
					const allPresets = await loadPresets();
					const _veritasSystemPrompt = await loadVeritasSystemPrompt();

					// Determine effective preset
					const effectivePreset = getPreset(
						"jobJudge",
						argv.preset as string,
						allPresets,
					);
					if (!effectivePreset) {
						throw new Error(
							`Preset '${argv.preset}' not found for jobJudge command`,
						);
					}

					// Load external application data files for placeholders
					const _userDataDir = path.join(
						rootDirectory,
						"user_data",
					);
					const {
						resume: myResume,
						professionalTitle: _myProfessionalTitle,
						professionalSummary: _myProfessionalSummary,
						keySkills: _myKeySkills,
						testimonials: myTestimonials,
					} = await loadApplicationData();

					// Initialize LLM service using shared utility
					const llmInitTimer = stats.startTimer("llmService.initialization");
					initializeLLMService(
						effectivePreset,
						argv["api-key"] || process.env.OPENAI_API_KEY || "",
					);
					stats.endTimer(llmInitTimer);
					stats.recordSuccess("llmService.initialization");

					const resolvedInputPath = path.resolve(
						rootDirectory,
						argv["input-file"],
					);
					const evalMode = argv["eval-mode"];

					const logDirVal = String(
						(argv as Record<string, unknown>)["log-dir"] ??
							(argv as Record<string, unknown>).logDir,
					);
					const logFileVal = String(
						(argv as Record<string, unknown>)["log-file"] ??
							(argv as Record<string, unknown>).logFile,
					);
					const _streamLogFilePath = path.join(
						String(logDirVal),
						`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_${String(logFileVal)}`,
					);

					// Determine output directory path
					const _outputDirPath = path.resolve(
						rootDirectory,
						argv["output-file"],
					);
					if (argv["output-file"] === "./data/astroapply_eval_") {
						// Default output directories are already created, no timestamp needed for directory
					}

					log("JobJudge", "Ensuring output directories exist... ");
					const directoryCreationTimer = stats.startTimer("directoryCreation");

					await Promise.all([
						fs.promises.mkdir(passDir, { recursive: true }),
						fs.promises.mkdir(failDir, { recursive: true }),
						fs.promises.mkdir(dupeDir, { recursive: true }),
						fs.promises.mkdir(tempDir, { recursive: true }),
					]);
					log("JobJudge", "Output directories are ready. ");

					stats.incrementCounter("directoriesCreated", 4);
					stats.endTimer(directoryCreationTimer);

					stats.incrementCounter("filesProcessed", 1);
					log(
						"JobJudge",
						`Reading processed job data from: ${resolvedInputPath} `,
					);

					// Handle input file(s)
					if (argv["input-file"] === "./data/scraped_jobs_*.json") {
						const matchingFiles = await findProcessedJobFiles(
							argv["input-file"],
						);
						if (matchingFiles.length === 0) {
							throw new Error(
								`No files matching pattern "${argv["input-file"]}" found.`,
							);
						}
						log(
							"JobJudge",
							`Found ${matchingFiles.length} files matching pattern.`,
						);

						for (const filePath of matchingFiles) {
							log("JobJudge", `Processing file: ${filePath}`);
							const fileContent = await fs.promises.readFile(filePath, "utf-8");
							let jobs: JobInterface[] = [];

							// Handle both JSON array format and newline-separated JSON objects
							try {
								// First try to parse as JSON array
								const jobData = JSON.parse(fileContent);
								if (Array.isArray(jobData)) {
									jobs = jobData;
								} else if (jobData && typeof jobData === "object") {
									const jobWithId = { ...jobData };
									if (!jobWithId.id) {
										const filenameMatch = path
											.basename(filePath)
											.match(/^processed_jobs_(\d+)\.json$/);
										if (filenameMatch) {
											jobWithId.id = filenameMatch[1];
										}
									}
									jobs = [jobWithId];
								} else {
									throw new Error(
										`File ${filePath} does not contain a valid job object or array.`,
									);
								}
							} catch (_parseError) {
								// If JSON array parsing fails, try newline-separated JSON objects
								log(
									"JobJudge",
									`Failed to parse as JSON array, trying newline-separated format...`,
									"warn",
								);
								const lines = fileContent
									.split("\n")
									.filter((line) => line.trim());
								let currentJobJson = "";

								for (const line of lines) {
									currentJobJson += `${line}\n`;

									// Try to parse as complete JSON object
									try {
										const jobData = JSON.parse(currentJobJson);
										if (jobData && typeof jobData === "object") {
											const jobWithId = { ...jobData };

											// Extract job ID from URL if not present
											if (!jobWithId.id && jobWithId.url) {
												// Try to extract ID using the specific LinkedIn pattern: -(\d+)\?
												const linkedinIdMatch = jobWithId.url.match(/-(\d+)\?/);
												if (linkedinIdMatch) {
													jobWithId.id = linkedinIdMatch[1];
												} else {
													// Fallback to other URL patterns
													const urlMatch = jobWithId.url.match(
														/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/,
													);
													if (urlMatch) {
														jobWithId.id = urlMatch[1];
													} else {
														const fallbackMatch = jobWithId.url.match(
															/\/jobs\/view\/[^/]+\/(\d+)/,
														);
														if (fallbackMatch) {
															jobWithId.id = fallbackMatch[1];
														}
													}
												}
											}

											jobs.push(jobWithId);
											currentJobJson = ""; // Reset for next job
										}
									} catch (_lineError) {}
								}
							}

							processedJobs.push(...jobs);
							log(
								"JobJudge",
								`Loaded ${jobs.length} jobs from ${path.basename(filePath)}`,
							);
						}
					} else {
						// Existing logic for single file or directory
						const stats = await fs.promises.stat(resolvedInputPath);
						if (stats.isDirectory()) {
							const files = await fs.promises.readdir(resolvedInputPath);
							const jsonFiles = files.filter((file) => file.endsWith(".json"));
							if (jsonFiles.length === 0) {
								throw new Error(
									`No JSON files found in directory: ${resolvedInputPath}`,
								);
							}
							log(
								"JobJudge",
								`Found ${jsonFiles.length} JSON files in directory.`,
							);
							for (const file of jsonFiles) {
								const filePath = path.join(resolvedInputPath, file);
								log("JobJudge", `Processing file: ${filePath}`);
								const fileContent = await fs.promises.readFile(
									filePath,
									"utf-8",
								);
								let jobs: JobInterface[] = [];

								// Handle both JSON array format and newline-separated JSON objects
								try {
									// First try to parse as JSON array
									const jobData = JSON.parse(fileContent);
									if (Array.isArray(jobData)) {
										jobs = jobData;
									} else if (jobData && typeof jobData === "object") {
										const jobWithId = { ...jobData };
										if (!jobWithId.id) {
											const filenameMatch = file.match(/^job_(\d+)\.json$/);
											if (filenameMatch) {
												jobWithId.id = filenameMatch[1];
											}
										}
										jobs = [jobWithId];
									} else {
										throw new Error(
											`File ${filePath} does not contain a valid job object or array.`,
										);
									}
								} catch (_parseError) {
									// If JSON array parsing fails, try newline-separated JSON objects
									log(
										"JobJudge",
										`Failed to parse as JSON array, trying newline-separated format...`,
										"warn",
									);
									const lines = fileContent
										.split("\n")
										.filter((line) => line.trim());
									let currentJobJson = "";

									for (const line of lines) {
										currentJobJson += `${line}\n`;

										// Try to parse as complete JSON object
										try {
											const jobData = JSON.parse(currentJobJson);
											if (jobData && typeof jobData === "object") {
												const jobWithId = { ...jobData };

												// Extract job ID from URL if not present
												if (!jobWithId.id && jobWithId.url) {
													// Try to extract ID using the specific LinkedIn pattern: -(\d+)\?
													const linkedinIdMatch =
														jobWithId.url.match(/-(\d+)\?/);
													if (linkedinIdMatch) {
														jobWithId.id = linkedinIdMatch[1];
														console.log(
															`✅ Extracted LinkedIn job ID: ${jobWithId.id} from URL`,
														);
													} else {
														// Fallback to other URL patterns
														const urlMatch = jobWithId.url.match(
															/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/,
														);
														if (urlMatch) {
															jobWithId.id = urlMatch[1];
														} else {
															const fallbackMatch = jobWithId.url.match(
																/\/jobs\/view\/[^/]+\/(\d+)/,
															);
															if (fallbackMatch) {
																jobWithId.id = fallbackMatch[1];
															}
														}
													}
												}

												jobs.push(jobWithId);
												currentJobJson = ""; // Reset for next job
											}
										} catch (_lineError) {}
									}
								}

								processedJobs.push(...jobs);
								log("JobJudge", `Loaded ${jobs.length} jobs from ${file}`);
							}
						} else {
							const fileContent = await fs.promises.readFile(
								resolvedInputPath,
								"utf-8",
							);
							let jobs: JobInterface[] = [];

							// Handle both JSON array format and newline-separated JSON objects
							try {
								// First try to parse as JSON array
								const jobData = JSON.parse(fileContent);
								if (Array.isArray(jobData)) {
									jobs = jobData;
								} else if (jobData && typeof jobData === "object") {
									const jobWithId = { ...jobData };
									if (!jobWithId.id) {
										const filenameMatch = path
											.basename(resolvedInputPath)
											.match(/^job_(\d+)\.json$/);
										if (filenameMatch) {
											jobWithId.id = filenameMatch[1];
										}
									}
									jobs = [jobWithId];
								} else {
									throw new Error(
										`Input file ${resolvedInputPath} does not contain a valid job object or array.`,
									);
								}
							} catch (_parseError) {
								// If JSON array parsing fails, try newline-separated JSON objects
								log(
									"JobJudge",
									`Failed to parse as JSON array, trying newline-separated format...`,
									"warn",
								);
								const lines = fileContent
									.split("\n")
									.filter((line) => line.trim());
								let currentJobJson = "";

								for (const line of lines) {
									currentJobJson += `${line}\n`;

									// Try to parse as complete JSON object
									try {
										const jobData = JSON.parse(currentJobJson);
										if (jobData && typeof jobData === "object") {
											const jobWithId = { ...jobData };

											// Extract job ID from URL if not present
											if (!jobWithId.id && jobWithId.url) {
												// Try to extract ID using the specific LinkedIn pattern: -(\d+)\?
												const linkedinIdMatch = jobWithId.url.match(/-(\d+)\?/);
												if (linkedinIdMatch) {
													jobWithId.id = linkedinIdMatch[1];
												} else {
													// Fallback to other URL patterns
													const urlMatch = jobWithId.url.match(
														/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/,
													);
													if (urlMatch) {
														jobWithId.id = urlMatch[1];
													} else {
														const fallbackMatch = jobWithId.url.match(
															/\/jobs\/view\/[^/]+\/(\d+)/,
														);
														if (fallbackMatch) {
															jobWithId.id = fallbackMatch[1];
														}
													}
												}
											}

											jobs.push(jobWithId);
											currentJobJson = ""; // Reset for next job
										}
									} catch (_lineError) {}
								}
							}

							processedJobs = jobs;
						}
					}
					stats.incrementCounter("jobsLoaded", processedJobs.length);

					log(
						"JobJudge",
						`Successfully read ${processedJobs.length} processed job records. `,
					);

					// Note: processedJobIds is no longer used as jobDB handles duplicate detection

					log(
						"JobJudge",
						`Starting evaluation of ${processedJobs.length} jobs... `,
					);
					stats.incrementCounter("jobsToEvaluate", processedJobs.length);
					stats.incrementCounter("data.recordsProcessed", processedJobs.length);

					for (const job of processedJobs) {
						try {
							// Generate job ID if not present (extract from URL)
							let jobId = job.id;
							if (!jobId && job.url) {
								// Try to extract ID from URL pattern: /jobs/view/.../ID?position= or /jobs/view/.../ID&position=
								const urlMatch = job.url.match(
									/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/,
								);
								if (urlMatch) {
									jobId = urlMatch[1];
								} else {
									// Fallback to other URL patterns
									const fallbackMatch = job.url.match(
										/\/jobs\/view\/[^/]+\/(\d+)/,
									);
									if (fallbackMatch) {
										jobId = fallbackMatch[1];
									} else {
										// Use URL hash as final fallback
										import("node:crypto").then((crypto) => {
											jobId = crypto
												.createHash("md5")
												.update(job.url)
												.digest("hex")
												.substring(0, 8);
										});
									}
								}
							}

							// Check if job is already processed using jobDB (company + title matching)
							log(
								"JobJudge",
								`🔍 Checking if job "${job.title}" at ${job.company} (ID: ${jobId}) is already processed...`,
							);
							const isMatched = jobDB.isJobMatched(job);
							if (isMatched) {
								log(
									"JobJudge",
									`⏭️ Skipping duplicate job: ${job.title} at ${job.company} (matched in jobDB)`,
									"info",
								);
								log(
									"JobJudge",
									`✅ Job "${job.title}" at ${job.company} already processed within timeframe. Moving to duplicates. `,
									"info",
								);
								const existingDescriptionPath = path.join(
									dataDirectory,
									`linkedin_job_${jobId}.txt`,
								);
								try {
									await fs.promises.access(
										existingDescriptionPath,
										fs.constants.F_OK,
									);
									await fs.promises.rename(
										existingDescriptionPath,
										path.join(dupeDir, `${jobId}.html`),
									);
									log(
										"JobJudge",
										`Moved existing description file for ${jobId} to duplicates. `,
									);
								} catch (error: unknown) {
									const errorTyped = error as unknown;
									if ((errorTyped as { code?: string }).code === "ENOENT") {
										log(
											"JobJudge",
											`Job ${jobId} is a duplicate and no existing description file was found to move. `,
											"warn",
										);
									} else {
										log(
											"JobJudge",
											`Error checking or moving existing description file for ${jobId}: ${(errorTyped as Error).message} `,
											"error",
										);
									}
								}
								continue;
							}
							log(
								"JobJudge",
								`🆕 Job "${job.title}" at ${job.company} is new, processing...`,
							);

							if (!job.descriptionText) {
								log(
									"JobJudge",
									`Job ${jobId} ("${job.title}") has no description text. Skipping evaluation. `,
									"warn",
								);
								// Add to jobDB even if no description to avoid reprocessing
								await jobDB.addJob(job, jobId);
								continue;
							}

							log(
								"JobJudge",
								`Evaluating job ${jobId} ("${job.title}") with ${evalMode === 3 ? "jdd-g41m" : "jdd-gf2.0t"} mode... `,
							);

							// Use TypeScript native evaluation instead of Python script
							let isPassVerdict = false;
							let resultArray: z.infer<typeof JobAnalysisResultsArraySchema> =
								[];
							let parsingError: string | null = null;
							let retryCount = 0;
							const maxRetries = 3;

							// Prepare placeholder data for prompt templates - match the template expectations
							const placeholderData = {
								targJD: JSON.stringify(job, null, 2),
								myResume: myResume,
								myTestimonials: myTestimonials,
							};

							// Load user message content from preset's prompt template
							const userMessageContent = await loadAndReplacePromptTemplate(
								(effectivePreset as { promptTemplate: string }).promptTemplate,
								placeholderData as Record<string, string>,
							);

							// Start LLM evaluation timer
							const llmEvalTimer = stats.startTimer("llmEvaluation");
							stats.incrementCounter("api.totalCalls", 1);

							// Use the refactored LLM evaluation function
							const evaluationResult = await evaluateJobWithLLM(
								job,
								effectivePreset,
								argv,
								evalMode as number,
								placeholderData as Record<string, string>,
								userMessageContent,
							);

							isPassVerdict = evaluationResult.isPassVerdict;
							resultArray = evaluationResult.resultArray;
							parsingError = evaluationResult.parsingError;
							retryCount = evaluationResult.retryCount;

							// End LLM evaluation timer
							stats.endTimer(llmEvalTimer);
							stats.incrementCounter("api.successfulCalls", 1);
							stats.recordHistogram(
								"api.responseTime",
								stats.getSummary().performance.operationTimes.llmEvaluation,
							);

							// Track LLM evaluation statistics
							stats.incrementCounter("llmEvaluations", 1);
							if (isPassVerdict) {
								stats.incrementCounter("jobsPassed", 1);
								stats.recordSuccess("llmEvaluation");
								log(
									"JobJudge",
									`Job ${jobId} judged as 'pass' - evaluation completed successfully`,
									"info",
									{
										jobId,
										jobTitle: job.title,
										company: job.company,
										evaluationResult: "pass",
										retryCount,
									},
								);
							} else {
								stats.incrementCounter("jobsFailed", 1);
								log(
									"JobJudge",
									`Job ${jobId} judged as 'fail' - evaluation completed successfully`,
									"info",
									{
										jobId,
										jobTitle: job.title,
										company: job.company,
										evaluationResult: "fail",
										retryCount,
									},
								);
							}

							if (parsingError) {
								stats.incrementCounter("parsingErrors", 1);
								stats.recordError(new Error(parsingError));
							}

							if (retryCount > 0) {
								stats.incrementCounter("llmRetries", retryCount);
								if (retryCount >= 3) {
									stats.incrementCounter("llmMaxRetriesReached", 1);
								}
							}

							// Check if fallback was used by looking at the evaluation result
							if (parsingError || retryCount >= 3) {
								stats.incrementCounter("fallbackEvaluations", 1);
							}

							// Write job description with evaluation result
							const jobWithResult = {
								...job,
								evaluationResult: {
									mode: evalMode,
									isPass: isPassVerdict,
									timestamp: new Date().toISOString(),
									parsingError: parsingError,
									fallbackUsed: !!parsingError,
									analysisResult:
										resultArray.length > 0 ? resultArray[0] : null,
									retryCount: retryCount,
									maxRetries: maxRetries,
									retrySuccess: retryCount < maxRetries,
								},
							};

							const jdFileName = `${jobId}.json`;
							const jdFilePath = path.join(tempDir, jdFileName);
							await fs.promises.writeFile(
								jdFilePath,
								JSON.stringify(jobWithResult, null, 2),
							);

							if (isPassVerdict) {
								log(
									"JobJudge",
									`Job ${jobId} passed evaluation! Moving to passed directory. `,
								);
								await fs.promises.rename(
									jdFilePath,
									path.join(passDir, jdFileName),
								);
								passedJobs.push(job);
							} else {
								log(
									"JobJudge",
									`Job ${jobId} failed evaluation. Moving to failed directory. `,
								);
								await fs.promises.rename(
									jdFilePath,
									path.join(failDir, jdFileName),
								);
							}

							// Add job to jobDB to mark as processed
							log("JobJudge", `💾 Adding job ID ${jobId} to jobDB...`);
							log(
								"JobJudge",
								`📋 Job details: title="${job.title}", company="${job.company}", url="${job.url}"`,
							);
							try {
								await jobDB.addJob(job, jobId);
								log(
									"JobJudge",
									`✅ Job ID ${jobId} logged as processed in jobDB. `,
								);
								stats.incrementCounter("jobsAddedToJobDB", 1);
							} catch (addJobError: unknown) {
								log(
									"JobJudge",
									`❌ Error adding job ID ${jobId} to jobDB: ${addJobError instanceof Error ? addJobError.message : String(addJobError)}`,
									"error",
								);
								stats.recordError(
									addJobError instanceof Error
										? addJobError
										: new Error(String(addJobError)),
								);
								// Continue processing even if jobDB add fails
							}

							// Sleep between job evaluations if sleep option is specified
							if (argv.sleep && argv.sleep > 0) {
								log(
									"JobJudge",
									`Sleeping for ${argv.sleep} seconds before next job evaluation...`,
								);
								await new Promise((resolve) =>
									setTimeout(resolve, (argv.sleep as number) * 1000),
								);
							}
						} catch (jobError: unknown) {
							const jobErrorTyped = jobError as unknown;
							const jobId = job.id || "unknown";
							log(
								"JobJudge",
								`❌ Error processing job ${jobId} ("${job.title}"): ${(jobErrorTyped as Error).message}`,
								"error",
							);
							log(
								"JobJudge",
								`⚠️ Continuing with next job to ensure complete processing...`,
								"warn",
							);

							// Record the error in statistics
							stats.recordError(
								jobErrorTyped instanceof Error
									? jobErrorTyped
									: new Error(String(jobErrorTyped)),
							);

							// Add the failed job to jobDB to avoid reprocessing
							try {
								await jobDB.addJob(job, jobId);
								log(
									"JobJudge",
									`✅ Failed job ${jobId} logged as processed in jobDB to prevent reprocessing. `,
								);
							} catch (addJobError: unknown) {
								log(
									"JobJudge",
									`❌ Error adding failed job ${jobId} to jobDB: ${addJobError instanceof Error ? addJobError.message : String(addJobError)}`,
									"error",
								);
							}
						}
					}
					// Count parsing failures and fallback usage
					let parsingFailures = 0;
					let fallbackUsage = 0;
					const totalJobsEvaluated = processedJobs.length;
					const fileProcessingTimer = stats.startTimer("fileProcessing");

					// Read back all evaluated jobs to count parsing issues
					try {
						const allEvaluatedFiles = [
							...fs.readdirSync(passDir).filter((f) => f.endsWith(".json")),
							...fs.readdirSync(failDir).filter((f) => f.endsWith(".json")),
						];
						stats.incrementCounter(
							"filesReadForAnalysis",
							allEvaluatedFiles.length,
						);

						for (const filename of allEvaluatedFiles) {
							const filePath = filename.includes("astroapply_eval_pass")
								? path.join(passDir, filename)
								: path.join(failDir, filename);

							try {
								const fileContent = await fs.promises.readFile(
									filePath,
									"utf-8",
								);
								const jobData = JSON.parse(fileContent);
								if (jobData.evaluationResult?.parsingError) {
									parsingFailures++;
								}
								if (jobData.evaluationResult?.fallbackUsed) {
									fallbackUsage++;
								}
							} catch (_error) {
								// Skip files that can't be read
							}
						}
					} catch (_error) {
						// Skip directory reading if it fails
					}

					// Get jobDB statistics
					const jobDBStats = jobDB.getStats();

					stats.endTimer(fileProcessingTimer);

					log("JobJudge", "\n📊 === Job Evaluation Report === ");
					log("JobJudge", `📈 Total Jobs Evaluated: ${totalJobsEvaluated}`);
					log("JobJudge", `✅ Jobs Passed: ${passedJobs.length}`);
					log(
						"JobJudge",
						`❌ Jobs Failed: ${totalJobsEvaluated - passedJobs.length}`,
					);
					log("JobJudge", `🔍 Parsing Failures: ${parsingFailures}`);
					log("JobJudge", `🔄 Fallback Evaluations Used: ${fallbackUsage}`);
					log(
						"JobJudge",
						`📊 Parsing Success Rate: ${
							totalJobsEvaluated > 0
								? `${Math.round(
										((totalJobsEvaluated - parsingFailures) /
											totalJobsEvaluated) *
											100,
									)}%`
								: "0%"
						}`,
					);
					log("JobJudge", `💾 JobDB Entries: ${jobDBStats.totalEntries}`);
					log(
						"JobJudge",
						`🧹 Expired Entries Cleaned: ${jobDBStats.expiredEntries}`,
					);

					if (passedJobs.length === 0) {
						log("JobJudge", "No jobs passed the evaluation in this run. ");
					} else {
						const reportDir = path.join(dataDirectory, "job_judge_reports");
						await fs.promises.mkdir(reportDir, { recursive: true });
						const reportFileName = `job_judge_report_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.md`;
						const reportFilePath = path.join(reportDir, reportFileName);

						let reportContent = `# Job Judge Evaluation Report\n\n`;
						reportContent += `**Date:** ${formatDate(new Date(), "yyyy-MM-dd HH:mm:ss")}\n\n`;
						const jobsSkipped = processedJobs.filter((job) =>
							jobDB.isJobMatched(job),
						).length;
						reportContent += `**Total Jobs Evaluated (in this run):** ${processedJobs.length - jobsSkipped}\n`;
						reportContent += `**Jobs Skipped (already processed):** ${jobsSkipped}\n`;
						reportContent += `**Jobs Passed Evaluation:** ${passedJobs.length}\n\n`;
						reportContent += `**Evaluation Mode Used:** ${evalMode}\n\n`;

						if (passedJobs.length > 0) {
							reportContent += `## Passed Jobs\n\n`;
							passedJobs.forEach((job) => {
								reportContent += `### ${job.title}\n\n`;
								reportContent += `- **Company:** ${job.company}\n`;
								const salary =
									job.salaryRange ||
									(job.salaryMin > 0 || job.salaryMax > 0
										? `${job.salaryCurrency} ${job.salaryMin > 0 ? job.salaryMin.toLocaleString() : ""}${job.salaryMin > 0 && job.salaryMax > 0 ? " - " : ""}${job.salaryMax > 0 ? job.salaryMax.toLocaleString() : ""}`
										: "Not specified");
								reportContent += `- **Compensation:** ${salary}\n`;
								const location = job.remoteOk
									? `${job.location} (Remote OK)`
									: job.location;
								reportContent += `- **Location:** ${location}\n`;

								// Add the new fields we're extracting from LinkedIn
								if (job.employmentType) {
									reportContent += `- **Employment Type:** ${job.employmentType}\n`;
								}
								if (job.seniorityLevel) {
									reportContent += `- **Seniority Level:** ${job.seniorityLevel}\n`;
								}
								if (job.jobFunction) {
									reportContent += `- **Job Function:** ${job.jobFunction}\n`;
								}
								if (job.industries) {
									reportContent += `- **Industries:** ${job.industries}\n`;
								}
								if (job.postedDate) {
									const postedDate = new Date(job.postedDate);
									const formattedDate = Number.isNaN(postedDate.getTime())
										? job.postedDate
										: formatDate(postedDate, "yyyy-MM-dd");
									reportContent += `- **Posted Date:** ${formattedDate}\n`;
								}
								if (job.applicants) {
									reportContent += `- **Applicants:** ${job.applicants}\n`;
								}

								reportContent += `- **URL:** [${job.url}](${job.url})\n`;
								reportContent += `\n`;
							});

							reportContent += `## Passed Job URLs\n\n`;
							passedJobs.forEach((job) => {
								reportContent += `- [${job.title} at ${job.company}](${job.url})\n`;
							});
						} else {
							reportContent += "No jobs passed the evaluation in this run.\n";
						}

						await fs.promises.writeFile(reportFilePath, reportContent, "utf-8");
						log(
							"JobJudge",
							`Comprehensive Markdown report saved to: ${reportFilePath} `,
						);

						passedJobs.forEach((job) => {
							log("JobJudge", `Title: ${job.title}`);
							log("JobJudge", `Company: ${job.company}`);
							const salary =
								job.salaryRange ||
								(job.salaryMin > 0 || job.salaryMax > 0
									? `${job.salaryCurrency} ${job.salaryMin > 0 ? job.salaryMin.toLocaleString() : ""}${job.salaryMin > 0 && job.salaryMax > 0 ? " - " : ""}${job.salaryMax > 0 ? job.salaryMax.toLocaleString() : ""}`
									: "Not specified");
							log("JobJudge", `Compensation: ${salary}`);
							const location = job.remoteOk
								? `${job.location} (Remote OK)`
								: job.location;
							log("JobJudge", `Location: ${location}`);
							log("JobJudge", `URL: ${job.url}`);
							log("JobJudge", "-------------------------------------------");
						});
					}
					log("JobJudge", "--- End of Report ---");

					const endTime = performance.now();
					log(
						"JobJudge",
						`JobJudge command finished in ${formatDuration(endTime - startTime)}. `,
					);

					// End statistics collection and export final results
					stats.endCollection();
					const finalStats = stats.getSummary();

					log("JobJudge", "\n📊 === Final Statistics Report === ");
					log("JobJudge", `📈 Total Jobs Evaluated: ${totalJobsEvaluated}`);
					log("JobJudge", `✅ Jobs Passed: ${passedJobs.length}`);
					log(
						"JobJudge",
						`❌ Jobs Failed: ${totalJobsEvaluated - passedJobs.length}`,
					);
					log("JobJudge", `🔄 LLM Retries: ${finalStats.api.retries}`);
					log(
						"JobJudge",
						`🔍 Parsing Errors: ${finalStats.errors.byCategory.parsing || 0}`,
					);
					log("JobJudge", `💾 JobDB Entries: ${jobDBStats.totalEntries}`);

					// Export statistics to file
					const statsDir = path.join(dataDirectory, "statistics");
					await fs.promises.mkdir(statsDir, { recursive: true });
					const statsFileName = `jobJudge_stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`;
					const statsFilePath = path.join(statsDir, statsFileName);

					await fs.promises.writeFile(
						statsFilePath,
						stats.export("json"),
						"utf-8",
					);
					log(
						"JobJudge",
						`📊 Detailed statistics exported to: ${statsFilePath}`,
					);
				}
			} catch (error: unknown) {
				const errorTyped = error as unknown;
				log(
					"JobJudge",
					`An error occurred during job evaluation: ${(errorTyped as Error).message} `,
					"error",
				);
				const endTime = performance.now();
				log(
					"JobJudge",
					`JobJudge command failed after ${formatDuration(endTime - startTime)}. `,
					"error",
				);
			} finally {
				log("JobJudge", "Starting cleanup sequence...");

				try {
					// First perform cleanup of browser and temp directories
					log(
						"JobJudge",
						"Performing command cleanup (browser, temp directories)...",
					);
					await performCommandCleanup(browser, tempDir);
					log("JobJudge", "Command cleanup completed successfully");
				} catch (cleanupError: unknown) {
					log(
						"JobJudge",
						`Error during command cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
						"error",
					);
				}

				// Finally, close jobDB to save changes (this should be the last operation)
				if (jobDB) {
					log("JobJudge", "💾 Closing jobDB to save changes...");
					try {
						await jobDB.close();
						log("JobJudge", "✅ jobDB closed successfully");
					} catch (jobDBError: unknown) {
						log(
							"JobJudge",
							`❌ Error closing jobDB: ${jobDBError instanceof Error ? jobDBError.message : String(jobDBError)}`,
							"error",
						);
						// Don't throw - we want to ensure the process can exit
					}
				}

				log("JobJudge", "Cleanup sequence completed");
			}
		},
	});
};

/**
 * Extracts job ID from a single job object
 */
function _extractJobIdFromJob(job: JobInterface): string {
	if (job.id) {
		return job.id;
	}

	if (job.url) {
		// Try to extract ID using the specific LinkedIn pattern: -(\d+)\?
		const linkedinIdMatch = job.url.match(/-(\d+)\?/);
		if (linkedinIdMatch) {
			return linkedinIdMatch[1];
		}

		// Try to extract ID from URL pattern: /jobs/view/.../ID?position= or /jobs/view/.../ID&position=
		const urlMatch = job.url.match(/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/);
		if (urlMatch) {
			return urlMatch[1];
		}

		// Fallback to other URL patterns
		const fallbackMatch = job.url.match(/\/jobs\/view\/[^/]+\/(\d+)/);
		if (fallbackMatch) {
			return fallbackMatch[1];
		}

		// Use URL hash as final fallback
		return crypto
			.createHash("md5")
			.update(job.url)
			.digest("hex")
			.substring(0, 8);
	}

	// No URL available, generate from title
	return crypto
		.createHash("md5")
		.update(job.title || "unknown")
		.digest("hex")
		.substring(0, 8);
}

/**
 * Processes a single file and returns job data
 */
async function processJobFile(
	filePath: string,
	filename?: string,
): Promise<JobInterface[]> {
	log("JobJudge", `Processing file: ${filePath}`);
	const fileContent = await fs.promises.readFile(filePath, "utf-8");
	const jobs = await parseJobsFromFile(filePath, fileContent, filename);
	log("JobJudge", `Loaded ${jobs.length} jobs from ${path.basename(filePath)}`);
	return jobs;
}

/**
 * Processes all job files based on input pattern or path
 */
async function _processAllJobFiles(
	inputFile: string,
	rootDirectory: string,
): Promise<JobInterface[]> {
	const resolvedInputPath = path.resolve(rootDirectory, inputFile);
	let processedJobs: JobInterface[] = [];

	// Handle input file(s)
	if (inputFile === "./data/scraped_jobs_*.json") {
		const matchingFiles = await findProcessedJobFiles(inputFile);
		if (matchingFiles.length === 0) {
			throw new Error(`No files matching pattern "${inputFile}" found.`);
		}
		log("JobJudge", `Found ${matchingFiles.length} files matching pattern.`);

		for (const filePath of matchingFiles) {
			const jobs = await processJobFile(filePath, path.basename(filePath));
			processedJobs.push(...jobs);
		}
	} else {
		// Existing logic for single file or directory
		const stats = await fs.promises.stat(resolvedInputPath);
		if (stats.isDirectory()) {
			const files = await fs.promises.readdir(resolvedInputPath);
			const jsonFiles = files.filter((file) => file.endsWith(".json"));
			if (jsonFiles.length === 0) {
				throw new Error(
					`No JSON files found in directory: ${resolvedInputPath}`,
				);
			}
			log("JobJudge", `Found ${jsonFiles.length} JSON files in directory.`);
			for (const file of jsonFiles) {
				const filePath = path.join(resolvedInputPath, file);
				const jobs = await processJobFile(filePath, file);
				processedJobs.push(...jobs);
			}
		} else {
			const jobs = await processJobFile(
				resolvedInputPath,
				path.basename(resolvedInputPath),
			);
			processedJobs = jobs;
		}
	}

	return processedJobs;
}

/**
 * Handles duplicate job processing
 */
async function _handleDuplicateJob(
	job: JobInterface,
	jobId: string,
	dupeDir: string,
	logFile: string,
): Promise<void> {
	log(
		"JobJudge",
		`Job ${jobId} ("${job.title}") already processed. Moving to duplicates. `,
		"info",
	);
	const existingDescriptionPath = path.join(
		dataDirectory,
		`linkedin_job_${jobId}.txt`,
	);
	try {
		await fs.promises.access(existingDescriptionPath, fs.constants.F_OK);
		await fs.promises.rename(
			existingDescriptionPath,
			path.join(dupeDir, `${jobId}.html`),
		);
		log(
			"JobJudge",
			`Moved existing description file for ${jobId} to duplicates. `,
		);
	} catch (error: unknown) {
		const errorTyped = error as unknown;
		if ((errorTyped as { code?: string }).code === "ENOENT") {
			log(
				"JobJudge",
				`Job ${jobId} is a duplicate and no existing description file was found to move. `,
				"warn",
			);
		} else {
			log(
				"JobJudge",
				`Error checking or moving existing description file for ${jobId}: ${(errorTyped as Error).message} `,
				"error",
			);
		}
	}
	await fs.promises.appendFile(logFile, `${jobId}\n`, "utf-8");
}

/**
 * Handles jobs with missing descriptions
 */
async function _handleJobWithoutDescription(
	job: JobInterface,
	jobId: string,
	logFile: string,
): Promise<void> {
	log(
		"JobJudge",
		`Job ${jobId} ("${job.title}") has no description text. Skipping evaluation. `,
		"warn",
	);
	await fs.promises.appendFile(logFile, `${jobId}\n`, "utf-8");
}

/**
 * Processes a single job and returns evaluation result
 */
async function _processSingleJob(
	job: JobInterface,
	jobId: string,
	effectivePreset: unknown,
	argv: Arguments<GlobalArgs & JobJudgeArgs>,
	evalMode: number,
	placeholderData: unknown,
): Promise<{
	isPassVerdict: boolean;
	resultArray: z.infer<typeof JobAnalysisResultsArraySchema>;
	parsingError: string | null;
	retryCount: number;
}> {
	log(
		"JobJudge",
		`Evaluating job ${jobId} ("${job.title}") with ${evalMode === 3 ? "jdd-g41m" : "jdd-gf2.0t"} mode... `,
	);

	// Load user message content from preset's prompt template
	const userMessageContent = await loadAndReplacePromptTemplate(
		(effectivePreset as { promptTemplate: string }).promptTemplate,
		placeholderData as Record<string, string>,
	);

	// Use the refactored LLM evaluation function
	const evaluationResult = await evaluateJobWithLLM(
		job,
		effectivePreset,
		argv,
		evalMode as number,
		placeholderData as Record<string, string>,
		userMessageContent,
	);

	return evaluationResult;
}
