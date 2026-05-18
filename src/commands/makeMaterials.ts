import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { type LLMRequest, llmService } from "../llmService";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadVeritasSystemPrompt,
} from "../presets";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs, JobInterface, Preset } from "../types";
import { getPreset } from "../types";
import {
	closeFileLogging,
	formatDate,
	initializeFileLogging,
	log,
} from "../utils";
import { sleepWithJitter } from "../utils/delayUtils";

// Function to read external files
async function readExternalFile(fileName: string): Promise<string> {
	const rootDirectory = path.resolve(__dirname, "..", "..");
	const filePath = path.join(rootDirectory, "user_data", fileName);
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read external file ${fileName}: ${error}`);
	}
}

// Function to find all JSON files in astroapply_eval_pass directory
async function findEvaluatedJobFiles(): Promise<string[]> {
	const evalPassDirectory = path.join(
		process.cwd(),
		"data",
		"astroapply_eval_pass",
	);
	try {
		const files = await fs.promises.readdir(evalPassDirectory);
		const jsonFiles = files
			.filter((file) => file.endsWith(".json"))
			.map((file) => path.join(evalPassDirectory, file));

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
function parseMaterialsResponse(responseText: string): Record<string, string> {
	const sections: Record<string, string> = {};
	const lines = responseText.split("\n");
	let currentHeader = "";
	let currentContent: string[] = [];

	for (const line of lines) {
		if (line.startsWith("# ")) {
			if (currentHeader) {
				sections[currentHeader] = currentContent.join("\n").trim();
			}
			currentHeader = line.substring(2).trim(); // e.g., "Resume Filename"
			currentContent = [];
		} else if (currentHeader) {
			currentContent.push(line);
		}
	}
	// Add the last section
	if (currentHeader) {
		sections[currentHeader] = currentContent.join("\n").trim();
	}

	return sections;
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
		this.appData = await this.loadApplicationDataInternal();

		this.isInitialized = true;
		log("MakeMaterials", "MaterialsService initialized successfully", "info");
	}

	private async loadApplicationDataInternal(): Promise<{
		resume: string;
		professionalTitle: string;
		professionalSummary: string;
		keySkills: string;
		testimonials: string;
	}> {
		const [
			resume,
			professionalTitle,
			professionalSummary,
			keySkills,
			testimonials,
		] = await Promise.all([
			readExternalFile("my_resume.txt"),
			readExternalFile("my_professional_title.txt"),
			readExternalFile("my_professional_summary.txt"),
			readExternalFile("my_key_skills.txt"),
			readExternalFile("my_testimonials.txt"),
		]);

		return {
			resume,
			professionalTitle,
			professionalSummary,
			keySkills,
			testimonials,
		};
	}

	public getAppData() {
		return this.appData;
	}

	public async generateMaterials(llmRequest: LLMRequest): Promise<unknown> {
		return await llmService.call(llmRequest);
	}
}

// Function to load all external application data
export async function loadApplicationData(): Promise<{
	resume: string;
	professionalTitle: string;
	professionalSummary: string;
	keySkills: string;
	testimonials: string;
}> {
	const service = MaterialsService.getInstance();
	if (!service.getAppData()) {
		await service.initializeServices({} as Preset, "");
	}
	return service.getAppData()!;
}

// Define a local interface for the arguments passed to runResumeOptimizationMode
interface RunResumeOptimizationArgs {
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
}

/**
 * Unified handler for resume optimization modes
 */
async function runResumeOptimizationMode(
	effectivePreset: Preset,
	args: RunResumeOptimizationArgs,
): Promise<{ content: unknown[]; error?: unknown }> {
	console.log(`Running ROP - ${effectivePreset.name}`);

	try {
		// Use singleton service for shared resources
		const service = MaterialsService.getInstance();
		await service.initializeServices(effectivePreset, args.apiKey);
		const appData = service.getAppData()!;

		// Gather dynamic inputs
		const myProfessionalTitle =
			args.myProfessionalTitle ??
			appData.professionalTitle ??
			"[Professional Title]";
		const myProfessionalSummary =
			args.myProfessionalSummary ??
			appData.professionalSummary ??
			"[Professional Summary]";
		const myKeySkills = args.myKeySkills ?? appData.keySkills ?? "[Key Skills]";
		const resume =
			args.resume ??
			appData.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData.testimonials ?? "[Testimonials go here]";
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
					log(
						"MakeMaterials",
						`Error reading job file ${jobFile}: ${errorMessage}`,
						"error",
					);
				}
			}
		}

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
		const materialsDir = path.join(process.cwd(), "materials");
		await fs.promises.mkdir(materialsDir, { recursive: true });

		// Generate timestamp for batch
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

		// Process each job separately with individual output directories
		const allResults: Record<string, unknown>[] = [];

		for (let i = 0; i < jobDescriptions.length; i++) {
			const jobDescription = jobDescriptions[i];
			const jobMeta = jobMetadata[i];

			if (args.verbose) {
				console.log(
					`\n--- Processing Job ${i + 1}/${jobDescriptions.length} ---`,
				);
				console.log(`Title: ${jobMeta.jobTitle}`);
				console.log(`Company: ${jobMeta.company}`);
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
			};

			// Process this job individually using the singleton service
			const result = (await service.generateMaterials(llmRequest)) as {
				content: string;
			};

			// Parse the raw text response
			const parsedMaterials = parseMaterialsResponse(result.content);

			// Create job-specific output directory from the parsed filename
			const resumeFilename =
				parsedMaterials["Resume Filename"] ||
				`Michael_Martini_Materials_Fallback_${timestamp}`;
			const safeJobTitleForDir = resumeFilename
				.replace("Michael_Martini_Materials_", "")
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
				jobPostedDate = jobData.postedDate || "N/A"; // postedDate is string
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
			await fs.promises.writeFile(outputFile, outputFileContent);

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
				console.log(`✅ Generated materials for: ${jobMeta.jobTitle}`);
				console.log(`📁 Output file: ${outputFile}`);
			}

			// Sleep between processing jobs if not the last job
			if (i < jobDescriptions.length - 1) {
				const useJitter = args.jitter !== false; // Default to true
				const sleepMin = args.sleepMin || 2.5;
				const sleepMax = args.sleepMax || 4.5;
				const fallbackSleep = 3;

				let sleepDuration: number;

				if (useJitter) {
					// Use jitter with sleepMin/sleepMax range
					sleepDuration = Math.random() * (sleepMax - sleepMin) + sleepMin;
					log(
						"MakeMaterials",
						`Sleeping for ${sleepDuration.toFixed(2)} seconds (jitter: ${sleepMin}-${sleepMax}s) before next job...`,
						"log",
						{
							sleepDuration,
							sleepMin,
							sleepMax,
							jitter: true,
							currentJob: i + 1,
							totalJobs: jobDescriptions.length,
						},
					);
					await new Promise((res) => setTimeout(res, sleepDuration * 1000));
				} else {
					// Use fixed sleep duration
					sleepDuration = args.sleep || fallbackSleep;
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

		return { content: allResults };
	} catch (error) {
		console.error(`Error in runResumeOptimizationMode:`, error);
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
			stats.recordError(
				new Error(
					`Preset '${typedArgv.preset}' not found for makeMaterials command`,
				),
			);
			throw new Error(
				`Preset '${typedArgv.preset}' not found for makeMaterials command. Available presets for makeMaterials: ${Object.keys(allPresets.makeMaterials || {}).join(", ")}`,
			);
		}

		const result = await runResumeOptimizationMode(effectivePreset, {
			...typedArgv, // Pass all argv to runResumeOptimizationMode
			baseUrl: effectivePreset.base_url,
			model: effectivePreset.modelId,
			temperature:
				(typedArgv.temperature as number) ?? effectivePreset.temperature,
			topP: (typedArgv["top-p"] as number) ?? effectivePreset.topP,
			maxTokens:
				(typedArgv["max-tokens"] as number) ?? effectivePreset.maxTokens,
			apiKey: typedArgv["api-key"] as string, // Pass apiKey explicitly
		} as unknown as RunResumeOptimizationArgs);

		if (result.error) {
			const errorMessage =
				result.error instanceof Error
					? result.error.message
					: String(result.error);
			stats.recordError(
				result.error instanceof Error ? result.error : new Error(errorMessage),
			);
			log(
				"MakeMaterials",
				`Error processing mode with preset ${effectivePreset.name}: ${errorMessage}`,
				"error",
			);
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

		console.log(
			`\n✅ Successfully generated materials for ${result.content.length} job(s)`,
		);
		console.log(
			`📁 Main materials directory: ${path.join(process.cwd(), "materials")}`,
		);

		if ((argv as Record<string, unknown>).verbose) {
			console.log("\nGenerated materials for each job:");
			result.content.forEach((item: unknown) => {
				if (typeof item === "object" && item !== null && "jobTitle" in item) {
					console.log(`  • ${(item as { jobTitle: string }).jobTitle}`);
				}
			});
		}

		// Export statistics to file
		const statsFile = path.join(
			process.cwd(),
			"materials",
			`make-materials-stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
		);
		await fs.promises.writeFile(statsFile, stats.export("json"), "utf-8");
		log("MakeMaterials", `Statistics exported to: ${statsFile}`, "info");
	} catch (error: unknown) {
		const endTime = performance.now();
		const _duration = ((endTime - startTime) / 1000).toFixed(2);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		const errorMessage = error instanceof Error ? error.message : String(error);
		log(
			"MakeMaterials",
			`makeMaterials command failed: ${errorMessage}`,
			"error",
		);
		console.log(
			`\n❌ Error generating materials: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		throw error;
	} finally {
		// Always end statistics collection
		const summary = stats.endCollection();
		log("MakeMaterials", "Final statistics:", "info", { summary });

		await closeFileLogging();
		setTimeout(() => process.exit(0), 1000);
	}
}

/**
 * Register CLI commands for makeMaterials modes.
 */
export function addMakeMaterialsCommands(yargs: Argv<GlobalArgs>) {
	return yargs.command(
		"makeMaterials",
		"Production-ready resume optimization using centralized LLM service with enhanced security and comprehensive error handling",
		(yargs: Argv<GlobalArgs>) => {
			// Make builder synchronous for help display
			// Try to load presets synchronously for help, fallback to static list
			let makeMaterialsPresets: string[];
			try {
				// Attempt to load presets dynamically by reading the JSON file directly
				const fs = require("node:fs");
				const path = require("node:path");
				const presetsPath = path.join(
					__dirname,
					"..",
					"..",
					"config",
					"presets.json",
				);
				const presetsContent = fs.readFileSync(presetsPath, "utf-8");
				const presets = JSON.parse(presetsContent);
				makeMaterialsPresets = Object.keys(presets.makeMaterials || []);
			} catch {
				// Fallback to static list if dynamic loading fails
				makeMaterialsPresets = [
					"rop_g5m_poe",
					"rop_g5_poe",
					"rop_oai-g5m",
					"rop_z-glma",
					"rop_a-cs4",
					"rop_ds-v3-0324",
					"rop_m-l_01",
				];
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
						"Save outbound LLM payload to ./logs folder for debugging",
					default: false,
				})
				.check((argv: unknown) => {
					// Basic validation - preset validation happens during execution
					if (!(argv as Record<string, unknown>).preset) {
						throw new Error("Preset is required");
					}
					if (!(argv as Record<string, unknown>)["api-key"]) {
						throw new Error("API key is required");
					}
					return true;
				});
		},
		async (argv: unknown) => {
			await handleResumeOptimizationCommand(argv);
		},
	);
}
