import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Argv } from "yargs";
import { z } from "zod";
import { type LLMRequest, llmService } from "../llmService";
import type { JobInterface } from "../models";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} from "../presets";
import { createStatisticsCollector } from "../statistics";
import {
	type GlobalArgs,
	getPreset,
	type JobClothArgs,
	type Preset,
} from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";

/**
 * Sanitize and validate file paths to prevent directory traversal attacks
 * @param filePath File path to validate
 * @returns Sanitized and validated file path
 */
function _sanitizeFilePath(filePath: string): string {
	if (!filePath || typeof filePath !== "string") {
		throw new Error("Invalid file path");
	}

	// Remove any path traversal attempts
	const sanitized = filePath
		.replace(/../g, "") // Remove parent directory references
		.replace(/[/]+/g, path.sep) // Normalize separators
		.replace(/^[/]+/, "") // Remove leading separators
		.replace(/^[/]+/, "") // Remove leading separators
		.replace(/[/]+$/, ""); // Remove trailing separators

	// Resolve to absolute path and check if it's within the project directory
	const absolutePath = path.resolve(sanitized);
	const rootDirectory = path.resolve(__dirname, "..", "..");

	if (!absolutePath.startsWith(rootDirectory)) {
		throw new Error("Access to file outside project directory is not allowed");
	}

	return absolutePath;
}

/**
 * Validate API key format (basic validation)
 * @param apiKey API key to validate
 * @returns True if valid format, false otherwise
 */
function _validateApiKey(apiKey: string): boolean {
	if (!apiKey || typeof apiKey !== "string") {
		return false;
	}

	// Basic validation - should be reasonable length and not contain obvious patterns
	if (apiKey.length < 10 || apiKey.length > 100) {
		return false;
	}

	// Check for common test patterns
	const testPatterns = [/sk-test/i, /test_/i, /demo/i, /example/i];

	if (testPatterns.some((pattern) => pattern.test(apiKey))) {
		return false;
	}

	return true;
}

/**
 * Validate URL format
 * @param url URL to validate
 * @returns True if valid URL, false otherwise
 */
function _validateUrl(url: string): boolean {
	if (!url || typeof url !== "string") {
		return false;
	}

	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

// Zod schemas
const JobAnalysisResultSchema = z.object({
	jobTitle: z.string(),
	isVeryHighlyAligned: z.boolean().optional().default(false), // Make optional and default to false
	rationale: z.string().optional().default(""), // Make optional and default to empty string
	confidence: z.number().optional().default(0), // Make confidence optional and default to 0
});
const JobAnalysisResultsArraySchema = z.array(JobAnalysisResultSchema);

const rootDirectory = path.resolve(__dirname, "..", "..");

/**
 * Read Michael Martini's resume from external file
 * @returns Resume content as string
 * @throws Error if file cannot be read
 */
async function readResumeFromFile(): Promise<string> {
	const resumePath = path.join(
		rootDirectory,
		"user_data",
		"my_resume.txt",
	);
	try {
		const content = await fsPromises.readFile(resumePath, "utf-8");
		if (!content || content.trim().length === 0) {
			throw new Error("Resume file is empty");
		}
		return content;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to read resume file from ${resumePath}: ${errorMessage}`,
		);
	}
}

/**
 * Find all processed_jobs_*.json files in the data directory
 * @returns Array of file paths
 * @throws Error if data directory cannot be accessed
 */
async function findProcessedJobFiles(): Promise<string[]> {
	const dataDirectory = path.join(rootDirectory, "data");
	try {
		// Verify data directory exists
		try {
			await fsPromises.access(dataDirectory, fs.constants.R_OK);
		} catch (_accessError) {
			throw new Error(`Data directory is not accessible: ${dataDirectory}`);
		}

		const files = await fsPromises.readdir(dataDirectory);
		const processedJobFiles = files
			.filter(
				(file) => file.startsWith("processed_jobs_") && file.endsWith(".json"),
			)
			.map((file) => path.join(dataDirectory, file));

		if (processedJobFiles.length === 0) {
			log(
				"JobCloth",
				"No processed_jobs_*.json files found in ./data/ directory",
				"warn",
			);
			return [];
		}

		log(
			"JobCloth",
			`Found ${processedJobFiles.length} processed job files`,
			"info",
			{
				files: processedJobFiles,
			},
		);

		return processedJobFiles;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		log("JobCloth", `Error reading data directory: ${errorMessage}`, "error", {
			error: errorMessage,
			directory: dataDirectory,
		});
		throw new Error(`Failed to find processed job files: ${errorMessage}`);
	}
}

/**
 * Retry failed job titles individually within a batch
 * @param batchTitles Array of job titles that failed in batch processing
 * @param resumeContent Resume content for analysis
 * @param effectivePreset Preset configuration
 * @param veritasSystemPrompt System prompt
 * @param effectiveTemperature Temperature setting
 * @param effectiveTopP Top-p setting
 * @param maxTokens Maximum tokens
 * @param openaiTimeout Timeout setting
 * @param verbose Verbose logging flag
 * @param circuitBreaker Circuit breaker instance
 * @param maxRetries Maximum retry attempts per job title
 * @returns Promise resolving to array of successful analysis results
 */
async function retryFailedJobTitles(
	batchTitles: string[],
	resumeContent: string,
	effectivePreset: Preset,
	veritasSystemPrompt: string,
	effectiveTemperature: number,
	effectiveTopP: number,
	maxTokens: number,
	openaiTimeout: number,
	verbose: boolean,
	circuitBreaker: {
		checkState: () => boolean;
		recordFailure: (error: unknown) => void;
		recordSuccess: () => void;
	},
	maxRetries: number,
): Promise<z.infer<typeof JobAnalysisResultsArraySchema>> {
	const successfulResults: z.infer<typeof JobAnalysisResultsArraySchema> = [];
	const jobTitleRetryMap = new Map<string, number>();

	for (const jobTitle of batchTitles) {
		let retryCount = 0;
		let success = false;
		let lastError: unknown = null;

		// Retry individual job title
		while (retryCount < maxRetries && !success) {
			try {
				// Check circuit breaker state
				if (circuitBreaker.checkState()) {
					throw new Error(
						`Circuit breaker is tripped. Skipping job title: ${jobTitle}`,
					);
				}

				const placeholderData = {
					targJD: jobTitle,
					myResume: resumeContent,
					myTestimonials: "",
					myProfessionalTitle: "",
					myProfessionalSummary: "",
					myKeySkills: "",
				};

				let userMessageContent = await loadAndReplacePromptTemplate(
					effectivePreset.promptTemplate,
					placeholderData,
				);
				userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;
				userMessageContent += `\n\n--- Job Title ---\n${jobTitle}`;

				const llmRequest: LLMRequest = {
					provider: effectivePreset.provider as
						| "openai"
						| "gemini"
						| "mistral"
						| "openrouter"
						| "cerebras"
						| "poe",
					model: effectivePreset.modelId,
					messages: [
						{
							role: "system",
							content: veritasSystemPrompt,
						},
						{
							role: "user",
							content: userMessageContent,
						},
					],
					temperature: effectiveTemperature,
					topP: effectiveTopP,
					maxTokens,
					timeout: openaiTimeout * 1000,
					responseSchema: JobAnalysisResultsArraySchema,
				};

				const result = await llmService.call(llmRequest);

				// Record success for circuit breaker
				circuitBreaker.recordSuccess();

				// The content is already parsed and validated by LLMService
				const parsedResult = result.content as z.infer<
					typeof JobAnalysisResultsArraySchema
				>;

				if (parsedResult && parsedResult.length > 0) {
					successfulResults.push(...parsedResult);
					success = true;

					if (verbose) {
						log(
							"JobCloth",
							`Successfully processed job title on retry ${retryCount + 1}: ${jobTitle}`,
							"info",
						);
					}
				}
			} catch (apiError: unknown) {
				// Record failure for circuit breaker
				circuitBreaker.recordFailure(apiError);

				lastError = apiError;
				retryCount++;
				jobTitleRetryMap.set(jobTitle, retryCount);

				if (verbose) {
					const errorMessage =
						apiError instanceof Error ? apiError.message : String(apiError);
					log(
						"JobCloth",
						`Job title ${jobTitle} failed on retry ${retryCount}/${maxRetries}: ${errorMessage}`,
						"warn",
					);
				}

				// Wait before retrying (exponential backoff)
				if (retryCount < maxRetries) {
					const retryDelay = 1000 * 2 ** (retryCount - 1);
					await new Promise((res) => setTimeout(res, retryDelay));
				}
			}
		}

		if (!success) {
			const errorMessage =
				lastError instanceof Error ? lastError.message : String(lastError);
			log(
				"JobCloth",
				`Job title ${jobTitle} failed after ${maxRetries} retries. Last error: ${errorMessage}`,
				"error",
			);
		}
	}

	if (verbose) {
		log(
			"JobCloth",
			`Individual retry completed. Successfully processed: ${successfulResults.length}/${batchTitles.length} job titles`,
			"info",
			{
				successfulCount: successfulResults.length,
				totalCount: batchTitles.length,
				retryMap: Object.fromEntries(jobTitleRetryMap),
			},
		);
	}

	return successfulResults;
}

/**
 * Core function for jobCloth prefiltering.
 * Used by both CLI and workflow.
 */
export async function runJobCloth(
	inputFile: string | string[],
	outputFile: string,
	options: {
		apiKey: string;
		baseUrl: string;
		modelId: string;
		temperature?: number;
		topP?: number;
		batch?: number;
		retries?: number;
		maxTokens?: number;
		pingInterval?: number;
		openaiTimeout?: number;
		verbose?: boolean;
		logPayload?: boolean;
		preset?: string;
		sleep?: number;
		batchRetryAttempts?: number;
		batchRetryDelay?: number;
		jobTitleRetryAttempts?: number;
		circuitThreshold?: number;
		circuitTimeout?: number;
	},
): Promise<JobInterface[]> {
	const {
		apiKey,
		baseUrl: baseUrl_unused,
		modelId: modelId_unused,
		temperature = 0.7,
		topP = 0.95,
		batch = 100,
		retries: retries_unused = 3,
		maxTokens = 16000,
		pingInterval: pingInterval_unused = 15,
		openaiTimeout = 60,
		verbose = false,
		sleep = 2,
		batchRetryAttempts = 3,
		batchRetryDelay = 5000,
		jobTitleRetryAttempts = 2,
		circuitThreshold = 0.5,
		circuitTimeout = 60,
	} = options;
	// Reference intentionally-unused values to satisfy linters without changing behavior
	void baseUrl_unused;
	void modelId_unused;
	void retries_unused;
	void pingInterval_unused;

	const resolvedOutputFile = path.resolve(rootDirectory, outputFile);

	const allJobs: JobInterface[] = [];
	const allAnalysisResults: z.infer<typeof JobAnalysisResultsArraySchema> = [];

	// Handle multiple input files or single input file
	const inputFiles = Array.isArray(inputFile) ? inputFile : [inputFile];
	const failedFiles: string[] = [];

	for (const inputFilePath of inputFiles) {
		const resolvedInputFile = path.resolve(rootDirectory, inputFilePath);
		log("JobCloth", `Processing input file: ${resolvedInputFile}`, "info");

		try {
			// Verify file exists and is readable
			try {
				await fsPromises.access(resolvedInputFile, fs.constants.R_OK);
			} catch (accessError) {
				const errorMessage =
					accessError instanceof Error
						? accessError.message
						: String(accessError);
				throw new Error(`File is not accessible: ${errorMessage}`);
			}

			// Read jobs
			const fileContent = await fsPromises.readFile(resolvedInputFile, "utf-8");

			if (!fileContent || fileContent.trim().length === 0) {
				throw new Error("File is empty");
			}

			let jobs: JobInterface[];
			try {
				jobs = JSON.parse(fileContent);
			} catch (jsonError) {
				const errorMessage =
					jsonError instanceof Error ? jsonError.message : String(jsonError);
				throw new Error(`Invalid JSON format: ${errorMessage}`);
			}

			if (!Array.isArray(jobs)) {
				throw new Error("File does not contain a JSON array of jobs");
			}

			if (jobs.length === 0) {
				log(
					"JobCloth",
					`Skipping file: ${resolvedInputFile} contains no jobs`,
					"warn",
				);
				continue;
			}

			// Validate each job has required fields
			const validJobs = jobs.filter((job, index) => {
				const isValid = job && typeof job === "object" && job.title && job.url;
				if (!isValid) {
					log(
						"JobCloth",
						`Skipping invalid job at index ${index} in ${resolvedInputFile}`,
						"warn",
						{
							job: job,
							index,
						},
					);
				}
				return isValid;
			});

			if (validJobs.length !== jobs.length) {
				log(
					"JobCloth",
					`Filtered out ${jobs.length - validJobs.length} invalid jobs from ${path.basename(resolvedInputFile)}`,
					"warn",
				);
			}

			if (validJobs.length === 0) {
				log(
					"JobCloth",
					`Skipping file: ${resolvedInputFile} contains no valid jobs`,
					"warn",
				);
				failedFiles.push(resolvedInputFile);
				continue;
			}

			log(
				"JobCloth",
				`Loaded ${validJobs.length} valid jobs from ${path.basename(resolvedInputFile)}`,
			);
			allJobs.push(...validJobs);
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			log(
				"JobCloth",
				`Error processing file ${resolvedInputFile}: ${errorMessage}`,
				"error",
				{
					error: errorMessage,
					file: resolvedInputFile,
					stack: errorStack,
				},
			);
			failedFiles.push(resolvedInputFile);
		}
	}

	if (allJobs.length === 0) {
		const failedFilesList =
			failedFiles.length > 0 ? `nFailed files: ${failedFiles.join(", ")}` : "";
		throw new Error(
			`No valid jobs found in any input files. Please ensure you have scraped search data first.${failedFilesList}`,
		);
	}

	log(
		"JobCloth",
		`Successfully loaded ${allJobs.length} valid jobs from ${inputFiles.length} input file(s)`,
		"info",
		{
			totalJobs: allJobs.length,
			inputFiles: inputFiles.length,
			failedFiles: failedFiles.length,
		},
	);

	log("JobCloth", `Total jobs to process: ${allJobs.length}`, "info");

	// Extract job titles and remove duplicates to optimize API calls
	const uniqueJobTitles = [...new Set(allJobs.map((job) => job.title))];
	const jobTitles = uniqueJobTitles;

	log(
		"JobCloth",
		`Processing ${jobTitles.length} unique job titles (filtered from ${allJobs.length} total jobs)`,
		"info",
	);

	// Read resume once and cache it
	const resumeContent = await readResumeFromFile();

	// Load all presets and the Veritas system prompt
	const allPresets = await loadPresets();
	const veritasSystemPrompt = await loadVeritasSystemPrompt();

	// Determine effective preset, API key, base URL, model ID, temperature, and topP
	let effectivePreset = options.preset
		? getPreset("jobCloth", options.preset, allPresets)
		: undefined;
	if (!effectivePreset) {
		// Fallback to a default preset if none is specified or found
		effectivePreset = getPreset("jobCloth", "jc_mai-ds-r1", allPresets);
		if (!effectivePreset) {
			throw new Error(
				"No valid preset found for jobCloth command and no default fallback available.",
			);
		}
		log("JobCloth", `Using default preset: ${effectivePreset.name}`, "warn");
	}

	const effectiveApiKey = apiKey; // API key always comes from CLI/env
	const effectiveBaseUrl = effectivePreset.base_url;
	const effectiveModelId = effectivePreset.modelId;
	const effectiveTemperature =
		temperature !== undefined ? temperature : effectivePreset.temperature;
	const effectiveTopP = topP !== undefined ? topP : effectivePreset.topP;
	const effectiveMaxTokens =
		options.maxTokens !== undefined
			? options.maxTokens
			: (effectivePreset.maxTokens ?? 8000);

	// Initialize LLM service with provider configuration
	llmService.initialize(
		[
			{
				name: effectivePreset.provider,
				apiKey: effectiveApiKey,
				baseUrl: effectiveBaseUrl,
				model: effectiveModelId,
			},
		],
		effectivePreset.provider,
	);

	// Verbose logging for prompts and system information
	if (verbose) {
		log("JobCloth", "=== VERBOSE MODE ENABLED ===", "info");
		log("JobCloth", "System Instructions:", "info");
		log("JobCloth", veritasSystemPrompt, "info");
		log("JobCloth", "Resume Content (first 500 chars):", "info");
		log("JobCloth", `${resumeContent.substring(0, 500)}...`, "info");
		log("JobCloth", "Model Configuration:", "info");
		log("JobCloth", `  - Preset: ${effectivePreset.name}`, "info");
		log("JobCloth", `  - Provider: ${effectivePreset.provider}`, "info");
		log("JobCloth", `  - Base URL: ${effectiveBaseUrl}`, "info");
		log("JobCloth", `  - Model: ${effectiveModelId}`, "info");
		log("JobCloth", `  - Temperature: ${effectiveTemperature}`, "info");
		log("JobCloth", `  - Top P: ${effectiveTopP}`, "info");
		log("JobCloth", `  - Max Tokens: ${effectiveMaxTokens}`, "info");
		log("JobCloth", `  - Batch Size: ${batch}`, "info");
		log("JobCloth", `  - Unique Job Titles: ${jobTitles.length}`, "info");
		log("JobCloth", "===================================", "info");
	}

	// Initialize circuit breaker for API failures
	const circuitBreaker = {
		isTripped: false,
		failureCount: 0,
		successCount: 0,
		lastFailureTime: 0,
		timeout: circuitTimeout * 1000, // Convert to milliseconds

		checkState: function () {
			const now = Date.now();
			// Reset if timeout has passed
			if (this.isTripped && now - this.lastFailureTime > this.timeout) {
				this.isTripped = false;
				this.failureCount = 0;
				this.successCount = 0;
				log("JobCloth", "Circuit breaker reset", "info");
				return false;
			}
			return this.isTripped;
		},

		recordSuccess: function () {
			this.successCount++;
			this.failureCount = 0; // Reset failure count on success
			if (this.successCount >= 3) {
				// Require 3 consecutive successes to reset
				this.isTripped = false;
				this.successCount = 0;
				log(
					"JobCloth",
					"Circuit breaker recovered after consecutive successes",
					"info",
				);
			}
		},

		recordFailure: function (_error?: unknown) {
			this.failureCount++;
			this.lastFailureTime = Date.now();

			// Calculate failure rate
			const totalAttempts = this.failureCount + this.successCount;
			const failureRate =
				totalAttempts > 0 ? this.failureCount / totalAttempts : 1;

			if (failureRate >= circuitThreshold && !this.isTripped) {
				this.isTripped = true;
				log(
					"JobCloth",
					`Circuit tripped: failure rate ${failureRate.toFixed(2)} >= threshold ${circuitThreshold}`,
					"error",
					{
						failureRate,
						threshold: circuitThreshold,
						failureCount: this.failureCount,
						successCount: this.successCount,
					},
				);
			}
		},
	};

	// Batch or single call logic
	if (batch === 0) {
		// Single request with retries
		let processedCount = 0;
		while (processedCount < jobTitles.length) {
			const remainingTitles = jobTitles.slice(processedCount);
			let success = false;
			let lastError: unknown = null;
			let newlyProcessedCount = 0;

			try {
				if (verbose) {
					log(
						"JobCloth",
						`Processing ${remainingTitles.length} job titles:`,
						"info",
					);
					remainingTitles.forEach((title, index) => {
						log("JobCloth", `  ${index + 1}. ${title}`, "info");
					});
				}

				const placeholderData = {
					targJD: remainingTitles.join("\n"),
					myResume: resumeContent,
					myTestimonials: "", // Placeholder for future use, if needed
					myProfessionalTitle: "", // Placeholder for future use, if needed
					myProfessionalSummary: "", // Placeholder for future use, if needed
					myKeySkills: "", // Placeholder for future use, if needed
				};

				let userMessageContent = await loadAndReplacePromptTemplate(
					effectivePreset.promptTemplate,
					placeholderData,
				);
				userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;
				userMessageContent += `\n\n--- Job Titles ---\n${remainingTitles.join("\n")}`;

				const llmRequest: LLMRequest = {
					provider: effectivePreset.provider as
						| "openai"
						| "gemini"
						| "mistral"
						| "openrouter"
						| "cerebras"
						| "poe",
					model: effectiveModelId,
					messages: [
						{
							role: "system",
							content: veritasSystemPrompt,
						},
						{
							role: "user",
							content: userMessageContent,
						},
					],
					temperature: effectiveTemperature,
					topP: effectiveTopP,
					maxTokens: effectiveMaxTokens,
					timeout: openaiTimeout * 1000,
					responseSchema: JobAnalysisResultsArraySchema, // Pass the Zod schema for validation
				};

				// Add JSON Mode for OpenAI provider
				if (effectivePreset.provider === "openai") {
					(
						llmRequest as LLMRequest & { response_format?: { type: string } }
					).response_format = { type: "json_object" };
				}

				// Add JSON Mode for OpenAI provider
				if (effectivePreset.provider === "openai") {
					(
						llmRequest as LLMRequest & { response_format?: { type: string } }
					).response_format = { type: "json_object" };
				}

				// Add JSON Mode for OpenAI provider
				if (effectivePreset.provider === "openai") {
					(
						llmRequest as LLMRequest & { response_format?: { type: string } }
					).response_format = { type: "json_object" };
				}

				if (verbose) {
					log("JobCloth", "LLM Request Payload:", "info", {
						request: llmRequest,
					});
				}

				try {
					// Check circuit breaker state
					if (circuitBreaker.checkState()) {
						throw new Error(
							`Circuit breaker is tripped. Skipping API call for ${remainingTitles.length} job titles.`,
						);
					}

					const result = await llmService.call(llmRequest);

					// Record success for circuit breaker
					circuitBreaker.recordSuccess();

					if (verbose) {
						log("JobCloth", "API Response:", "info");
						log("JobCloth", `  - Success: true`, "info");
						log(
							"JobCloth",
							`  - Content Type: ${typeof result.content}`,
							"info",
						);
						log(
							"JobCloth",
							`  - Full Content: ${JSON.stringify(result.content).substring(0, 2000)}...`,
							"info",
						); // Log stringified content
					}

					// The content is already parsed and validated by LLMService
					const parsedResult = result.content as z.infer<
						typeof JobAnalysisResultsArraySchema
					>;

					lastError = null;
					allAnalysisResults.push(...parsedResult);
					newlyProcessedCount = parsedResult.length;
					if (newlyProcessedCount === remainingTitles.length) {
						success = true;
						if (verbose) {
							log(
								"JobCloth",
								`Successfully processed all ${newlyProcessedCount} job titles`,
								"info",
							);
						}
					}
				} catch (apiError: unknown) {
					// Record failure for circuit breaker
					circuitBreaker.recordFailure(apiError);

					lastError = apiError;
					if (verbose) {
						const errorMessage =
							apiError instanceof Error ? apiError.message : String(apiError);
						log("JobCloth", `API call failed: ${errorMessage}`, "error");
					}
				}
			} catch (error: unknown) {
				lastError = error;
				if (verbose) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					log("JobCloth", `Processing failed: ${errorMessage}`, "error");
				}
			}

			// Sleep between attempts
			if (sleep > 0 && !success) {
				// Only sleep if not successful and more processing is needed
				log(
					"JobCloth",
					`Sleeping for ${sleep} seconds before next attempt...`,
					"log",
					{
						sleepSeconds: sleep,
					},
				);
				await new Promise((res) => setTimeout(res, sleep * 1000));
			}

			if (!success) {
				const errorMessage =
					lastError instanceof Error ? lastError.message : String(lastError);
				throw new Error(
					`Failed to process job titles starting from index ${jobTitles.length - remainingTitles.length}. Last error: ${errorMessage}`,
				);
			}
			processedCount += newlyProcessedCount;
		}
	} else {
		// Batched requests with retry logic
		const totalBatches = Math.ceil(jobTitles.length / batch);

		for (let i = 0; i < jobTitles.length; i += batch) {
			const batchTitles = jobTitles.slice(i, i + batch);
			let batchSuccess = false;
			let batchResults: z.infer<typeof JobAnalysisResultsArraySchema> = [];
			let batchLastError: unknown = null;

			// Batch retry logic with exponential backoff
			for (
				let batchAttempt = 1;
				batchAttempt <= batchRetryAttempts;
				batchAttempt++
			) {
				const batchDelay = batchRetryDelay * 2 ** (batchAttempt - 1);

				if (verbose) {
					log(
						"JobCloth",
						`=== BATCH ${Math.floor(i / batch) + 1}/${totalBatches} (Attempt ${batchAttempt}/${batchRetryAttempts}) ===`,
						"info",
					);
					log(
						"JobCloth",
						`Processing batch of ${batchTitles.length} job titles:`,
						"info",
					);
					batchTitles.forEach((title, index) => {
						log("JobCloth", `  ${index + 1}. ${title}`, "info");
					});
				}

				try {
					// Check circuit breaker state
					if (circuitBreaker.checkState()) {
						throw new Error(
							`Circuit breaker is tripped. Skipping batch ${Math.floor(i / batch) + 1}.`,
						);
					}

					const placeholderData = {
						targJD: batchTitles.join("\n"),
						myResume: resumeContent,
						myTestimonials: "", // Placeholder for future use, if needed
						myProfessionalTitle: "", // Placeholder for future use, if needed
						myProfessionalSummary: "", // Placeholder for future use, if needed
						myKeySkills: "", // Placeholder for future use, if needed
					};

					let userMessageContent = await loadAndReplacePromptTemplate(
						effectivePreset.promptTemplate,
						placeholderData,
					);
					userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;
					userMessageContent += `\n\n--- Job Titles ---\n${batchTitles.join("\n")}`;

					const llmRequest: LLMRequest = {
						provider: effectivePreset.provider as
							| "openai"
							| "gemini"
							| "mistral"
							| "openrouter"
							| "cerebras"
							| "poe",
						model: effectiveModelId,
						messages: [
							{
								role: "system",
								content: veritasSystemPrompt,
							},
							{
								role: "user",
								content: userMessageContent,
							},
						],
						temperature: effectiveTemperature,
						topP: effectiveTopP,
						maxTokens: effectiveMaxTokens,
						timeout: openaiTimeout * 1000,
						responseSchema: JobAnalysisResultsArraySchema, // Pass the Zod schema for validation
					};

					if (verbose) {
						log("JobCloth", "LLM Request Payload:", "info", {
							request: llmRequest,
						});
					}

					const result = await llmService.call(llmRequest);

					// Record success for circuit breaker
					circuitBreaker.recordSuccess();

					if (verbose) {
						log("JobCloth", "Batch API Response:", "info");
						log("JobCloth", `  - Success: true`, "info");
						log(
							"JobCloth",
							`  - Content Type: ${typeof result.content}`,
							"info",
						);
						log(
							"JobCloth",
							`  - Full Content: ${JSON.stringify(result.content).substring(0, 2000)}...`,
							"info",
						); // Log stringified content
					}

					// The content is already parsed and validated by LLMService
					batchResults = result.content as z.infer<
						typeof JobAnalysisResultsArraySchema
					>;
					allAnalysisResults.push(...batchResults);
					batchSuccess = true;
					batchLastError = null;

					if (verbose) {
						log(
							"JobCloth",
							`Batch ${Math.floor(i / batch) + 1} processed successfully`,
							"info",
						);
					}
					break; // Exit retry loop on success
				} catch (apiError: unknown) {
					// Record failure for circuit breaker
					circuitBreaker.recordFailure(apiError);

					batchLastError = apiError;
					if (verbose) {
						const errorMessage =
							apiError instanceof Error ? apiError.message : String(apiError);
						log("JobCloth", `Batch API call failed: ${errorMessage}`, "error");
					}

					// If this is not the last attempt, wait before retrying
					if (batchAttempt < batchRetryAttempts) {
						const errorMessage =
							apiError instanceof Error ? apiError.message : String(apiError);
						log("JobCloth", `Retrying batch in ${batchDelay}ms...`, "warn", {
							batchNumber: Math.floor(i / batch) + 1,
							attempt: batchAttempt,
							delay: batchDelay,
							error: errorMessage,
						});
						await new Promise((res) => setTimeout(res, batchDelay));
					}
				}
			}

			// If batch failed after all retries, handle individual job title retries
			if (!batchSuccess && jobTitleRetryAttempts > 0) {
				log(
					"JobCloth",
					`Batch ${Math.floor(i / batch) + 1} failed, attempting individual job title retries...`,
					"warn",
				);

				const individualResults = await retryFailedJobTitles(
					batchTitles,
					resumeContent,
					effectivePreset,
					veritasSystemPrompt,
					effectiveTemperature,
					effectiveTopP,
					effectiveMaxTokens,
					openaiTimeout,
					verbose,
					circuitBreaker,
					jobTitleRetryAttempts,
				);

				allAnalysisResults.push(...individualResults);
			}

			// If batch failed completely and no individual retries were possible
			if (!batchSuccess && batchResults.length === 0) {
				const errorMessage =
					batchLastError instanceof Error
						? batchLastError.message
						: String(batchLastError);
				throw new Error(
					`Batch ${Math.floor(i / batch) + 1} failed after ${batchRetryAttempts} attempts. Last error: ${errorMessage}`,
				);
			}

			// Sleep between batches
			if (sleep > 0 && i + batch < jobTitles.length) {
				log(
					"JobCloth",
					`Sleeping for ${sleep} seconds before next batch...`,
					"log",
					{
						sleepSeconds: sleep,
					},
				);
				await new Promise((res) => setTimeout(res, sleep * 1000));
			}
		}
	}

	// Map analysis results
	const analysisMap = new Map<
		string,
		z.infer<typeof JobAnalysisResultSchema>
	>();
	allAnalysisResults.forEach((result) => {
		if (result?.jobTitle) {
			analysisMap.set(result.jobTitle, result);
		}
	});

	// Filter jobs
	const highlyAlignedJobs = allJobs.filter((job) => {
		const analysis = analysisMap.get(job.title);
		return analysis?.isVeryHighlyAligned;
	});

	// Add confidence score
	const highlyAlignedJobsWithConfidence = highlyAlignedJobs.map((job) => {
		const analysis = analysisMap.get(job.title);
		if (analysis) {
			return {
				...job,
				confidence: analysis.confidence,
			};
		}
		return job;
	});

	await fsPromises.writeFile(
		resolvedOutputFile,
		JSON.stringify(highlyAlignedJobsWithConfidence, null, 2),
		"utf-8",
	);
	return highlyAlignedJobsWithConfidence;
}

export const addJobClothCommand = (
	yargs: Argv<GlobalArgs>,
	jobClothPresets: string[], // Pass presets here
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "jobCloth",
		describe:
			"Production-ready job role identification using AI providers with enhanced security, centralized LLM service, and comprehensive error handling. Auto-detects processed_jobs_*.json files in ./data/ if no input file is specified.",
		builder: async (yargs: Argv<GlobalArgs>) => {
			// Make builder async
			// Presets are now passed from index.ts, so no need to load here for help message
			// The check function below will still load them for validation at runtime

			return (yargs as unknown as Argv<GlobalArgs & JobClothArgs>)
				.option("base-url", {
					type: "string",
					description:
						"Base URL for the AI provider API. Overridden by preset if available.",
					demandOption: false,
				})
				.option("api-key", {
					type: "string",
					description: "API key for the AI provider.",
					demandOption: false,
				})
				.option("model-id", {
					type: "string",
					description:
						"Model ID to use for analysis. Overridden by preset if available.",
					demandOption: false,
				})
				.option("temperature", {
					type: "number",
					description:
						"Temperature for AI model (0-1). Overridden by preset if available.",
					default: 0.6,
				})
				.option("top-p", {
					type: "number",
					description:
						"Top-p sampling for AI model (0-1). Overridden by preset if available.",
					default: 0.95,
				})
				.option("input-file", {
					alias: "i",
					type: "string",
					description: "Input file path for the processed JSON job data.",
					demandOption: false, // Changed to false
					default: "./data/processed_jobs_*.json", // Set default to glob
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					description: "Output file path for the clothed JSON data.",
					demandOption: false, // Changed to false
					default: "./data/clothed_jobs.json", // Set default to trigger timestamp
				})
				.option("batch", {
					type: "number",
					description:
						"Number of job titles to send to OpenAI API per batch (0 to disable batching).",
					default: 100,
				})
				.option("retries", {
					type: "number",
					description:
						"Number of times to retry the OpenAI API call on failure (when batching is disabled).",
					default: 3,
				})
				.option("max-tokens", {
					type: "number",
					description: "Maximum tokens for AI response (overrides preset value)",
					default: undefined,
				})
				.option("ping-interval", {
					type: "number",
					description: "Interval (in seconds) between ping logs.",
					default: 15,
				})
				.option("openai-timeout", {
					type: "number",
					description: "Timeout (in seconds) for the OpenAI API call.",
					default: 60,
				})
				.option("verbose", {
					type: "boolean",
					description:
						"Display outgoing LLM payload and incoming response for debugging",
					default: false,
				})
				.option("log-payload", {
					type: "boolean",
					description: "Save outbound LLM payload to ./logs folder",
					default: false,
				})
				.option("preset", {
					type: "string",
					description: `Preset to use for jobCloth analysis. Available presets: ${jobClothPresets.join(", ")}`,
					choices: jobClothPresets, // Use the passed-in presets
					demandOption: true, // Preset is now mandatory
				})
				.option("sleep", {
					alias: "s",
					type: "number",
					description:
						"Delay in seconds between processing each job title. Defaults to 2.",
					default: 1,
				})
				.option("batch-retry-attempts", {
					type: "number",
					description: "Number of times to retry failed batches (default: 3).",
					default: 3,
				})
				.option("batch-retry-delay", {
					type: "number",
					description:
						"Initial delay between batch retries in milliseconds (default: 5000).",
					default: 5000,
				})
				.option("job-title-retry-attempts", {
					type: "number",
					description: "Max retries per job title within batches (default: 2).",
					default: 2,
				})
				.option("circuit-threshold", {
					type: "number",
					description:
						"Failure rate threshold for circuit breaker (default: 0.5).",
					default: 0.5,
				})
				.option("circuit-timeout", {
					type: "number",
					description: "Circuit breaker timeout in seconds (default: 60).",
					default: 60,
				})
				.check(async (argv) => {
					const allPresets = await loadPresets();
					if (!argv.preset || !getPreset("jobCloth", argv.preset, allPresets)) {
						throw new Error(
							`Invalid or missing preset. Available presets for jobCloth: ${Object.keys(allPresets.jobCloth).join(", ")}`,
						);
					}
					return true;
				});
		},
		handler: async (argv: unknown) => {
			// Initialize statistics collection
			const stats = createStatisticsCollector("jobCloth");
			stats.startCollection();

			// Load all presets and the Veritas system prompt once
			const allPresets = await loadPresets();
			const _veritasSystemPrompt = await loadVeritasSystemPrompt();

			// Cast argv to proper type for access
			const typedArgv = argv as Record<string, unknown>;

			// Determine effective preset
			const effectivePreset = getPreset(
				"jobCloth",
				typedArgv.preset as string,
				allPresets,
			);
			if (!effectivePreset) {
				stats.recordError(
					new Error(
						`Preset '${typedArgv.preset}' not found for jobCloth command`,
					),
				);
				throw new Error(
					`Preset '${typedArgv.preset}' not found for jobCloth command`,
				);
			}

			// Only show parameters if verbose mode is enabled
			if (typedArgv.verbose) {
				log(
					"JobCloth",
					`Command parameters: ${JSON.stringify(typedArgv)}`,
					"info",
					{
						params: typedArgv,
					},
				);
			}

			if (!typedArgv.disableFileLogging) {
				const logDir =
					typeof typedArgv.logDir === "string"
						? typedArgv.logDir
						: path.join(rootDirectory, "logs");
				const logFile =
					typeof typedArgv.logFile === "string"
						? typedArgv.logFile
						: "astroex.log";
				initializeFileLogging(
					logDir,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_JobCloth_${logFile}`,
					"JobCloth",
				);
			}

			const startTime = performance.now();

			// Only show start message if verbose mode is enabled
			if (typedArgv.verbose) {
				log("JobCloth", "Starting job alignment analysis command... ");
			}

			try {
				// Check if input file is explicitly provided or if it's the default glob
				let inputFiles: string | string[] = typedArgv["input-file"] as
					| string
					| string[];

				// If inputFiles is the default glob, find all processed_jobs_*.json files
				if (inputFiles === "./data/processed_jobs_*.json") {
					// Changed condition
					const processedJobFiles = await findProcessedJobFiles();
					if (processedJobFiles.length === 0) {
						throw new Error(
							"No processed_jobs_*.json files found in ./data/ directory. Please run processData first or provide a specific input file.",
						);
					}
					inputFiles = processedJobFiles;
					// Only show file detection message if verbose mode is enabled
					if (typedArgv.verbose) {
						log(
							"JobCloth",
							`Auto-detected ${processedJobFiles.length} processed job files for processing`,
							"info",
						);
					}
				} else {
					// Convert single file to array for consistent handling
					inputFiles = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
				}

				// Generate timestamped output filename if using default
				let outputFile = typedArgv["output-file"];
				if (outputFile === "./data/clothed_jobs.json") {
					outputFile = `./data/clothed_jobs_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`;
				}

				// API key always comes from CLI args or env
				const apiKey = typedArgv["api-key"] as string;
				// Use preset maxTokens unless explicitly overridden by CLI argument
				const effectiveMaxTokens =
					typedArgv["max-tokens"] !== undefined
						? (typedArgv["max-tokens"] as number)
						: (effectivePreset.maxTokens ?? 8000);

				const result = await runJobCloth(
					Array.isArray(inputFiles)
						? (inputFiles[0] as string)
						: (inputFiles as string),
					outputFile as string,
					{
						apiKey,
						baseUrl: effectivePreset.base_url,
						modelId: effectivePreset.modelId,
						temperature: effectivePreset.temperature,
						topP: effectivePreset.topP,
						batch: typedArgv.batch as number,
						retries: typedArgv.retries as number,
						maxTokens: effectiveMaxTokens,
						pingInterval: typedArgv["ping-interval"] as number,
						openaiTimeout: typedArgv["openai-timeout"] as number,
						verbose: typedArgv.verbose as boolean,
						logPayload: typedArgv["log-payload"] as boolean,
						preset: typedArgv.preset as string,
						sleep: typedArgv.sleep as number,
						batchRetryAttempts: typedArgv["batch-retry-attempts"] as number,
						batchRetryDelay: typedArgv["batch-retry-delay"] as number,
						jobTitleRetryAttempts: typedArgv[
							"job-title-retry-attempts"
						] as number,
						circuitThreshold: typedArgv["circuit-threshold"] as number,
						circuitTimeout: typedArgv["circuit-timeout"] as number,
					},
				);

				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Generate and display statistics
				const summary = stats.endCollection();

				// Always show completion message, but keep it concise
				log("JobCloth", `Completed in ${duration}.`, "log", {
					duration,
					totalJobs: result.length,
					statistics: summary,
				});

				// Export statistics to file
				const statsFile = path.join(
					rootDirectory,
					"data",
					`job-cloth-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
				);
				await fsPromises.writeFile(statsFile, stats.export("json"), "utf-8");
				log("JobCloth", `Statistics exported to: ${statsFile}`, "info");
			} catch (error: unknown) {
				const endTime = performance.now();
				const duration = formatDuration(endTime - startTime);

				// Record error in statistics
				stats.recordError(
					error instanceof Error ? error : new Error(String(error)),
				);

				const errorMessage =
					error instanceof Error ? error.message : String(error);
				log("JobCloth", `Failed after ${duration}: ${errorMessage}`, "error", {
					duration,
					error: errorMessage,
				});
			} finally {
				// Always end statistics collection
				const summary = stats.endCollection();
				log("JobCloth", "Final statistics:", "info", { summary });

				await closeFileLogging();
				setTimeout(() => process.exit(0), 1000);
			}
		},
	});
};
