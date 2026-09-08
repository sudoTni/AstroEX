import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { z } from "zod";
import { writeArtifactManifest } from "../artifactManifest";
import { type LLMRequest, llmService } from "../llmService";
import type { JobInterface } from "../models";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} from "../presets";
import {
	getDataDirectory,
	getLogsDirectory,
	getMaterialsDirectory,
	getProfileFile,
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
import type { GlobalArgs, Preset } from "../types";
import { getPreset } from "../types";
import {
	closeFileLogging,
	createLogger,
	formatDate,
	initializeFileLogging,
	log,
} from "../utils";
import { sleepWithJitter } from "../utils/delayUtils";
import { loadApplicationData } from "../utils/sharedCommandUtils";
import { withSpinner } from "../utils/spinner";

const logger = createLogger("MakeMaterials");

// Function to find all JSON files in astroapply_eval_pass directory
async function findEvaluatedJobFiles(): Promise<string[]> {
	const evalPassDirectory = path.join(
		getDataDirectory(),
		"astroapply_eval_pass",
	);
	try {
		const files = await fs.promises.readdir(evalPassDirectory);
		const jsonFiles = files
			.filter(
				(file: string) =>
					file.endsWith(".json") && !file.endsWith(".manifest.json"),
			)
			.map((file: string) => path.join(evalPassDirectory, file));

		if (jsonFiles.length === 0) {
			log(
				"MakeMaterials",
				"No JSON files found in ./data/astroapply_eval_pass/ directory",
				"warn",
			);
			return [];
		}

		log(
			"MakeMaterials",
			`Found ${jsonFiles.length} JSON files in astroapply_eval_pass directory`,
			"info",
			{
				files: jsonFiles,
			},
		);

		return jsonFiles;
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		log(
			"MakeMaterials",
			`Error reading astroapply_eval_pass directory: ${errorMessage}`,
			"error",
			{ error: errorMessage },
		);
		return [];
	}
}

// Helper function to parse the raw LLM output
const MaterialsResponseSchema = z.object({
	"Resume Filename": z.string().min(1),
	"Cover Letter Filename": z.string().min(1).optional(),
	"Optimized & Tailored Professional Title": z.string().min(1),
	"Optimized & Tailored Professional Summary": z.string().min(1),
	"Optimized & Tailored Key Skills": z.string().min(1),
	"Optimized & Tailored Cover Letter": z.string().min(1),
});

export function parseMaterialsResponse(
	responseText: string,
): z.infer<typeof MaterialsResponseSchema> {
	const sections: Record<string, string> = {};
	const lines = responseText.split("\n");
	let currentHeader = "";
	let currentContent: string[] = [];

	for (const line of lines) {
		const headerMatch = line.match(/^#{1,3}\s+(.+)$/);
		if (headerMatch) {
			if (currentHeader) {
				sections[currentHeader] = currentContent.join("\n").trim();
			}
			currentHeader = headerMatch[1].trim();
			currentContent = [];
		} else if (currentHeader) {
			currentContent.push(line);
		}
	}
	// Add the last section
	if (currentHeader) {
		sections[currentHeader] = currentContent.join("\n").trim();
	}

	return MaterialsResponseSchema.parse(sections);
}

// Singleton service for managing LLM and preset initialization
class MaterialsService {
	private static instance: MaterialsService;
	private isInitialized = false;
	private appData: {
		resume: string;
		professionalTitle: string;
		professionalSummary: string;
		keySkills: string;
		testimonials: string;
	} | null = null;

	private constructor() {}

	public static getInstance(): MaterialsService {
		if (!MaterialsService.instance) {
			MaterialsService.instance = new MaterialsService();
		}
		return MaterialsService.instance;
	}

	public async initializeServices(
		effectivePreset: Preset,
		apiKey: string,
	): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		// Initialize LLM service once
		llmService.initialize(
			[
				{
					name: effectivePreset.provider,
					baseUrl: effectivePreset.base_url,
					apiKey: apiKey,
					model: effectivePreset.modelId,
				},
			],
			effectivePreset.provider,
		);

		// Load external application data once
		this.appData = await loadApplicationData();

		this.isInitialized = true;
		log("MakeMaterials", "MaterialsService initialized successfully", "info");
	}

	public getAppData() {
		return this.appData;
	}

	public async generateMaterials(llmRequest: LLMRequest): Promise<unknown> {
		return await llmService.call(llmRequest);
	}
}

// Define a local interface for the arguments passed to runResumeOptimizationMode
export interface RunResumeOptimizationArgs {
	preset: string;
	apiKey: string;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	myProfessionalTitle?: string;
	myProfessionalSummary?: string;
	myKeySkills?: string;
	targJD?: string;
	resume?: string;
	testimonials?: string;
	coverLength?: number;
	verbose?: boolean;
	sleep?: number;
	sleepMin?: number;
	sleepMax?: number;
	maxRetries?: number;
	disableFileLogging?: boolean;
	logDir?: string;
	logFile?: string;
	jitter?: boolean;
	showReasoningTokens?: boolean;
	hideReasoningTokens?: boolean;
	showResponseStream?: boolean;
	stats?: StatisticsCollector;
	reasoningEffort?: string;
	"mm-reasoning-effort"?: string;
	"reasoning-effort"?: string;
	logPayload?: boolean;
	"log-payload"?: boolean;
}

/**
 * Unified handler for resume optimization modes
 */
export async function runResumeOptimizationMode(
	effectivePreset: Preset,
	args: RunResumeOptimizationArgs,
): Promise<{ content: unknown[]; error?: unknown }> {
	const rawReasoningEffort =
		args.reasoningEffort ??
		args["mm-reasoning-effort"] ??
		args["reasoning-effort"];
	const effectiveReasoningEffort =
		typeof rawReasoningEffort === "string" &&
		rawReasoningEffort.trim().length > 0
			? rawReasoningEffort.trim()
			: undefined;

	logger.info(`Running ROP - ${effectivePreset.name}`, {
		preset: effectivePreset.name,
		...(effectiveReasoningEffort
			? { reasoning_effort: effectiveReasoningEffort }
			: {}),
	});

	try {
		// Use singleton service for shared resources
		const service = MaterialsService.getInstance();
		await service.initializeServices(effectivePreset, args.apiKey);
		const appData = service.getAppData();

		// Gather dynamic inputs
		const myProfessionalTitle =
			args.myProfessionalTitle ??
			appData?.professionalTitle ??
			"[Professional Title]";
		const myProfessionalSummary =
			args.myProfessionalSummary ??
			appData?.professionalSummary ??
			"[Professional Summary]";
		const myKeySkills =
			args.myKeySkills ?? appData?.keySkills ?? "[Key Skills]";
		const resume =
			args.resume ??
			appData?.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData?.testimonials ?? "[Testimonials go here]";
		let coverLength = args.coverLength ?? 275;

		// Handle job descriptions - either from individual JD or from astroapply_eval_pass directory
		let jobDescriptions: string[] = [];
		let jobMetadata: Record<string, unknown>[] = [];

		if (args.targJD) {
			// Single JD provided via CLI
			jobDescriptions = [args.targJD];
			jobMetadata = [
				{
					targJD: args.targJD,
					myProfessionalTitle,
					myProfessionalSummary,
					myKeySkills,
					resume,
					testimonials,
				},
			];
		} else {
			// Auto-detect JSON files from astroapply_eval_pass directory
			const jobFiles = await findEvaluatedJobFiles();
			if (jobFiles.length === 0) {
				throw new Error(
					"No job descriptions found. Please provide a --targ-jd or ensure JSON files exist in ./data/astroapply_eval_pass/",
				);
			}

			// Read all job files and extract full JSON content
			for (const jobFile of jobFiles) {
				try {
					const fileContent = await fs.promises.readFile(jobFile, "utf-8");
					args.stats?.incrementCounter("files.opened", 1);
					args.stats?.incrementCounter("files.read", 1);
					args.stats?.incrementCounter("data.filesProcessed", 1);
					const jobData: JobInterface = JSON.parse(fileContent);

					// Insert entire contents of the JSON JD file into the outbound LLM payload
					jobDescriptions.push(JSON.stringify(jobData, null, 2));

					jobMetadata.push({
						targJD: JSON.stringify(jobData, null, 2),
						myProfessionalTitle,
						myProfessionalSummary,
						myKeySkills,
						resume,
						testimonials,
						jobFile: path.basename(jobFile),
						jobTitle: jobData.title,
						company: jobData.company,
					});
				} catch (error: unknown) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					args.stats?.recordError(new Error(errorMessage), { jobFile });
					log(
						"MakeMaterials",
						`Error reading job file ${jobFile}: ${errorMessage}`,
						"error",
					);
				}
			}
		}
		args.stats?.incrementCounter(
			"data.recordsProcessed",
			jobDescriptions.length,
		);

		// In er44zz.py, cover_length is adjusted for gpt-4.1
		if (effectivePreset.modelId.includes("gpt-4.1")) {
			// Assuming gpt-4.1 is a specific model ID
			coverLength = 280;
		}

		// Apply preset-specific defaults, overridden by CLI args
		const temperature = args.temperature ?? effectivePreset.temperature;
		const topP = args.topP ?? effectivePreset.topP;
		const maxTokens = args.maxTokens ?? effectivePreset.maxTokens;

		// Create main materials directory
		const materialsDir = getMaterialsDirectory();
		await fs.promises.mkdir(materialsDir, { recursive: true });

		// Generate timestamp for batch
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

		const repo = await getSharedJobRepository();
		const batchInputSignature = crypto
			.createHash("sha256")
			.update(jobDescriptions.join("\n"))
			.digest("hex");
		const existingCheckpoint = repo.getStageCheckpoint(
			"makeMaterials",
			batchInputSignature,
			effectivePreset.name,
			effectivePreset.modelId,
		);
		const processedJobIds = new Set(existingCheckpoint?.processedJobIds ?? []);

		if (existingCheckpoint && existingCheckpoint.status === "completed") {
			log(
				"MakeMaterials",
				`Durable checkpoint match: makeMaterials already completed for current jobs with preset ${effectivePreset.name}.`,
				"info",
			);
			return { content: [] };
		}

		await initStageCheckpoint(
			"makeMaterials",
			"eval_pass_batch",
			batchInputSignature,
			materialsDir,
			effectivePreset.name,
			effectivePreset.modelId,
			jobDescriptions.length,
			Array.from(processedJobIds),
			repo,
		);

		// Process each job separately with individual output directories
		const allResults: Record<string, unknown>[] = [];

		for (let i = 0; i < jobDescriptions.length; i++) {
			const jobDescription = jobDescriptions[i];
			const jobMeta = jobMetadata[i];

			const jobIdentityKey = String(
				jobMeta.jobId && jobMeta.jobId !== "N/A"
					? jobMeta.jobId
					: (jobMeta.jobFile ?? `${jobMeta.company}:${jobMeta.jobTitle}`),
			);
			if (processedJobIds.has(jobIdentityKey)) {
				log(
					"MakeMaterials",
					`Skipping already generated materials for ${jobIdentityKey} from durable checkpoint.`,
					"info",
				);
				continue;
			}

			if (args.verbose) {
				logger.info(`Processing Job ${i + 1}/${jobDescriptions.length}`, {
					jobIndex: i + 1,
					totalJobs: jobDescriptions.length,
					jobTitle: jobMeta.jobTitle,
					company: jobMeta.company,
				});
			}

			const placeholderData = {
				targJD: jobDescription,
				myResume: resume,
				myProfessionalTitle,
				myProfessionalSummary,
				myKeySkills,
				myTestimonials: testimonials,
				cover_length: coverLength.toString(), // Ensure it's a string for replacement
			};

			const userMessageContent = await loadAndReplacePromptTemplate(
				effectivePreset.promptTemplate,
				placeholderData,
			);

			// Initialize singleton service once
			const service = MaterialsService.getInstance();
			await service.initializeServices(effectivePreset, args.apiKey);

			const hideReasoning = Boolean(
				args.hideReasoningTokens || process.env.ASTROEX_HIDE_REASONING === "1",
			);
			const showReasoning = !hideReasoning && Boolean(args.showReasoningTokens);

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
					{ role: "system", content: await loadVeritasSystemPrompt() },
					{ role: "user", content: userMessageContent },
				],
				temperature: temperature,
				topP: topP,
				maxTokens: maxTokens || 16000,
				timeout: 30000,
				showReasoningTokens: showReasoning,
				hideReasoningTokens: hideReasoning,
				showResponseStream: args.showResponseStream,
				...(effectiveReasoningEffort !== undefined
					? { reasoning_effort: effectiveReasoningEffort }
					: {}),
			};

			if (
				args.logPayload ||
				(args as unknown as Record<string, unknown>)["log-payload"]
			) {
				const logDir = args.logDir || getLogsDirectory();
				await fs.promises.mkdir(logDir, { recursive: true });
				const payloadFile = path.join(
					logDir,
					`makematerials_${String(jobMeta.jobTitle || `job_${i + 1}`).replace(/[^a-zA-Z0-9]/g, "_")}_payload_${timestamp}.json`,
				);
				await fs.promises.writeFile(
					payloadFile,
					JSON.stringify(llmRequest, null, 2),
					{ encoding: "utf-8", mode: 0o600 },
				);
				log(
					"MakeMaterials",
					`Outbound LLM payload saved to: ${payloadFile}`,
					"info",
				);
			}

			if (args.verbose) {
				log("MakeMaterials", "LLM Request Payload:", "debug", {
					request: llmRequest,
				});
			}

			// Process this job individually using the singleton service
			const apiStartedAt = performance.now();
			args.stats?.incrementCounter("api.totalCalls", 1);
			args.stats?.incrementCounter("network.connections", 1);
			let result: { content: string };
			try {
				result = (await withSpinner(
					`Waiting for LLM response for "${String(jobMeta.jobTitle || `job ${i + 1}`)}" (${i + 1}/${jobDescriptions.length})...`,
					() => service.generateMaterials(llmRequest),
					{
						enabled:
							!llmRequest.showReasoningTokens && !llmRequest.showResponseStream,
					},
				)) as { content: string };
				args.stats?.incrementCounter("api.successfulCalls", 1);
				args.stats?.recordHistogram(
					"api.responseTime",
					performance.now() - apiStartedAt,
				);
			} catch (error) {
				args.stats?.incrementCounter("api.failedCalls", 1);
				args.stats?.recordHistogram(
					"api.responseTime",
					performance.now() - apiStartedAt,
				);
				const message = error instanceof Error ? error.message : String(error);
				if (/timeout|timed out/i.test(message)) {
					args.stats?.incrementCounter("network.timeouts", 1);
				}
				throw error;
			}

			// Parse the raw text response
			const parsedMaterials = parseMaterialsResponse(result.content);

			// Create job-specific output directory from the parsed filename
			const resumeFilename =
				parsedMaterials["Resume Filename"] ||
				`Candidate_Materials_Fallback_${timestamp}`;
			const safeJobTitleForDir = resumeFilename
				.replace("Candidate_Materials_", "")
				.replace(/[^a-zA-Z0-9]/g, "_");
			const jobOutputDir = path.join(
				materialsDir,
				`${safeJobTitleForDir}_${timestamp}`,
			);
			await fs.promises.mkdir(jobOutputDir, { recursive: true });

			// Extract job metadata from the job description JSON
			let jobTitle = "N/A";
			let jobCompany = "N/A";
			let jobUrl = "N/A";
			let jobId = "N/A";
			let jobPostedDate = "N/A";

			try {
				const jobData: JobInterface = JSON.parse(jobDescription);
				jobTitle = jobData.title || String(jobMeta.jobTitle) || "N/A";
				jobCompany = jobData.company || String(jobMeta.company) || "N/A";
				jobUrl = jobData.url || "N/A";
				jobId = jobData.id || "N/A";
				jobPostedDate = jobData.postedDate ? String(jobData.postedDate) : "N/A";
			} catch (_error) {
				// If parsing fails, use the metadata from jobMeta
				jobTitle = String(jobMeta.jobTitle) || "N/A";
				jobCompany = String(jobMeta.company) || "N/A";
				jobUrl = "N/A";
				jobId = "N/A";
				jobPostedDate = "N/A";
			}

			// Create a single text file with all generated materials
			const outputFileContent = `# Job Metadata
		
		**Job Title:** ${jobTitle}
		**Company:** ${jobCompany}
		**Job URL:** ${jobUrl}
		**Job ID:** ${jobId}
		**Posted Date:** ${jobPostedDate}
		
		---
		
		# Materials Filename
		
		${resumeFilename}
		
# Cover Letter Filename
		
${parsedMaterials["Cover Letter Filename"] || "Cover letter filename not generated."}
		
# Optimized & Tailored Professional Title
		
${parsedMaterials["Optimized & Tailored Professional Title"] || "Title not generated."}
		
# Optimized & Tailored Professional Summary
		
${parsedMaterials["Optimized & Tailored Professional Summary"] || "Summary not generated."}
		
# Optimized & Tailored Key Skills
		
${parsedMaterials["Optimized & Tailored Key Skills"] || "Skills not generated."}
		
# Optimized & Tailored Cover Letter
		
${parsedMaterials["Optimized & Tailored Cover Letter"] || "Cover letter not generated."}`;

			// Sanitize filename to handle special characters like slashes
			const safeFilename = resumeFilename.replace(/[^a-zA-Z0-9]/g, "_");
			const outputFile = path.join(jobOutputDir, `${safeFilename}.txt`);
			await fs.promises.writeFile(outputFile, outputFileContent, {
				encoding: "utf-8",
				mode: 0o600,
			});
			await writeArtifactManifest(outputFile, "makeMaterials", {
				preset: effectivePreset.name,
				model: effectivePreset.modelId,
				jobTitle,
				company: jobCompany,
			});
			repo.recordJobInCheckpoint(
				"makeMaterials",
				batchInputSignature,
				effectivePreset.name,
				effectivePreset.modelId,
				jobIdentityKey,
			);
			args.stats?.incrementCounter("files.written", 1);

			const logInfo = {
				jobTitle: jobMeta.jobTitle,
				outputFile: outputFile,
				outputDirectory: jobOutputDir,
			};

			log(
				"MakeMaterials",
				`Generated materials for: ${jobMeta.jobTitle}`,
				"info",
				logInfo,
			);
			allResults.push(logInfo);

			if (args.verbose) {
				logger.success(`Generated materials for: ${jobMeta.jobTitle}`, {
					jobTitle: jobMeta.jobTitle,
					outputFile,
				});
			}

			// Sleep between processing jobs if not the last job
			if (i < jobDescriptions.length - 1) {
				const useJitter = args.jitter !== false; // Default to true
				const sleepMin = args.sleepMin ?? 2.5;
				const sleepMax = args.sleepMax ?? 4.5;
				const fallbackSleep = 3;

				let sleepDuration: number;

				if (useJitter) {
					log(
						"MakeMaterials",
						`Sleeping for ${sleepMin}-${sleepMax} seconds (jitter) before next job...`,
						"log",
						{
							sleepMin,
							sleepMax,
							jitter: true,
							currentJob: i + 1,
							totalJobs: jobDescriptions.length,
						},
					);
					await sleepWithJitter(sleepMin, sleepMax);
				} else {
					// Use fixed sleep duration
					sleepDuration = args.sleep ?? fallbackSleep;
					log(
						"MakeMaterials",
						`Sleeping for ${sleepDuration} seconds before next job...`,
						"log",
						{
							sleepDuration,
							jitter: false,
							currentJob: i + 1,
							totalJobs: jobDescriptions.length,
						},
					);
					await new Promise((res) => setTimeout(res, sleepDuration * 1000));
				}
			}
		}

		repo.completeStageCheckpoint(
			"makeMaterials",
			batchInputSignature,
			effectivePreset.name,
			effectivePreset.modelId,
			"completed",
			jobDescriptions.length,
		);

		args.stats?.incrementCounter("materials.generated", allResults.length);
		args.stats?.recordSuccess("makeMaterials.complete", {
			jobsProcessed: allResults.length,
		});
		return { content: allResults };
	} catch (error) {
		return { content: [], error };
	}
}

/**
 * Unified command handler for resume optimization modes
 */
async function handleResumeOptimizationCommand(argv: unknown): Promise<void> {
	// Initialize statistics collection
	const stats = createStatisticsCollector("makeMaterials");
	stats.startCollection();

	const startTime = performance.now();

	if (!(argv as Record<string, unknown>).disableFileLogging) {
		const logDir = String(
			(argv as Record<string, unknown>)["log-dir"] ?? "./logs",
		);
		const logFile = `${formatDate(new Date(), "yyyyMMdd_HHmmss")}_make_materials.log`;
		initializeFileLogging(logDir, logFile, "makeMaterials");
	}

	try {
		// Load all presets
		const allPresets = await loadPresets();
		const _veritasSystemPrompt = await loadVeritasSystemPrompt();

		// Cast argv to proper type for access
		const typedArgv = argv as Record<string, unknown>;

		// Determine effective preset
		const effectivePreset = getPreset(
			"makeMaterials",
			typedArgv.preset as string,
			allPresets,
		);
		if (!effectivePreset) {
			throw new Error(
				`Preset '${typedArgv.preset}' not found for makeMaterials command. Available presets for makeMaterials: ${Object.keys(allPresets.makeMaterials || {}).join(", ")}`,
			);
		}

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

		const result = await runResumeOptimizationMode(effectivePreset, {
			...typedArgv, // Pass all argv to runResumeOptimizationMode
			baseUrl: effectivePreset.base_url,
			model: effectivePreset.modelId,
			temperature:
				(typedArgv.temperature as number) ?? effectivePreset.temperature,
			topP: (typedArgv["top-p"] as number) ?? effectivePreset.topP,
			maxTokens:
				(typedArgv["max-tokens"] as number) ?? effectivePreset.maxTokens,
			showReasoningTokens: showReasoning,
			hideReasoningTokens: hideReasoning,
			showResponseStream: Boolean(
				typedArgv["show-stream"] ||
					typedArgv["show-stream-tokens"] ||
					typedArgv["stream-response"] ||
					typedArgv.ss,
			),
			stats,
		} as unknown as RunResumeOptimizationArgs);

		if (result.error) {
			throw result.error;
		}

		const endTime = performance.now();
		const duration = ((endTime - startTime) / 1000).toFixed(2);

		// Generate and display statistics
		const summary = stats.endCollection();

		log(
			"MakeMaterials",
			`Preset ${effectivePreset.name} processing completed in ${duration}s`,
			"info",
			{
				duration,
				jobsProcessed: result.content.length,
				statistics: summary,
			},
		);

		logger.success(
			`Successfully generated materials for ${result.content.length} job(s)`,
			{
				jobCount: result.content.length,
				materialsDirectory: getMaterialsDirectory(),
			},
		);

		if ((argv as Record<string, unknown>).verbose) {
			for (const item of result.content) {
				if (typeof item === "object" && item !== null && "jobTitle" in item) {
					logger.info(`Generated: ${(item as { jobTitle: string }).jobTitle}`);
				}
			}
		}

		// Export statistics to file
		const statsFile = path.join(
			getMaterialsDirectory(),
			`make-materials-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
		);
		await fs.promises.writeFile(statsFile, stats.export("json"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		log("MakeMaterials", `Statistics exported to: ${statsFile}`, "info");
	} catch (error: unknown) {
		const endTime = performance.now();
		const _duration = ((endTime - startTime) / 1000).toFixed(2);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(`makeMaterials command failed: ${errorMessage}`, error);
		throw error;
	} finally {
		// Always end statistics collection
		const summary = stats.endCollection();
		log("MakeMaterials", "Final statistics:", "info", { summary });

		await closeFileLogging();
	}
}

/**
 * Register CLI commands for makeMaterials modes.
 */
export function addMakeMaterialsCommands(
	yargs: Argv<GlobalArgs>,
	passedPresets?: string[],
) {
	return yargs.command(
		"makeMaterials",
		"Production-ready resume optimization using centralized LLM service with enhanced security and comprehensive error handling",
		(yargs: Argv<GlobalArgs>) => {
			let makeMaterialsPresets: string[] = passedPresets || [];
			if (makeMaterialsPresets.length === 0) {
				try {
					const fs = require("node:fs");
					const path = require("node:path");
					const presetsPath = path.join(
						process.cwd(),
						"config",
						"presets.json",
					);
					const presetsContent = fs.readFileSync(presetsPath, "utf-8");
					const presets = JSON.parse(presetsContent);
					makeMaterialsPresets = Object.keys(presets.makeMaterials || {});
				} catch {
					makeMaterialsPresets = [
						"rop_ds-v4-f-0731",
						"rop_g5m_poe",
						"rop_g5_poe",
						"rop_oai-g5m",
						"rop_z-glma",
						"rop_a-cs4",
						"rop_ds-v3-0324",
						"rop_m-l_01",
					];
				}
			}

			return (yargs as unknown as Argv<GlobalArgs>)
				.option("preset", {
					type: "string",
					description: `Preset to use for resume optimization (required). Available presets: ${makeMaterialsPresets.join(", ")}`,
					choices: makeMaterialsPresets,
					demandOption: true, // Preset is mandatory
				})
				.option("api-key", {
					type: "string",
					description: "API key for authentication (required)",
					demandOption: true, // API key is required via CLI
				})
				.option("cover-length", {
					type: "number",
					default: 275,
					description:
						"Cover letter length in words (default: 275, 280 for gpt-4.1 models)",
				})
				.option("sleep-min", {
					type: "number",
					default: 2.5,
					description:
						"Minimum delay in seconds between requests. Defaults to 2.5. Used with --sleep-max for jitter range.",
				})
				.option("sleep-max", {
					type: "number",
					default: 4.5,
					description:
						"Maximum delay in seconds between requests. Defaults to 4.5. Used with --sleep-min for jitter range.",
				})
				.option("max-retries", {
					type: "number",
					default: 3,
					description:
						"Maximum number of retry attempts for failed requests. Defaults to 3.",
				})
				.option("jitter", {
					type: "boolean",
					default: true,
					description:
						"Enable jitter for randomized delays between requests. Defaults to true.",
				})
				.option("use-sys-prompt", {
					type: "boolean",
					default: true,
					description:
						"Whether to use system prompts (deprecated, veritas system prompt is always used)",
				})
				.option("test-mode", {
					type: "number",
					default: 0,
					description: "Test mode (0=normal, 1=test, 2=debug)",
				})
				.option("thoughts", {
					type: "boolean",
					default: false,
					description: "Include thoughts in output",
				})
				.option("my-professional-title", {
					type: "string",
					description:
						"Override original professional title (loads from my_professional_title.txt if not provided)",
				})
				.option("my-professional-summary", {
					type: "string",
					description:
						"Override original professional summary (loads from my_professional_summary.txt if not provided)",
				})
				.option("my-key-skills", {
					type: "string",
					description:
						"Override original key skills (loads from my_key_skills.txt if not provided)",
				})
				.option("targ-jd", {
					type: "string",
					description:
						"Target job description as string (optional - if not provided, auto-detects JSON files from ./data/astroapply_eval_pass/)",
				})
				.option("resume", {
					type: "string",
					description:
						"Override resume content (loads from my_resume.txt if not provided)",
				})
				.option("testimonials", {
					type: "string",
					description:
						"Override testimonials content (loads from my_testimonials.txt if not provided)",
				})
				.option("verbose", {
					alias: "v",
					type: "boolean",
					description:
						"Display detailed processing information and debug output",
					default: false,
				})
				.option("log-payload", {
					type: "boolean",
					description:
						"Save sensitive outbound LLM payload to ./logs (owner-readable only).",
					default: false,
				})
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
				.option("mm-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for makeMaterials LLM requests (e.g. low, medium, high, max).",
				})
				.option("reasoning-effort", {
					type: "string",
					description: "Alias for --mm-reasoning-effort",
				})
				.check((argv: unknown) => {
					// Basic validation - preset validation happens during execution
					const typedArgv = argv as Record<string, unknown>;
					if (!typedArgv.preset) {
						throw new Error("Preset is required");
					}
					if (!typedArgv["api-key"]) {
						throw new Error("API key is required");
					}

					const sleepMin = Number(typedArgv["sleep-min"]);
					const sleepMax = Number(typedArgv["sleep-max"]);
					if (sleepMin < 0 || sleepMax < 0) {
						throw new Error("Sleep delays cannot be negative");
					}
					if (sleepMin > sleepMax) {
						throw new Error("--sleep-min cannot be greater than --sleep-max");
					}
					return true;
				});
		},
		async (argv: unknown) => {
			await handleResumeOptimizationCommand(argv);
		},
	);
}
