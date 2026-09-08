import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Argv } from "yargs";
import { type PipelineConfig, buildPipelineConfig } from "../pipelineConfig";
import { getPreset, loadPresets } from "../presets";
import {
	getDataDirectory,
	getLogsDirectory,
	getMaterialsDirectory,
} from "../runtimePaths";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	createLogger,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import { runAcquireJobs } from "./acquireJobs";
import { runJobCloth } from "./jobCloth";
import { runJobJudge } from "./jobJudge";
import { runResumeOptimizationMode } from "./makeMaterials";
import { assertPreflight } from "./preflight";
import { processAcquiredJobs } from "./processData";

const logger = createLogger("Pipeline");

export interface RunPipelineOptions extends GlobalArgs {
	config?: string;
	clean?: boolean;
	deploy?: boolean;
	"deploy-destination"?: string;
	"api-key"?: string;
	"search-terms-file"?: string;
	"results-wanted"?: number;
	"hours-old"?: number;
	"jobcloth-preset"?: string;
	"jobjudge-preset"?: string;
	"makematerials-preset"?: string;
	batch?: number;
	sleep?: number;
	"skip-acquisition"?: boolean;
	"skip-materials"?: boolean;
	"show-reasoning"?: boolean;
	"show-reasoning-tokens"?: boolean;
	"hide-reasoning"?: boolean;
	"hide-reasoning-tokens"?: boolean;
	hr?: boolean;
	sr?: boolean;
	"jc-reasoning-effort"?: string;
	"jj-reasoning-effort"?: string;
	"mm-reasoning-effort"?: string;
	"remote-only"?: boolean;
}

export async function findMaterialTextFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...(await findMaterialTextFiles(fullPath)));
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".txt") &&
				!entry.name.endsWith(".manifest.json")
			) {
				results.push(fullPath);
			}
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			logger.warn(`Error scanning directory for material text files: ${dir}`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

export async function deployMaterials(
	materialsDir: string,
	deployedMaterialsDir: string,
	destination: string,
): Promise<{ deployed: number; destination: string }> {
	await fs.mkdir(deployedMaterialsDir, { recursive: true });

	const textFiles = await findMaterialTextFiles(materialsDir);
	if (textFiles.length > 0) {
		const stagingDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "astroex-deploy-"),
		);
		try {
			const stagedNames = new Set<string>();
			for (const filePath of textFiles) {
				const baseName = path.basename(filePath);
				let targetName = baseName;
				if (stagedNames.has(targetName)) {
					const ext = path.extname(baseName);
					const nameWithoutExt = path.basename(baseName, ext);
					let counter = 1;
					while (stagedNames.has(`${nameWithoutExt}_${counter}${ext}`)) {
						counter++;
					}
					targetName = `${nameWithoutExt}_${counter}${ext}`;
					logger.warn(
						`Duplicate material filename detected for ${baseName}; deploying as ${targetName} to prevent overwrite.`,
					);
				}
				stagedNames.add(targetName);
				await fs.copyFile(filePath, path.join(stagingDir, targetName));
			}

			logger.info(
				`Syncing ${textFiles.length} material text file(s) to ${destination} via rclone...`,
			);
			execFileSync(
				"rclone",
				["-v", "--fast-list", "copy", stagingDir, destination],
				{
					stdio: "inherit",
				},
			);
		} finally {
			await fs.rm(stagingDir, { recursive: true, force: true });
		}
	} else {
		logger.warn(
			"No material text files found in materials directory to deploy.",
		);
	}

	// Move deployed materials locally to materials-deployed
	const files = await fs.readdir(materialsDir);
	for (const file of files) {
		const source = path.join(materialsDir, file);
		const target = path.join(deployedMaterialsDir, file);
		try {
			await fs.rename(source, target);
		} catch (renameErr) {
			logger.warn(
				`Failed to rename ${source} to ${target}, attempting fallback copy`,
				{
					error:
						renameErr instanceof Error ? renameErr.message : String(renameErr),
				},
			);
			await fs.cp(source, target, { recursive: true, force: true });
			await fs.rm(source, { recursive: true, force: true });
		}
	}

	return { deployed: textFiles.length, destination };
}

export async function executePipeline(
	config: PipelineConfig,
	options?: { skipAcquisition?: boolean; skipMaterials?: boolean },
): Promise<{
	success: boolean;
	durationMs: number;
	stages: Record<string, unknown>;
}> {
	const startTime = performance.now();
	const stats = createStatisticsCollector("run-pipeline");
	stats.startCollection();

	logger.info("=== ASTROEX PIPELINE ORCHESTRATION ===", {
		searchTermsFile: config.search.searchTermsFile,
		presets: config.presets,
	});

	// 1. Preflight assertion
	const preflightTimer = logger.startTimer("Preflight validation");
	await assertPreflight({
		selectedPresets: [
			config.presets.jobCloth,
			config.presets.jobJudge,
			config.presets.makeMaterials,
		],
		requireApiKey: true,
		apiKey: config.providers.apiKey,
		requireIndeedApiKey: !options?.skipAcquisition,
		indeedApiKey: config.providers.indeedApiKey,
		checkDeployment: config.deployment.enabled,
		deploymentDestination: config.deployment.destination,
	});
	preflightTimer.done("Preflight checks passed", "success");

	// 2. Budget handling
	if (config.budgets.maxLlmRequests) {
		process.env.ASTROEX_MAX_LLM_REQUESTS = String(
			config.budgets.maxLlmRequests,
		);
	}
	if (config.budgets.maxLlmOutputTokens) {
		process.env.ASTROEX_MAX_LLM_OUTPUT_TOKENS = String(
			config.budgets.maxLlmOutputTokens,
		);
	}
	if (config.budgets.maxTotalLlmOutputTokens) {
		process.env.ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS = String(
			config.budgets.maxTotalLlmOutputTokens,
		);
	}
	if (config.budgets.llmDeadlineMs) {
		process.env.ASTROEX_LLM_DEADLINE_MS = String(config.budgets.llmDeadlineMs);
	}

	// 3. Transient cleanup if requested
	if (config.options.clean) {
		logger.warn(
			"Cleaning transient data and log artifacts (preserving SQLite)...",
		);
		await fs.rm(config.paths.acquiredJobsFile, { force: true });
		await fs.rm(config.paths.processedJobsFile, { force: true });
		await fs.rm(config.paths.clothedJobsFile, { force: true });
		await fs.rm(path.join(config.paths.dataDir, "astroapply_eval_pass"), {
			recursive: true,
			force: true,
		});
		await fs.rm(path.join(config.paths.dataDir, "astroapply_eval_fail"), {
			recursive: true,
			force: true,
		});
		await fs.rm(path.join(config.paths.dataDir, "astroapply_eval_dupe"), {
			recursive: true,
			force: true,
		});
	}

	const stageResults: Record<string, unknown> = {};

	// 4. Acquisition Stage
	if (!options?.skipAcquisition) {
		const acqTimer = logger.startTimer("Stage 1/5: Acquisition");
		logger.info("Stage 1/5: Acquiring Indeed jobs...", {
			sites: config.search.sites,
			resultsWanted: config.search.resultsWanted,
		});
		const acqResult = await runAcquireJobs({
			sites: config.search.sites.join(","),
			"search-terms": config.search.searchTerms
				? config.search.searchTerms.join(",")
				: "",
			"search-terms-file": path.isAbsolute(config.search.searchTermsFile)
				? config.search.searchTermsFile
				: path.join(config.paths.profileDir, config.search.searchTermsFile),
			locations: config.search.locations.join(","),
			"results-wanted": config.search.resultsWanted,
			distance: 25,
			"hours-old": config.search.hoursOld,
			remote: Boolean(config.search.remoteOnly),
			"remote-only": config.search.remoteOnly,
			"easy-apply": false,
			"indeed-country": config.search.indeedCountry,
			"description-mode": config.search.descriptionMode,
			"description-format": "markdown",
			proxies: "",
			"output-file": config.paths.acquiredJobsFile,
			"use-jobdb": true,
			verbose: config.options.verbose,
			logDir: config.paths.logDir,
		});
		acqTimer.done("Stage 1/5: Acquisition completed", "success", {
			jobsAcquired: acqResult.jobs,
		});
		stageResults.acquisition = acqResult;
	} else {
		logger.info("Stage 1/5: Acquisition skipped by flag.");
		stageResults.acquisition = { skipped: true };
	}

	// 5. Normalization / processData Stage
	const normTimer = logger.startTimer("Stage 2/5: Normalization");
	logger.info("Stage 2/5: Normalizing and filtering acquired jobs...");
	const processResult = await processAcquiredJobs(
		{
			inputDirectory: config.paths.dataDir,
			outputFile: config.paths.processedJobsFile,
		},
		stats,
	);
	normTimer.done("Stage 2/5: Normalization completed", "success", {
		outputRecordCount: processResult.outputRecordCount,
		duplicatesRemoved: processResult.duplicatesRemoved,
	});
	stageResults.processData = processResult;

	// 6. JobCloth Stage (Filtering)
	const clothTimer = logger.startTimer("Stage 3/5: JobCloth");
	logger.info(
		`Stage 3/5: Job prefiltering with ${config.presets.jobCloth}...`,
		{
			preset: config.presets.jobCloth,
			...(config.reasoningEffort?.jobCloth
				? { reasoning_effort: config.reasoningEffort.jobCloth }
				: {}),
		},
	);
	const allPresets = await loadPresets();
	const clothPreset = getPreset(
		"jobCloth",
		config.presets.jobCloth,
		allPresets,
	);
	if (!clothPreset) {
		throw new Error(`Preset ${config.presets.jobCloth} not found for jobCloth`);
	}

	const clothResult = await runJobCloth(
		config.paths.processedJobsFile,
		config.paths.clothedJobsFile,
		{
			apiKey: config.providers.apiKey || "",
			baseUrl: clothPreset.base_url,
			modelId: clothPreset.modelId,
			preset: config.presets.jobCloth,
			temperature: clothPreset.temperature,
			topP: clothPreset.topP,
			maxTokens: clothPreset.maxTokens,
			resumeFile: path.join(config.paths.profileDir, "my_resume.txt"),
			batch: config.options.batchSize,
			verbose: config.options.verbose,
			showReasoningTokens: config.options.showReasoning,
			showResponseStream: config.options.showStream,
			...(config.reasoningEffort?.jobCloth
				? { reasoningEffort: config.reasoningEffort.jobCloth }
				: {}),
			stats,
		},
	);
	clothTimer.done("Stage 3/5: JobCloth completed", "success", {
		outputJobs: clothResult.length,
	});
	stageResults.jobCloth = { outputJobs: clothResult.length };

	// 7. JobJudge Stage (Deep Alignment Evaluation)
	const judgeTimer = logger.startTimer("Stage 4/5: JobJudge");
	logger.info(
		`Stage 4/5: Job alignment evaluation with ${config.presets.jobJudge}...`,
		{
			preset: config.presets.jobJudge,
			...(config.reasoningEffort?.jobJudge
				? { reasoning_effort: config.reasoningEffort.jobJudge }
				: {}),
		},
	);
	const judgeResult = await runJobJudge({
		"api-key": config.providers.apiKey || "",
		"base-url": "",
		"model-id": "",
		"input-file": config.paths.clothedJobsFile,
		"output-file": path.join(config.paths.dataDir, "astroapply_eval_"),
		preset: config.presets.jobJudge,
		"use-jobdb": true,
		"strict-parsing": false,
		"log-payload": false,
		sleep: config.options.sleep,
		"eval-mode": 1,
		"show-reasoning": config.options.showReasoning,
		"show-stream": config.options.showStream,
		verbose: config.options.verbose,
		logDir: config.paths.logDir,
		...(config.reasoningEffort?.jobJudge
			? {
					"jj-reasoning-effort": config.reasoningEffort.jobJudge,
					reasoningEffort: config.reasoningEffort.jobJudge,
				}
			: {}),
	});
	judgeTimer.done("Stage 4/5: JobJudge completed", "success", {
		jobs: judgeResult.jobs,
		passed: judgeResult.passed,
	});
	stageResults.jobJudge = judgeResult;

	// 8. MakeMaterials Stage
	if (!options?.skipMaterials) {
		const matTimer = logger.startTimer("Stage 5/5: MakeMaterials");
		logger.info(
			`Stage 5/5: Application materials generation with ${config.presets.makeMaterials}...`,
			{
				preset: config.presets.makeMaterials,
				...(config.reasoningEffort?.makeMaterials
					? { reasoning_effort: config.reasoningEffort.makeMaterials }
					: {}),
			},
		);
		const materialsPreset = getPreset(
			"makeMaterials",
			config.presets.makeMaterials,
			allPresets,
		);
		if (!materialsPreset) {
			throw new Error(
				`Preset ${config.presets.makeMaterials} not found for makeMaterials`,
			);
		}

		const materialsResult = await runResumeOptimizationMode(materialsPreset, {
			preset: config.presets.makeMaterials,
			apiKey: config.providers.apiKey || "",
			verbose: config.options.verbose,
			sleep: config.options.sleep,
			showReasoningTokens: config.options.showReasoning,
			showResponseStream: config.options.showStream,
			...(config.reasoningEffort?.makeMaterials
				? { reasoningEffort: config.reasoningEffort.makeMaterials }
				: {}),
			stats,
		});
		matTimer.done("Stage 5/5: MakeMaterials completed", "success", {
			generated: materialsResult.content.length,
		});
		stageResults.makeMaterials = { generated: materialsResult.content.length };
	} else {
		logger.info("Stage 5/5: MakeMaterials skipped by flag.");
		stageResults.makeMaterials = { skipped: true };
	}

	// 9. Optional Deployment Stage
	if (config.deployment.enabled) {
		const deployTimer = logger.startTimer("Deployment");
		logger.info("Optional Stage: Deploying materials...", {
			destination: config.deployment.destination,
		});
		const destination = config.deployment.destination;
		if (!destination) {
			throw new Error("Deployment requested but destination not set");
		}

		const deployResult = await deployMaterials(
			config.paths.materialsDir,
			config.paths.deployedMaterialsDir,
			destination,
		);
		stageResults.deployment = deployResult;
		deployTimer.done(
			`Successfully deployed ${deployResult.deployed} material items.`,
			"success",
			{ deployedCount: deployResult.deployed },
		);
	}

	const durationMs = performance.now() - startTime;
	stats.recordSuccess("run-pipeline.complete", {
		durationMs,
		stages: stageResults,
	});
	stats.endCollection();

	logger.success(
		`Pipeline completed successfully in ${formatDuration(durationMs)}.`,
		{ durationMs, stages: stageResults },
	);

	return {
		success: true,
		durationMs,
		stages: stageResults,
	};
}

export function addRunPipelineCommand(
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> {
	return yargs.command(
		"run-pipeline",
		"Orchestrate the full AstroEX Indeed job pipeline with preflight, checkpoints, and materials generation.",
		(cmd) =>
			cmd
				.option("clean", {
					type: "boolean",
					description:
						"Clean transient intermediate artifacts before execution (preserves SQLite).",
					default: false,
				})
				.option("deploy", {
					type: "boolean",
					description: "Deploy generated materials to destination via rclone.",
					default: false,
				})
				.option("deploy-destination", {
					type: "string",
					description:
						"Remote destination for rclone deployment (e.g. RemoteName:/path/to/destination).",
				})
				.option("api-key", {
					type: "string",
					description:
						"API key for LLM provider stages (defaults to AEX_OR_API_KEY).",
				})
				.option("search-terms-file", {
					type: "string",
					description:
						"File containing search terms (defaults to search_terms.txt in profile dir).",
				})
				.option("results-wanted", {
					type: "number",
					description: "Target number of jobs to acquire per term.",
					default: 9999,
				})
				.option("hours-old", {
					type: "number",
					description: "Age limit for jobs in hours (0 = unlimited).",
					default: 24,
				})
				.option("jobcloth-preset", {
					type: "string",
					description: "Preset for jobCloth filtering stage.",
				})
				.option("jobjudge-preset", {
					type: "string",
					description: "Preset for jobJudge evaluation stage.",
				})
				.option("makematerials-preset", {
					type: "string",
					description: "Preset for makeMaterials generation stage.",
				})
				.option("batch", {
					type: "number",
					description: "Batch size for LLM filtering operations.",
					default: 25,
				})
				.option("sleep", {
					type: "number",
					description: "Delay in seconds between job evaluations.",
					default: 5,
				})
				.option("skip-acquisition", {
					type: "boolean",
					description:
						"Skip acquisition and run downstream stages on existing artifacts.",
					default: false,
				})
				.option("skip-materials", {
					type: "boolean",
					description: "Stop after evaluation without generating materials.",
					default: false,
				})
				.option("verbose", {
					type: "boolean",
					description: "Enable verbose diagnostic logging.",
					default: false,
				})
				.option("show-reasoning", {
					alias: "sr",
					type: "boolean",
					description:
						"Display reasoning/thinking tokens from reasoning models live as they arrive.",
					default: true,
				})
				.option("show-reasoning-tokens", {
					type: "boolean",
					description: "Alias for --show-reasoning",
				})
				.option("hide-reasoning", {
					alias: "hr",
					type: "boolean",
					description: "Hide reasoning/thinking tokens from reasoning models.",
					default: false,
				})
				.option("hide-reasoning-tokens", {
					type: "boolean",
					description: "Alias for --hide-reasoning",
					default: false,
				})
				.option("jc-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for jobCloth stage (e.g. low, medium, high, max).",
				})
				.option("jj-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for jobJudge stage (e.g. low, medium, high, max).",
				})
				.option("mm-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for makeMaterials stage (e.g. low, medium, high, max).",
				})
				.option("remote-only", {
					type: "boolean",
					description:
						"Filter acquired jobs to retain only remote positions (isRemote === true).",
					default: false,
				}),
		async (argv) => {
			const options = argv as RunPipelineOptions;
			const hideReasoningRequested = Boolean(
				options["hide-reasoning"] ||
					options["hide-reasoning-tokens"] ||
					(options as Record<string, unknown>).hr ||
					process.env.ASTROEX_HIDE_REASONING === "1",
			);
			const showReasoningRequested =
				options["show-reasoning"] !== undefined
					? options["show-reasoning"]
					: options["show-reasoning-tokens"];

			const resolvedShowReasoning = hideReasoningRequested
				? false
				: showReasoningRequested !== undefined
					? Boolean(showReasoningRequested)
					: true;

			const config = buildPipelineConfig({
				search: {
					searchTermsFile: options["search-terms-file"],
					resultsWanted: options["results-wanted"],
					hoursOld: options["hours-old"],
					remoteOnly: Boolean(
						options["remote-only"] || process.env.ASTROEX_REMOTE_ONLY === "1",
					),
				},
				presets: {
					jobCloth: options["jobcloth-preset"],
					jobJudge: options["jobjudge-preset"],
					makeMaterials: options["makematerials-preset"],
				},
				providers: {
					apiKey: options["api-key"],
				},
				deployment: {
					enabled: Boolean(options.deploy),
					destination: options["deploy-destination"],
				},
				options: {
					clean: Boolean(options.clean),
					batchSize: options.batch,
					sleep: options.sleep,
					showReasoning: resolvedShowReasoning,
					hideReasoning: hideReasoningRequested,
					verbose: Boolean(options.verbose),
				},
				reasoningEffort: {
					jobCloth: options["jc-reasoning-effort"],
					jobJudge: options["jj-reasoning-effort"],
					makeMaterials: options["mm-reasoning-effort"],
				},
			});

			const defaultLogDirectory = getLogsDirectory();
			if (!options.disableFileLogging) {
				initializeFileLogging(
					typeof options.logDir === "string"
						? options.logDir
						: defaultLogDirectory,
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_pipeline_${typeof options.logFile === "string" ? options.logFile : "astroex.log"}`,
					"Pipeline",
				);
			}

			try {
				const result = await executePipeline(config, {
					skipAcquisition: Boolean(options["skip-acquisition"]),
					skipMaterials: Boolean(options["skip-materials"]),
				});
				if (!result.success) {
					process.exitCode = 1;
				}
			} catch (error) {
				logger.error(
					`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);
				process.exitCode = 1;
			} finally {
				await closeFileLogging();
			}
		},
	);
}
