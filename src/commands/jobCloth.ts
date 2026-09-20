import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Argv } from "yargs";
import { z } from "zod";
import { writeArtifactManifest } from "../artifactManifest";
import type { JobRepository } from "../jobRepository";
import {
	type LLMRequest,
	PathologicalReasoningRepetitionError,
	llmService,
} from "../llmService";
import type { JobInterface } from "../models";
import {
	abortableDelay,
	rethrowIfCancelled,
	throwIfCancelled,
} from "../pipelineCancellation";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} from "../presets";
import {
	getDataDirectory,
	getProfileFile,
	getProjectDirectory,
} from "../runtimePaths";
import {
	checkStageCheckpoint,
	completeStageCheckpoint,
	computeFileHash,
	getSharedJobRepository,
	initStageCheckpoint,
} from "../stageCheckpoint";
import {
	type StatisticsCollector,
	createStatisticsCollector,
} from "../statistics";
import {
	type GlobalArgs,
	type JobClothArgs,
	type OpenRouterProviderRouting,
	type Preset,
	getPreset,
} from "../types";
import { createLogger, formatDate, formatDuration, log } from "../utils";
import { createProgressReporter } from "../utils/progress";
import { normalizeJobAnalysisRecord } from "../utils/sharedCommandUtils";

const logger = createLogger("JobCloth");

async function callLLMWithStats(
	request: LLMRequest,
	stats?: StatisticsCollector,
	signal?: AbortSignal,
) {
	const startedAt = performance.now();
	stats?.incrementCounter("api.totalCalls", 1);
	stats?.incrementCounter("network.connections", 1);
	try {
		const result = await llmService.call(request, {
			payloadLogStage: "jobCloth",
			...(signal ? { signal } : {}),
		});
		stats?.incrementCounter("api.successfulCalls", 1);
		stats?.recordHistogram("api.responseTime", performance.now() - startedAt);
		return result;
	} catch (error) {
		stats?.incrementCounter("api.failedCalls", 1);
		stats?.recordHistogram("api.responseTime", performance.now() - startedAt);
		const message = error instanceof Error ? error.message : String(error);
		if (/timeout|timed out/i.test(message)) {
			stats?.incrementCounter("network.timeouts", 1);
		}
		if (
			error instanceof PathologicalReasoningRepetitionError ||
			(error as { name?: string })?.name ===
				"PathologicalReasoningRepetitionError" ||
			/pathological reasoning repetition/i.test(message)
		) {
			stats?.incrementCounter("api.repetitionErrors", 1);
		}
		throw error;
	}
}

const BooleanCoerce = z.preprocess((val) => {
	if (typeof val === "string") {
		const normalized = val.trim().toLowerCase();
		if (["true", "1", "yes", "y"].includes(normalized)) return true;
		if (["false", "0", "no", "n"].includes(normalized)) return false;
	}
	return val;
}, z.boolean().optional());

const ConfidenceCoerce = z.preprocess((val) => {
	if (val === undefined || val === null || val === "") return 0;
	const num = Number(val);
	if (Number.isNaN(num)) return 0;
	if (num > 1 && num <= 100) return num / 100;
	if (num > 1) return 1;
	if (num < 0) return 0;
	return num;
}, z.number().min(0).max(1).default(0));

// Zod schemas
const JobAnalysisResultSchema = z.preprocess(
	normalizeJobAnalysisRecord,
	z
		.object({
			jobTitle: z.string().optional(),
			job_title: z.string().optional(),
			title: z.string().optional(),
			isWorthInvestigating: BooleanCoerce,
			isVeryHighlyAligned: BooleanCoerce,
			isHighlyAligned: BooleanCoerce,
			rationale: z.string().optional().default(""),
			confidence: ConfidenceCoerce,
		})
		.passthrough()
		.refine((data) => Boolean(data.jobTitle || data.job_title || data.title), {
			message: "jobTitle, job_title, or title is required",
		})
		.transform((data) => {
			const resolvedTitle = data.jobTitle ?? data.job_title ?? data.title ?? "";
			const isAligned = Boolean(
				data.isWorthInvestigating ??
					data.isVeryHighlyAligned ??
					data.isHighlyAligned ??
					false,
			);
			return {
				jobTitle: resolvedTitle,
				isWorthInvestigating: isAligned,
				isVeryHighlyAligned: isAligned,
				isHighlyAligned: isAligned,
				rationale: data.rationale,
				confidence: data.confidence,
			};
		}),
);

const JobAnalysisResultsArraySchema = z.union([
	z.array(JobAnalysisResultSchema),
	z
		.object({
			jobs: z.array(JobAnalysisResultSchema).optional(),
			results: z.array(JobAnalysisResultSchema).optional(),
			jobTitles: z.array(JobAnalysisResultSchema).optional(),
			data: z.array(JobAnalysisResultSchema).optional(),
		})
		.refine(
			(obj) => Boolean(obj.jobs || obj.results || obj.jobTitles || obj.data),
			{
				message: "Expected jobs, results, jobTitles, or data array",
			},
		)
		.transform(
			(obj) => obj.jobs || obj.results || obj.jobTitles || obj.data || [],
		),
	JobAnalysisResultSchema.transform((single) => [single]),
]);

const rootDirectory = getProjectDirectory();

/**
 * Read candidate resume from external file
 * @returns Resume content as string
 * @throws Error if file cannot be read
 */
async function readResumeFromFile(): Promise<string> {
	const resumePath = getProfileFile("my_resume.txt");
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
	const dataDirectory = getDataDirectory();
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
				(file) => file.startsWith("processed_jobs") && file.endsWith(".json"),
			)
			.map((file) => path.join(dataDirectory, file));

		if (processedJobFiles.length === 0) {
			log(
				"JobCloth",
				"No processed_jobs*.json files found in ./data/ directory",
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
		recordFailure: (error?: unknown) => void;
		recordSuccess: () => void;
		reset?: () => void;
	},
	maxRetries: number,
	showReasoningTokens = false,
	showResponseStream = false,
	stats?: StatisticsCollector,
	reasoningEffort?: string,
	providerRouting?: OpenRouterProviderRouting,
	signal?: AbortSignal,
	onTitleResolved?: (context: { jobTitle: string; success: boolean }) => void,
): Promise<z.infer<typeof JobAnalysisResultsArraySchema>> {
	const successfulResults: z.infer<typeof JobAnalysisResultsArraySchema> = [];
	const jobTitleRetryMap = new Map<string, number>();
	circuitBreaker.reset?.();

	for (const jobTitle of batchTitles) {
		throwIfCancelled(signal);
		let retryCount = 0;
		let success = false;
		let lastError: unknown = null;

		// Retry individual job title
		while (retryCount < maxRetries && !success) {
			try {
				if (retryCount > 0) {
					stats?.incrementCounter("api.retries", 1);
					stats?.incrementCounter("network.retries", 1);
				}
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
				userMessageContent += `\n\n--- Job Title ---\n${jobTitle}`;
				userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;

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
					showReasoningTokens,
					showResponseStream,
					...(reasoningEffort !== undefined && reasoningEffort !== ""
						? { reasoning_effort: reasoningEffort }
						: {}),
					...(providerRouting ? { providerRouting } : {}),
				};

				if (verbose) {
					log("JobCloth", "LLM Request Payload:", "debug", {
						request: llmRequest,
					});
				}

				const result = await callLLMWithStats(llmRequest, stats, signal);

				// Record success for circuit breaker
				circuitBreaker.recordSuccess();

				// Parse and validate using schema to ensure transforms and aliases are applied
				const parsedResult = JobAnalysisResultsArraySchema.parse(
					result.content,
				);

				if (parsedResult && parsedResult.length > 0) {
					successfulResults.push(...parsedResult);
					success = true;

					if (verbose) {
						log(
							"JobCloth",
							`Successfully processed job title on retry ${retryCount + 1}: ${jobTitle}`,
							"debug",
						);
					}
				}
			} catch (apiError: unknown) {
				rethrowIfCancelled(apiError, signal);
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
					await abortableDelay(retryDelay, signal);
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
		onTitleResolved?.({ jobTitle, success });
	}

	if (verbose) {
		log(
			"JobCloth",
			`Individual retry completed. Successfully processed: ${successfulResults.length}/${batchTitles.length} job titles`,
			"debug",
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
		preset?: string;
		sleep?: number;
		batchRetryAttempts?: number;
		batchRetryDelay?: number;
		jobTitleRetryAttempts?: number;
		circuitThreshold?: number;
		circuitTimeout?: number;
		showReasoningTokens?: boolean;
		hideReasoningTokens?: boolean;
		showResponseStream?: boolean;
		stats?: StatisticsCollector;
		reasoningEffort?: string;
		"jc-reasoning-effort"?: string;
		"reasoning-effort"?: string;
		providerRouting?: OpenRouterProviderRouting;
		jobRepository?: JobRepository;
		jobRepositoryFactory?: () => Promise<JobRepository>;
		signal?: AbortSignal;
	},
): Promise<JobInterface[]> {
	const {
		apiKey,
		baseUrl: baseUrl_unused,
		modelId: modelId_unused,
		temperature,
		topP,
		batch = 100,
		retries: retries_unused = 3,
		maxTokens,
		pingInterval: pingInterval_unused = 15,
		openaiTimeout = 60,
		verbose = false,
		sleep = 2,
		batchRetryAttempts = 3,
		batchRetryDelay = 5000,
		jobTitleRetryAttempts = 2,
		circuitThreshold = 0.5,
		circuitTimeout = 60,
		showReasoningTokens = false,
		hideReasoningTokens = false,
		showResponseStream = false,
		stats,
		reasoningEffort: rawReasoningEffort,
		"jc-reasoning-effort": jcReasoningEffort,
		"reasoning-effort": reasoningEffortAlias,
		providerRouting,
		jobRepository: suppliedJobRepository,
		jobRepositoryFactory,
	} = options;
	const signal = options.signal;
	throwIfCancelled(signal);
	// Reference intentionally-unused values to satisfy linters without changing behavior
	void baseUrl_unused;
	void modelId_unused;
	void retries_unused;
	void pingInterval_unused;

	const rawReasoning =
		rawReasoningEffort ?? jcReasoningEffort ?? reasoningEffortAlias;
	const effectiveReasoningEffort =
		typeof rawReasoning === "string" && rawReasoning.trim().length > 0
			? rawReasoning.trim()
			: undefined;

	const effectiveHideReasoning =
		Boolean(hideReasoningTokens) || process.env.ASTROEX_HIDE_REASONING === "1";
	const effectiveShowReasoningTokens =
		!effectiveHideReasoning && Boolean(showReasoningTokens);

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
			stats?.incrementCounter("files.opened", 1);
			stats?.incrementCounter("files.read", 1);

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
			stats?.incrementCounter("data.filesProcessed", 1);
			stats?.incrementCounter("data.recordsProcessed", jobs.length);

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
				stats?.incrementCounter(
					"data.recordsFiltered",
					jobs.length - validJobs.length,
				);
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
			stats?.recordError(new Error(errorMessage), {
				inputFile: resolvedInputFile,
			});
		}
	}

	if (allJobs.length === 0) {
		const failedFilesList =
			failedFiles.length > 0 ? `nFailed files: ${failedFiles.join(", ")}` : "";
		throw new Error(
			`No valid jobs found in any input files. Please run processData first or provide a valid job artifact.${failedFilesList}`,
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
	stats?.incrementCounter("jobCloth.uniqueTitles", jobTitles.length);

	log(
		"JobCloth",
		`Processing ${jobTitles.length} unique job titles (filtered from ${allJobs.length} total jobs)`,
		"info",
		{
			...(effectiveReasoningEffort
				? { reasoning_effort: effectiveReasoningEffort }
				: {}),
			...(providerRouting?.only?.length
				? { "jc-provider": providerRouting.only.join(",") }
				: {}),
			...(providerRouting?.quantizations?.length
				? {
						"jc-provider-quant": providerRouting.quantizations.join(","),
					}
				: {}),
		},
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
		effectivePreset = getPreset("jobCloth", "jc_glm-5.3-flash", allPresets);
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
	const jobRepository =
		suppliedJobRepository ??
		(await (jobRepositoryFactory?.() ?? getSharedJobRepository()));

	const hasCliTemperature =
		process.argv.includes("--temperature") ||
		process.argv.some((arg) => arg.startsWith("--temperature="));
	const effectiveTemperature =
		hasCliTemperature && temperature !== undefined
			? temperature
			: (effectivePreset.temperature ?? temperature ?? 0.7);

	const hasCliTopP =
		process.argv.includes("--top-p") ||
		process.argv.includes("--topP") ||
		process.argv.some(
			(arg) => arg.startsWith("--top-p=") || arg.startsWith("--topP="),
		);
	const effectiveTopP =
		hasCliTopP && topP !== undefined
			? topP
			: (effectivePreset.topP ?? topP ?? 0.95);

	const hasCliMaxTokens =
		process.argv.includes("--max-tokens") ||
		process.argv.includes("--maxTokens") ||
		process.argv.some(
			(arg) =>
				arg.startsWith("--max-tokens=") || arg.startsWith("--maxTokens="),
		);
	const effectiveMaxTokens =
		hasCliMaxTokens && maxTokens !== undefined
			? maxTokens
			: (effectivePreset.maxTokens ?? maxTokens ?? 16000);

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

	let stageInputHash = "";
	if (inputFiles.length > 0) {
		try {
			stageInputHash = await computeFileHash(inputFiles[0]);
			const checkpoint = await checkStageCheckpoint(
				"jobCloth",
				inputFiles[0],
				resolvedOutputFile,
				effectivePreset.name,
				effectivePreset.modelId,
				jobRepository,
			);
			if (checkpoint.isCompleted) {
				await jobRepository.recordJobClothProcessed(
					allJobs,
					checkpoint.checkpoint?.updatedAt,
				);
				log(
					"JobCloth",
					`Durable checkpoint match: jobCloth already completed for input ${inputFiles[0]} with preset ${effectivePreset.name}. Reusing ${resolvedOutputFile}.`,
					"info",
					{ outputHash: checkpoint.outputHash },
				);
				const existingContent = await fsPromises.readFile(
					resolvedOutputFile,
					"utf8",
				);
				return JSON.parse(existingContent) as JobInterface[];
			}
			await initStageCheckpoint(
				"jobCloth",
				inputFiles[0],
				stageInputHash,
				resolvedOutputFile,
				effectivePreset.name,
				effectivePreset.modelId,
				jobTitles.length,
				Array.from(checkpoint.processedJobIds),
				jobRepository,
			);
		} catch (err) {
			log("JobCloth", `Checkpoint initialization notice: ${err}`, "debug");
		}
	}

	const plannedPrimaryCalls =
		batch === 0 ? 1 : Math.ceil(jobTitles.length / batch);
	const primaryCallProgress = createProgressReporter(logger, {
		label: "Stage 3/8: JobCloth",
		totalUnits: plannedPrimaryCalls,
		unitLabel: "LLM call",
		// Stage 3 operators need confirmation after every completed batch. The
		// shared reporter otherwise throttles known totals to twelve updates.
		maxUpdates: plannedPrimaryCalls,
	});
	primaryCallProgress.start({
		uniqueJobTitles: jobTitles.length,
		batchSize: batch,
	});

	// Verbose logging for prompts and system information
	if (verbose) {
		log("JobCloth", "=== VERBOSE MODE ENABLED ===", "debug");
		log("JobCloth", "System Instructions:", "debug");
		log("JobCloth", veritasSystemPrompt, "debug");
		log("JobCloth", "Resume Content (first 500 chars):", "debug");
		log("JobCloth", `${resumeContent.substring(0, 500)}...`, "debug");
		log("JobCloth", "Model Configuration:", "debug", {
			preset: effectivePreset.name,
			provider: effectivePreset.provider,
			baseUrl: effectiveBaseUrl,
			model: effectiveModelId,
			temperature: effectiveTemperature,
			topP: effectiveTopP,
			maxTokens: effectiveMaxTokens,
			batchSize: batch,
			uniqueJobTitles: jobTitles.length,
			...(effectiveReasoningEffort
				? { reasoning_effort: effectiveReasoningEffort }
				: {}),
			...(providerRouting?.only?.length
				? { "jc-provider": providerRouting.only.join(",") }
				: {}),
			...(providerRouting?.quantizations?.length
				? {
						"jc-provider-quant": providerRouting.quantizations.join(","),
					}
				: {}),
		});
		log("JobCloth", "===================================", "debug");
	}

	// Initialize circuit breaker for API failures
	const minFailuresToTrip = 3;
	const circuitBreaker = {
		isTripped: false,
		failureCount: 0,
		successCount: 0,
		consecutiveFailures: 0,
		lastFailureTime: 0,
		timeout: circuitTimeout * 1000, // Convert to milliseconds

		checkState: function () {
			const now = Date.now();
			// Reset if timeout has passed
			if (this.isTripped && now - this.lastFailureTime > this.timeout) {
				this.reset();
				log("JobCloth", "Circuit breaker reset after timeout", "info");
				return false;
			}
			return this.isTripped;
		},

		reset: function () {
			this.isTripped = false;
			this.failureCount = 0;
			this.consecutiveFailures = 0;
		},

		recordSuccess: function () {
			this.successCount++;
			this.consecutiveFailures = 0;
			if (this.isTripped) {
				this.isTripped = false;
				log("JobCloth", "Circuit breaker recovered after success", "info");
			}
		},

		recordFailure: function (_error?: unknown) {
			this.failureCount++;
			this.consecutiveFailures++;
			this.lastFailureTime = Date.now();

			// Calculate failure rate
			const totalAttempts = this.failureCount + this.successCount;
			const failureRate =
				totalAttempts > 0 ? this.failureCount / totalAttempts : 1;

			if (
				!this.isTripped &&
				this.failureCount >= minFailuresToTrip &&
				(failureRate >= circuitThreshold ||
					this.consecutiveFailures >= minFailuresToTrip)
			) {
				this.isTripped = true;
				log(
					"JobCloth",
					`Circuit tripped: failure rate ${failureRate.toFixed(2)} >= threshold ${circuitThreshold} (failures: ${this.failureCount}, consecutive: ${this.consecutiveFailures})`,
					"error",
					{
						failureRate,
						threshold: circuitThreshold,
						failureCount: this.failureCount,
						consecutiveFailures: this.consecutiveFailures,
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
		let attemptCount = 0;
		while (processedCount < jobTitles.length) {
			throwIfCancelled(signal);
			const remainingTitles = jobTitles.slice(processedCount);
			let success = false;
			let lastError: unknown = null;
			let newlyProcessedCount = 0;

			try {
				if (attemptCount > 0) {
					stats?.incrementCounter("api.retries", 1);
					stats?.incrementCounter("network.retries", 1);
				}
				attemptCount++;
				if (verbose) {
					log(
						"JobCloth",
						`Processing ${remainingTitles.length} job titles (attempt ${attemptCount})`,
						"debug",
						{ count: remainingTitles.length, titles: remainingTitles },
					);
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
				userMessageContent += `\n\n--- Job Titles ---\n${remainingTitles.join("\n")}`;
				userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;

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
					showReasoningTokens: effectiveShowReasoningTokens,
					hideReasoningTokens: effectiveHideReasoning,
					showResponseStream,
					...(effectiveReasoningEffort !== undefined
						? { reasoning_effort: effectiveReasoningEffort }
						: {}),
					...(providerRouting ? { providerRouting } : {}),
				};

				// Add JSON Mode for OpenAI provider
				if (effectivePreset.provider === "openai") {
					(
						llmRequest as LLMRequest & { response_format?: { type: string } }
					).response_format = { type: "json_object" };
				}

				if (verbose) {
					log("JobCloth", "LLM Request Payload:", "debug", {
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

					const result = await callLLMWithStats(llmRequest, stats, signal);

					// Record success for circuit breaker
					circuitBreaker.recordSuccess();

					if (verbose) {
						log("JobCloth", "API Response received successfully", "debug", {
							contentType: typeof result.content,
						});
					}

					// Parse and validate using schema to ensure transforms and aliases are applied
					const parsedResult = JobAnalysisResultsArraySchema.parse(
						result.content,
					);

					lastError = null;
					allAnalysisResults.push(...parsedResult);
					newlyProcessedCount = parsedResult.length;
					if (newlyProcessedCount === remainingTitles.length) {
						success = true;
						if (verbose) {
							log(
								"JobCloth",
								`Successfully processed all ${newlyProcessedCount} job titles`,
								"debug",
							);
						}
					}
				} catch (apiError: unknown) {
					rethrowIfCancelled(apiError, signal);
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
				rethrowIfCancelled(error, signal);
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
				await abortableDelay(sleep * 1000, signal);
			}

			if (!success) {
				const errorMessage =
					lastError instanceof Error ? lastError.message : String(lastError);
				throw new Error(
					`Failed to process job titles starting from index ${jobTitles.length - remainingTitles.length}. Last error: ${errorMessage}`,
				);
			}
			processedCount += newlyProcessedCount;
			primaryCallProgress.complete({
				jobTitlesCompleted: processedCount,
				jobTitlesTotal: jobTitles.length,
			});
		}
	} else {
		// Batched requests with retry logic
		const totalBatches = Math.ceil(jobTitles.length / batch);

		for (let i = 0; i < jobTitles.length; i += batch) {
			throwIfCancelled(signal);
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
				if (batchAttempt > 1) {
					stats?.incrementCounter("api.retries", 1);
					stats?.incrementCounter("network.retries", 1);
				}

				if (verbose) {
					log(
						"JobCloth",
						`=== BATCH ${Math.floor(i / batch) + 1}/${totalBatches} (Attempt ${batchAttempt}/${batchRetryAttempts}) ===`,
						"debug",
						{
							batchNumber: Math.floor(i / batch) + 1,
							totalBatches,
							attempt: batchAttempt,
							jobCount: batchTitles.length,
						},
					);
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
					userMessageContent += `\n\n--- Job Titles ---\n${batchTitles.join("\n")}`;
					userMessageContent += `\n\n--- Resume ---\n${resumeContent}`;

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
						showReasoningTokens: effectiveShowReasoningTokens,
						hideReasoningTokens: effectiveHideReasoning,
						showResponseStream,
						...(effectiveReasoningEffort !== undefined
							? { reasoning_effort: effectiveReasoningEffort }
							: {}),
						...(providerRouting ? { providerRouting } : {}),
					};

					if (verbose) {
						log("JobCloth", "LLM Request Payload:", "debug", {
							request: llmRequest,
						});
					}

					const result = await callLLMWithStats(llmRequest, stats, signal);

					// Record success for circuit breaker
					circuitBreaker.recordSuccess();

					if (verbose) {
						log(
							"JobCloth",
							"Batch API Response received successfully",
							"debug",
							{
								contentType: typeof result.content,
							},
						);
					}

					// Parse and validate using schema to ensure transforms and aliases are applied
					batchResults = JobAnalysisResultsArraySchema.parse(result.content);
					allAnalysisResults.push(...batchResults);
					batchSuccess = true;
					batchLastError = null;

					if (verbose) {
						log(
							"JobCloth",
							`Batch ${Math.floor(i / batch) + 1} processed successfully`,
							"debug",
						);
					}
					break; // Exit retry loop on success
				} catch (apiError: unknown) {
					rethrowIfCancelled(apiError, signal);
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
						await abortableDelay(batchDelay, signal);
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

				const recoveryProgress = createProgressReporter(logger, {
					label: "Stage 3/8: JobCloth",
					totalUnits: batchTitles.length,
					unitLabel: "recovery item",
					phase: "recovery progress",
				});
				recoveryProgress.start({
					batchNumber: Math.floor(i / batch) + 1,
				});
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
					effectiveShowReasoningTokens,
					showResponseStream,
					stats,
					effectiveReasoningEffort,
					providerRouting,
					signal,
					({ jobTitle, success }) => {
						recoveryProgress.complete({
							batchNumber: Math.floor(i / batch) + 1,
							jobTitle,
							outcome: success ? "recovered" : "failed",
						});
					},
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
			if (batchSuccess) {
				primaryCallProgress.complete({
					batchNumber: Math.floor(i / batch) + 1,
					totalBatches,
					jobTitlesInBatch: batchTitles.length,
				});
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
				await abortableDelay(sleep * 1000, signal);
			}
		}
	}

	// Map analysis results
	const analysisMap = new Map<
		string,
		z.infer<typeof JobAnalysisResultSchema>
	>();
	const normalizedAnalysisMap = new Map<
		string,
		z.infer<typeof JobAnalysisResultSchema>
	>();
	for (const result of allAnalysisResults) {
		if (result?.jobTitle) {
			analysisMap.set(result.jobTitle, result);
			normalizedAnalysisMap.set(result.jobTitle.trim().toLowerCase(), result);
		}
	}

	const getAnalysisForJob = (title: string) => {
		return (
			analysisMap.get(title) ??
			normalizedAnalysisMap.get(title.trim().toLowerCase())
		);
	};

	// Filter jobs
	const highlyAlignedJobs = allJobs.filter((job) => {
		const analysis = getAnalysisForJob(job.title);
		return Boolean(
			analysis?.isWorthInvestigating ||
				analysis?.isVeryHighlyAligned ||
				analysis?.isHighlyAligned,
		);
	});

	// Do not append jobCloth evaluation results to job records; pass only clean job data
	const cleanPassingJobs = highlyAlignedJobs.map((job) => {
		const {
			confidence: _unusedConfidence,
			rationale: _unusedRationale,
			isWorthInvestigating: _unusedWorth,
			isVeryHighlyAligned: _unusedVeryAligned,
			isHighlyAligned: _unusedAligned,
			...cleanJob
		} = job;
		return cleanJob as JobInterface;
	});

	// Passing and rejected jobs both completed jobCloth processing and begin the
	// same cool-off window at this successful classification event.
	await jobRepository.recordJobClothProcessed(allJobs);

	await fsPromises.writeFile(
		resolvedOutputFile,
		JSON.stringify(cleanPassingJobs, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
	await writeArtifactManifest(resolvedOutputFile, "jobCloth", {
		inputJobs: allJobs.length,
		outputJobs: cleanPassingJobs.length,
		preset: effectivePreset.name,
		model: effectivePreset.modelId,
	});
	if (stageInputHash) {
		await completeStageCheckpoint(
			"jobCloth",
			stageInputHash,
			resolvedOutputFile,
			effectivePreset.name,
			effectivePreset.modelId,
			cleanPassingJobs.length,
			jobRepository,
		);
	}
	stats?.incrementCounter("files.written", 1);
	stats?.incrementCounter(
		"jobCloth.jobsRejected",
		allJobs.length - cleanPassingJobs.length,
	);
	stats?.incrementCounter("jobCloth.jobsAccepted", cleanPassingJobs.length);
	stats?.recordSuccess("jobCloth.complete", {
		inputJobs: allJobs.length,
		outputJobs: cleanPassingJobs.length,
	});
	return cleanPassingJobs;
}

export const addJobClothCommand = (
	yargs: Argv<GlobalArgs>,
	jobClothPresets: string[], // Pass presets here
): Argv<GlobalArgs> => {
	return yargs.command({
		command: "jobCloth",
		describe:
			"Production-ready job role identification using AI providers with enhanced security, centralized LLM service, and comprehensive error handling. Auto-detects processed_jobs_*.json files in ./data/ if no input file is specified.",
		builder: (yy: Argv<GlobalArgs>) => {
			let builder: Argv = yy;
			builder = builder
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
					description:
						"Maximum number of tokens to generate in the response. Defaults to 16000 or preset value.",
					demandOption: false,
				})
				.option("ping-interval", {
					type: "number",
					description:
						"Interval in seconds to print a keepalive dot while waiting for the LLM response.",
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
				});

			return builder
				.option("show-reasoning", {
					alias: "sr",
					type: "boolean",
					description:
						"Display reasoning/thinking tokens from reasoning models live as they arrive.",
					default: false,
				})
				.option("show-reasoning-tokens", {
					type: "boolean",
					description: "Alias for --show-reasoning",
					default: false,
				})
				.option("hide-reasoning", {
					alias: "hr",
					type: "boolean",
					description: "Hide reasoning/thinking tokens from the LLM.",
					default: false,
				})
				.option("hide-reasoning-tokens", {
					type: "boolean",
					description: "Alias for --hide-reasoning",
					default: false,
				})
				.option("show-stream", {
					alias: "ss",
					type: "boolean",
					description:
						"Display response content tokens live as they stream in from the AI provider.",
					default: false,
				})
				.option("show-stream-tokens", {
					type: "boolean",
					description: "Alias for --show-stream",
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
				.option("jc-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for jobCloth LLM requests (e.g. low, medium, high, max).",
				})
				.option("reasoning-effort", {
					type: "string",
					description: "Alias for --jc-reasoning-effort",
				})
				.check(async (argv: Record<string, unknown>) => {
					const allPresets = await loadPresets();
					if (
						!argv.preset ||
						!getPreset("jobCloth", argv.preset as string, allPresets)
					) {
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

			log("JobCloth", "Command started", "info", {
				preset: typedArgv.preset,
				inputFile: typedArgv["input-file"],
				...(typedArgv.verbose ? { params: typedArgv } : {}),
			});

			const startTime = performance.now();

			if (typedArgv.verbose)
				log("JobCloth", "Preparing job alignment analysis", "debug");

			try {
				// Check if input file is explicitly provided or if it's the default glob
				let inputFiles: string | string[] = typedArgv["input-file"] as
					| string
					| string[];

				// If inputFiles is the default glob or pattern, find all processed_jobs*.json files
				if (
					inputFiles === "./data/processed_jobs_*.json" ||
					inputFiles === "./data/processed_jobs.json"
				) {
					// Changed condition
					const processedJobFiles = await findProcessedJobFiles();
					if (processedJobFiles.length === 0) {
						throw new Error(
							"No processed_jobs*.json files found in ./data/ directory. Please run processData first or provide a specific input file.",
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
				// Sampling parameters: respect preset definitions unless explicitly overridden by CLI arguments
				const hasCliTemperature =
					process.argv.includes("--temperature") ||
					process.argv.some((arg) => arg.startsWith("--temperature="));
				const effectiveTemperature =
					hasCliTemperature && typedArgv.temperature !== undefined
						? (typedArgv.temperature as number)
						: effectivePreset.temperature;

				const hasCliTopP =
					process.argv.includes("--top-p") ||
					process.argv.includes("--topP") ||
					process.argv.some(
						(arg) => arg.startsWith("--top-p=") || arg.startsWith("--topP="),
					);
				const effectiveTopP =
					hasCliTopP && typedArgv["top-p"] !== undefined
						? (typedArgv["top-p"] as number)
						: effectivePreset.topP;

				const hasCliMaxTokens =
					process.argv.includes("--max-tokens") ||
					process.argv.includes("--maxTokens") ||
					process.argv.some(
						(arg) =>
							arg.startsWith("--max-tokens=") || arg.startsWith("--maxTokens="),
					);
				const effectiveMaxTokens =
					hasCliMaxTokens && typedArgv["max-tokens"] !== undefined
						? (typedArgv["max-tokens"] as number)
						: (effectivePreset.maxTokens ?? 16000);

				const hideReasoning = Boolean(
					typedArgv["hide-reasoning"] ||
						typedArgv["hide-reasoning-tokens"] ||
						typedArgv.hr ||
						process.env.ASTROEX_HIDE_REASONING === "1",
				);
				const showReasoning =
					!hideReasoning &&
					Boolean(
						typedArgv["show-reasoning"] ||
							typedArgv["show-reasoning-tokens"] ||
							typedArgv.sr,
					);

				const rawReasoningEffort = (typedArgv["jc-reasoning-effort"] ??
					typedArgv["reasoning-effort"]) as string | undefined;
				const reasoningEffort =
					typeof rawReasoningEffort === "string" &&
					rawReasoningEffort.trim().length > 0
						? rawReasoningEffort.trim()
						: undefined;

				const result = await runJobCloth(
					Array.isArray(inputFiles)
						? (inputFiles[0] as string)
						: (inputFiles as string),
					outputFile as string,
					{
						apiKey,
						baseUrl: effectivePreset.base_url,
						modelId: effectivePreset.modelId,
						temperature: effectiveTemperature,
						topP: effectiveTopP,
						batch: typedArgv.batch as number,
						retries: typedArgv.retries as number,
						maxTokens: effectiveMaxTokens,
						pingInterval: typedArgv["ping-interval"] as number,
						openaiTimeout: typedArgv["openai-timeout"] as number,
						verbose: typedArgv.verbose as boolean,
						preset: typedArgv.preset as string,
						sleep: typedArgv.sleep as number,
						batchRetryAttempts: typedArgv["batch-retry-attempts"] as number,
						batchRetryDelay: typedArgv["batch-retry-delay"] as number,
						jobTitleRetryAttempts: typedArgv[
							"job-title-retry-attempts"
						] as number,
						circuitThreshold: typedArgv["circuit-threshold"] as number,
						circuitTimeout: typedArgv["circuit-timeout"] as number,
						showReasoningTokens: showReasoning,
						hideReasoningTokens: hideReasoning,
						showResponseStream: Boolean(
							typedArgv["show-stream"] ||
								typedArgv["show-stream-tokens"] ||
								typedArgv["stream-response"] ||
								typedArgv.ss,
						),
						...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
						stats,
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
					getDataDirectory(),
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
				process.exitCode = 1;
			} finally {
				// Always end statistics collection
				const summary = stats.endCollection();
				log("JobCloth", "Final statistics:", "info", { summary });
			}
		},
	}) as unknown as Argv<GlobalArgs>;
};
