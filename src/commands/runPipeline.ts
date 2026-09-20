import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Argv } from "yargs";
import {
	ASTRO_AUTO_PROVIDER,
	DEFAULT_TOP,
	astro_auto_provider,
} from "../astroAutoProvider";
import {
	DEFAULT_JOBCLOTH_COOL_OFF_DAYS,
	JOB_DB_RETENTION_MS,
} from "../constants";
import {
	DEFAULT_WATCHDOG_TARGET,
	InternetConnectivityLostError,
	InternetWatchdog,
	type InternetWatchdogOptions,
	validateAndNormalizeProbeTarget,
} from "../internetWatchdog";
import { JobRepository } from "../jobRepository";
import { llmService } from "../llmService";
import { writeExternalCommandOutput } from "../logging";
import type { JobInterface } from "../models";
import { OpenRouterUsageTracker, formatUsd } from "../openRouterUsage";
import {
	PipelineCancellationController,
	throwIfCancelled,
} from "../pipelineCancellation";
import {
	PIPELINE_PHASES,
	type PipelineConfig,
	type PipelinePhase,
	buildPipelineConfig,
	parseOpenRouterProviderRouting,
	shouldExecutePhase,
	validateResumePhase,
} from "../pipelineConfig";
import { getPreset, loadPresets } from "../presets";
import { getDataDirectory, getMaterialsDirectory } from "../runtimePaths";
import { createStatisticsCollector } from "../statistics";
import type {
	GlobalArgs,
	OpenRouterProviderRouting,
	PresetConfig,
} from "../types";
import { createLogger, formatDuration, log } from "../utils";
import { createProgressReporter } from "../utils/progress";
import { resolveRemoteOnlyOption, runAcquireJobs } from "./acquireJobs";
import { runEnrichLinkedInJobs } from "./enrichJobs";
import { runJobCloth } from "./jobCloth";
import { runJobJudge } from "./jobJudge";
import { runResumeOptimizationMode } from "./makeMaterials";
import { assertPreflight } from "./preflight";
import { processAcquiredJobs } from "./processData";
import { runRemoteEval } from "./remoteEval";

export {
	PIPELINE_PHASES,
	type PipelinePhase,
	validateResumePhase,
	shouldExecutePhase,
	buildPipelineConfig,
	type PipelineConfig,
};

const logger = createLogger("Pipeline");
const execFileAsync = promisify(execFile);

interface StageProviderRoutingResolution {
	stage: keyof PresetConfig;
	providerFlag: string;
	presetName: string;
	configuredRouting?: OpenRouterProviderRouting;
	allPresets: PresetConfig;
	apiKey: string;
	signal?: AbortSignal;
	top?: number;
}

/**
 * Converts the auto-provider sentinel into an OpenRouter provider route at the
 * last possible point before a stage starts. Explicit routes pass through.
 */
async function resolveStageProviderRouting({
	stage,
	providerFlag,
	presetName,
	configuredRouting,
	allPresets,
	apiKey,
	signal,
	top,
}: StageProviderRoutingResolution): Promise<
	OpenRouterProviderRouting | undefined
> {
	const containsAutoProvider =
		configuredRouting?.only?.includes(ASTRO_AUTO_PROVIDER);
	if (!containsAutoProvider) return configuredRouting;
	if (configuredRouting?.only?.length !== 1) {
		throw new Error(
			`${providerFlag}=${ASTRO_AUTO_PROVIDER} must be used alone; it cannot be combined with explicit provider slugs.`,
		);
	}

	const preset = getPreset(stage, presetName, allPresets);
	if (!preset) {
		throw new Error(`Preset ${presetName} not found for ${stage}`);
	}
	if (!preset.modelId?.trim()) {
		throw new Error(
			`Preset ${presetName} for ${stage} does not contain a usable modelId for ${ASTRO_AUTO_PROVIDER}.`,
		);
	}
	if (preset.provider !== "openrouter") {
		throw new Error(
			`${providerFlag}=${ASTRO_AUTO_PROVIDER} requires an OpenRouter preset; ${presetName} uses ${preset.provider}.`,
		);
	}

	throwIfCancelled(signal);
	const selection = await astro_auto_provider({
		modelId: preset.modelId,
		apiKey,
		signal,
		top,
		...(configuredRouting?.quantizations?.length
			? { quantizations: configuredRouting.quantizations }
			: {}),
	});
	// Keep the selector text intact as one normal AstroEX log record. The
	// structured result, rather than the display text, is authoritative below.
	logger.info(selection.noDetailsOutput);
	if (selection.providerSlugs.length === 0) {
		throw new Error(
			`${ASTRO_AUTO_PROVIDER} found no eligible OpenRouter providers for ${stage} preset ${presetName} (${preset.modelId}).`,
		);
	}
	if (selection.providerSlugs.some((slug) => slug.trim().length === 0)) {
		throw new Error(
			`${ASTRO_AUTO_PROVIDER} returned an invalid provider slug for ${stage} preset ${presetName}.`,
		);
	}
	throwIfCancelled(signal);
	return { ...configuredRouting, only: selection.providerSlugs };
}

export interface RunPipelineOptions extends GlobalArgs {
	config?: string;
	clean?: boolean;
	deploy?: boolean;
	"deploy-destination"?: string;
	"api-key"?: string;
	"job-provider"?: string;
	jobProvider?: string;
	sites?: string;
	"search-terms-file"?: string;
	"results-wanted"?: number;
	"hours-old"?: number;
	"jobcloth-preset"?: string;
	"jobcloth-cool-off-days"?: number;
	"remoteeval-preset"?: string;
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
	"re-reasoning-level"?: string;
	"jj-reasoning-effort"?: string;
	"mm-reasoning-effort"?: string;
	"jc-provider"?: string;
	"re-provider"?: string;
	"jj-provider"?: string;
	"mm-provider"?: string;
	"provider-ignore"?: string;
	providerIgnore?: string;
	"jc-provider-quant"?: string;
	jcProviderQuant?: string;
	"re-provider-quant"?: string;
	reProviderQuant?: string;
	"jj-provider-quant"?: string;
	jjProviderQuant?: string;
	"mm-provider-quant"?: string;
	mmProviderQuant?: string;
	"astro_auto_provider-top"?: number;
	astroAutoProviderTop?: number;
	"remote-only"?: boolean;
	remoteOnly?: boolean;
	"show-fetch-url"?: boolean;
	showFetchUrl?: boolean;
	"track-or-costs"?: boolean;
	trackOrCosts?: boolean;
	"log-cool-offs"?: boolean;
	logCoolOffs?: boolean;
	resume?: string;
	"internet-watchdog"?: string;
	internetWatchdog?: string;
}

export type ResolvedInternetWatchdogOption =
	| { enabled: false }
	| { enabled: true; target: string };

export function resolveInternetWatchdogOption(
	value: unknown,
): ResolvedInternetWatchdogOption {
	if (value === undefined || value === false) return { enabled: false };
	if (value === "" || value === true) {
		return { enabled: true, target: DEFAULT_WATCHDOG_TARGET };
	}
	return {
		enabled: true,
		target: validateAndNormalizeProbeTarget(value),
	};
}

export function resolvePipelineAcquisitionInputFiles(
	config: PipelineConfig,
): string[] {
	return [
		...(config.search.sites.includes("indeed")
			? [config.paths.acquiredJobsIndeedFile ?? config.paths.acquiredJobsFile]
			: []),
		...(config.search.sites.includes("linkedin") &&
		config.paths.acquiredJobsLinkedInFile
			? [config.paths.acquiredJobsLinkedInFile]
			: []),
	].filter((file, index, files) => files.indexOf(file) === index);
}

async function createPipelineJobRepository(
	config: PipelineConfig,
): Promise<JobRepository> {
	const repository = new JobRepository({
		dbFilePath: path.join(config.paths.dataDir, "jobDB.sqlite"),
		legacyJsonPath: path.join(config.paths.dataDir, "jobDB.json"),
		defaultExpirationMs: JOB_DB_RETENTION_MS,
		enableJobDB: true,
	});
	await repository.initialize();
	await repository.load();
	return repository;
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
	signal?: AbortSignal,
): Promise<{ deployed: number; destination: string }> {
	throwIfCancelled(signal);
	await fs.mkdir(deployedMaterialsDir, { recursive: true });

	const textFiles = await findMaterialTextFiles(materialsDir);
	const deploymentProgress = createProgressReporter(logger, {
		label: "Stage 8/8: Deployment",
		unitLabel: "material",
		totalUnits: textFiles.length,
		phase: "preparation progress",
	});
	deploymentProgress.start({ destination });
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
				deploymentProgress.complete({
					sourceFile: filePath,
					stagedFile: targetName,
					outcome: "staged",
				});
			}

			logger.info(
				`Syncing ${textFiles.length} material text file(s) to ${destination} via rclone...`,
			);
			try {
				const { stdout, stderr } = await execFileAsync(
					"rclone",
					["-v", "--fast-list", "copy", stagingDir, destination],
					{
						encoding: "utf8",
						maxBuffer: 10 * 1024 * 1024,
						signal,
					},
				);
				writeExternalCommandOutput(stdout, "stdout");
				writeExternalCommandOutput(stderr, "stderr");
			} catch (error) {
				const commandError = error as {
					stdout?: string | Buffer;
					stderr?: string | Buffer;
				};
				writeExternalCommandOutput(commandError.stdout, "stdout");
				writeExternalCommandOutput(commandError.stderr, "stderr");
				throw error;
			}
		} finally {
			await fs.rm(stagingDir, { recursive: true, force: true });
		}
	} else {
		logger.warn(
			"No material text files found in materials directory to deploy.",
		);
	}
	throwIfCancelled(signal);

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

async function executePipelineInternal(
	config: PipelineConfig,
	options?: {
		skipAcquisition?: boolean;
		skipMaterials?: boolean;
		resume?: PipelinePhase;
		signal?: AbortSignal;
		"astro_auto_provider-top"?: number;
	},
): Promise<{
	success: boolean;
	durationMs: number;
	stages: Record<string, unknown>;
}> {
	const startTime = performance.now();
	const signal = options?.signal;
	throwIfCancelled(signal);
	const stats = createStatisticsCollector("run-pipeline");
	stats.startCollection();

	const resumePhase = options?.resume
		? validateResumePhase(options.resume)
		: config.options.resume
			? validateResumePhase(config.options.resume)
			: undefined;

	logger.info("=== ASTROEX PIPELINE ORCHESTRATION ===", {
		searchTermsFile: config.search.searchTermsFile,
		presets: config.presets,
		...(resumePhase ? { resumeFrom: resumePhase } : {}),
		...(config.providerIgnore?.length
			? { "provider-ignore": config.providerIgnore.join(",") }
			: {}),
		...(options?.["astro_auto_provider-top"] !== undefined ||
		config.options.astroAutoProviderTop !== DEFAULT_TOP
			? { "astro_auto_provider-top": config.options.astroAutoProviderTop }
			: {}),
	});

	const requiresLlm =
		shouldExecutePhase("jobCloth", resumePhase) ||
		(config.search.remoteOnly &&
			shouldExecutePhase("remoteEval", resumePhase)) ||
		shouldExecutePhase("jobJudge", resumePhase) ||
		(shouldExecutePhase("makeMaterials", resumePhase) &&
			!options?.skipMaterials);

	// 1. Preflight assertion
	const preflightTimer = logger.startTimer("Preflight validation");
	await assertPreflight({
		selectedPresetCategories: {
			jobCloth: config.presets.jobCloth,
			...(config.search.remoteOnly
				? { remoteEval: config.presets.remoteEval }
				: {}),
			jobJudge: config.presets.jobJudge,
			makeMaterials: config.presets.makeMaterials,
		},
		requireApiKey: requiresLlm,
		apiKey: config.providers.apiKey,
		checkDeployment:
			config.deployment.enabled &&
			shouldExecutePhase("deployment", resumePhase),
		deploymentDestination: config.deployment.destination,
	});
	throwIfCancelled(signal);
	preflightTimer.done("Preflight checks passed", "success");

	// Pre-load all presets so they are available for any downstream LLM stage
	const allPresets = await loadPresets();

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
		throwIfCancelled(signal);
		logger.warn(
			"Cleaning transient data and log artifacts (preserving SQLite)...",
		);
		await fs.rm(config.paths.acquiredJobsFile, { force: true });
		await fs.rm(`${config.paths.acquiredJobsFile}.manifest.json`, {
			force: true,
		});
		if (
			config.paths.acquiredJobsIndeedFile &&
			config.paths.acquiredJobsIndeedFile !== config.paths.acquiredJobsFile
		) {
			await fs.rm(config.paths.acquiredJobsIndeedFile, { force: true });
			await fs.rm(`${config.paths.acquiredJobsIndeedFile}.manifest.json`, {
				force: true,
			});
		}
		if (config.paths.acquiredJobsLinkedInFile) {
			await fs.rm(config.paths.acquiredJobsLinkedInFile, { force: true });
			await fs.rm(`${config.paths.acquiredJobsLinkedInFile}.manifest.json`, {
				force: true,
			});
		}
		await fs.rm(config.paths.processedJobsFile, { force: true });
		await fs.rm(`${config.paths.processedJobsFile}.manifest.json`, {
			force: true,
		});
		await fs.rm(config.paths.clothedJobsFile, { force: true });
		await fs.rm(`${config.paths.clothedJobsFile}.manifest.json`, {
			force: true,
		});
		await fs.rm(config.paths.clothedJobsEnrichedFile, { force: true });
		await fs.rm(`${config.paths.clothedJobsEnrichedFile}.manifest.json`, {
			force: true,
		});
		await fs.rm(config.paths.remoteEvalOutputFile, { force: true });
		await fs.rm(`${config.paths.remoteEvalOutputFile}.manifest.json`, {
			force: true,
		});
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

		try {
			const dataEntries = await fs.readdir(config.paths.dataDir, {
				withFileTypes: true,
			});
			for (const entry of dataEntries) {
				if (entry.isFile()) {
					const name = entry.name;
					const isPreserved =
						name.includes(".sqlite") ||
						name.endsWith(".bak") ||
						name.includes(".bak.") ||
						name === "jobDB.json";
					if (
						!isPreserved &&
						(name.endsWith(".manifest.json") ||
							name.startsWith("acquired_jobs_") ||
							name.startsWith("processed_jobs_") ||
							name.startsWith("clothed_jobs_") ||
							name.startsWith("remote_eval_"))
					) {
						await fs.rm(path.join(config.paths.dataDir, name), { force: true });
					}
				}
			}
		} catch {
			// ignore directory read error
		}
	}

	const stageResults: Record<string, unknown> = {};
	const pipelineProgress = createProgressReporter(logger, {
		label: "Pipeline",
		unitLabel: "stage",
		totalUnits: PIPELINE_PHASES.length,
		phase: "progress",
		maxUpdates: PIPELINE_PHASES.length,
	});
	pipelineProgress.start({ phases: PIPELINE_PHASES });

	// 4. Acquisition Stage (Stage 1/8)
	const shouldAcquire =
		shouldExecutePhase("acquireJobs", resumePhase) && !options?.skipAcquisition;
	if (shouldAcquire) {
		throwIfCancelled(signal);
		const acqTimer = logger.startTimer("Stage 1/8: Acquisition");
		logger.info(
			`Stage 1/8: Acquiring ${config.search.sites.join(", ")} jobs...`,
			{
				sites: config.search.sites,
				resultsWanted: config.search.resultsWanted,
			},
		);
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
			"output-file":
				config.paths.acquiredJobsIndeedFile ?? config.paths.acquiredJobsFile,
			"output-file-indeed": config.paths.acquiredJobsIndeedFile,
			"output-file-linkedin": config.paths.acquiredJobsLinkedInFile,
			outputFilesBySource: {
				indeed:
					config.paths.acquiredJobsIndeedFile ?? config.paths.acquiredJobsFile,
				linkedin: config.paths.acquiredJobsLinkedInFile,
			},
			"use-jobdb": true,
			verbose: config.options.verbose,
			"show-fetch-url": config.options.showFetchUrl,
			showFetchUrl: config.options.showFetchUrl,
			signal,
		});
		throwIfCancelled(signal);
		acqTimer.done("Stage 1/8: Acquisition completed", "success", {
			jobsAcquired: acqResult.jobs,
		});
		stageResults.acquisition = acqResult;
		stageResults.acquireJobs = acqResult;
	} else {
		const reason = !shouldExecutePhase("acquireJobs", resumePhase)
			? `skipped by resume (resuming from ${resumePhase}).`
			: "skipped by flag.";
		logger.info(`Stage 1/8: Acquisition ${reason}`);
		stageResults.acquisition = { skipped: true };
		stageResults.acquireJobs = { skipped: true };
	}
	pipelineProgress.complete(
		{ stage: "acquireJobs", executed: shouldAcquire },
		{ suffix: `acquireJobs ${shouldAcquire ? "completed" : "skipped"}` },
	);

	// 5. Normalization / processData Stage (Stage 2/8)
	if (shouldExecutePhase("processData", resumePhase)) {
		throwIfCancelled(signal);
		const normTimer = logger.startTimer("Stage 2/8: Normalization");
		logger.info("Stage 2/8: Normalizing and filtering acquired jobs...");
		const normalizationInputFiles =
			resolvePipelineAcquisitionInputFiles(config);
		let processRepository: JobRepository | undefined;
		let processResult: Awaited<ReturnType<typeof processAcquiredJobs>>;
		try {
			processResult = await processAcquiredJobs(
				{
					inputFiles: normalizationInputFiles,
					outputFile: config.paths.processedJobsFile,
					remoteOnly: config.search.remoteOnly,
					jobClothCoolOffDays: config.options.jobClothCoolOffDays,
					logCoolOffs: config.options.logCoolOffs,
					signal,
					jobRepositoryFactory: async () => {
						processRepository ??= await createPipelineJobRepository(config);
						return processRepository;
					},
				},
				stats,
			);
		} finally {
			if (processRepository) await processRepository.close();
		}
		normTimer.done("Stage 2/8: Normalization completed", "success", {
			outputRecordCount: processResult.outputRecordCount,
			duplicatesRemoved: processResult.duplicatesRemoved,
		});
		stageResults.processData = processResult;
	} else {
		logger.info(
			`Stage 2/8: Normalization skipped by resume (resuming from ${resumePhase}).`,
		);
		stageResults.processData = { skipped: true };
	}
	const processDataExecuted = shouldExecutePhase("processData", resumePhase);
	pipelineProgress.complete(
		{ stage: "processData", executed: processDataExecuted },
		{ suffix: `processData ${processDataExecuted ? "completed" : "skipped"}` },
	);

	// 6. JobCloth Stage (Filtering) (Stage 3/8)
	let clothResult: JobInterface[] = [];
	if (shouldExecutePhase("jobCloth", resumePhase)) {
		throwIfCancelled(signal);
		const clothProviderRouting = await resolveStageProviderRouting({
			stage: "jobCloth",
			providerFlag: "--jc-provider",
			presetName: config.presets.jobCloth,
			configuredRouting: config.providerRouting.jobCloth,
			allPresets,
			apiKey: config.providers.apiKey || "",
			signal,
			top: config.options.astroAutoProviderTop,
		});
		const clothTimer = logger.startTimer("Stage 3/8: JobCloth");
		logger.info(
			`Stage 3/8: Job prefiltering with ${config.presets.jobCloth}...`,
			{
				preset: config.presets.jobCloth,
				...(config.reasoningEffort?.jobCloth
					? { reasoning_effort: config.reasoningEffort.jobCloth }
					: {}),
				...(clothProviderRouting?.only?.length
					? {
							"jc-provider": clothProviderRouting.only.join(","),
						}
					: {}),
				...(clothProviderRouting?.quantizations?.length
					? {
							"jc-provider-quant": clothProviderRouting.quantizations.join(","),
						}
					: {}),
			},
		);
		const clothPreset = getPreset(
			"jobCloth",
			config.presets.jobCloth,
			allPresets,
		);
		if (!clothPreset) {
			throw new Error(
				`Preset ${config.presets.jobCloth} not found for jobCloth`,
			);
		}

		let clothRepository: JobRepository | undefined;
		try {
			clothResult = await runJobCloth(
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
					batch: config.options.batchSize,
					verbose: config.options.verbose,
					showReasoningTokens: config.options.showReasoning,
					showResponseStream: config.options.showStream,
					...(config.reasoningEffort?.jobCloth
						? { reasoningEffort: config.reasoningEffort.jobCloth }
						: {}),
					...(clothProviderRouting
						? { providerRouting: clothProviderRouting }
						: {}),
					stats,
					signal,
					jobRepositoryFactory: async () => {
						clothRepository ??= await createPipelineJobRepository(config);
						return clothRepository;
					},
				},
			);
		} finally {
			if (clothRepository) await clothRepository.close();
		}
		clothTimer.done("Stage 3/8: JobCloth completed", "success", {
			outputJobs: clothResult.length,
		});
		stageResults.jobCloth = { outputJobs: clothResult.length };
	} else {
		logger.info(
			`Stage 3/8: JobCloth skipped by resume (resuming from ${resumePhase}).`,
		);
		stageResults.jobCloth = { skipped: true };
		try {
			const existingClothed = await fs.readFile(
				config.paths.clothedJobsFile,
				"utf8",
			);
			clothResult = JSON.parse(existingClothed);
		} catch {
			clothResult = [];
		}
	}
	const jobClothExecuted = shouldExecutePhase("jobCloth", resumePhase);
	pipelineProgress.complete(
		{ stage: "jobCloth", executed: jobClothExecuted },
		{ suffix: `jobCloth ${jobClothExecuted ? "completed" : "skipped"}` },
	);

	// 6.5. LinkedIn Description Enrichment Stage (Stage 4/8)
	let postEnrichmentInputFile = config.paths.clothedJobsFile;
	const hasLinkedInJobs =
		config.search.sites.includes("linkedin") ||
		clothResult.some(
			(j) =>
				j.source === "linkedin" ||
				(typeof j.url === "string" && j.url.includes("linkedin.com")),
		);
	if (shouldExecutePhase("enrichJobs", resumePhase)) {
		throwIfCancelled(signal);
		if (hasLinkedInJobs && clothResult.length > 0) {
			const enrichTimer = logger.startTimer("Stage 4/8: LinkedIn Enrichment");
			logger.info(
				"Stage 4/8: Enriching descriptions for surviving LinkedIn jobs...",
			);
			let enrichRepo: JobRepository | undefined;
			try {
				enrichRepo = new JobRepository({
					dbFilePath: path.join(config.paths.dataDir, "jobDB.sqlite"),
					defaultExpirationMs: JOB_DB_RETENTION_MS,
					enableJobDB: true,
				});
				await enrichRepo.initialize();
				await enrichRepo.load();
			} catch (repoErr) {
				logger.warn(
					`Failed to initialize JobRepository for Stage 4/8: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
				);
			}
			try {
				const enrichResult = await runEnrichLinkedInJobs({
					inputFile: config.paths.clothedJobsFile,
					outputFile: config.paths.clothedJobsEnrichedFile,
					jobRepository: enrichRepo,
					stats,
					"show-fetch-url": config.options.showFetchUrl,
					showFetchUrl: config.options.showFetchUrl,
					signal,
				});
				enrichTimer.done(
					"Stage 4/8: LinkedIn Enrichment completed",
					"success",
					{
						enrichedCount: enrichResult.enrichedCount,
						totalJobs: enrichResult.totalJobs,
					},
				);
				stageResults.enrichJobs = enrichResult;
				postEnrichmentInputFile = config.paths.clothedJobsEnrichedFile;
			} finally {
				if (enrichRepo) {
					await enrichRepo.close();
				}
			}
		} else {
			logger.info("Stage 4/8: LinkedIn Enrichment skipped (no LinkedIn jobs).");
			stageResults.enrichJobs = { skipped: true };
		}
	} else {
		logger.info(
			`Stage 4/8: LinkedIn Enrichment skipped by resume (resuming from ${resumePhase}).`,
		);
		stageResults.enrichJobs = { skipped: true };
		if (hasLinkedInJobs) {
			try {
				await fs.access(config.paths.clothedJobsEnrichedFile);
				postEnrichmentInputFile = config.paths.clothedJobsEnrichedFile;
			} catch {
				postEnrichmentInputFile = config.paths.clothedJobsFile;
			}
		}
	}
	const enrichJobsExecuted =
		shouldExecutePhase("enrichJobs", resumePhase) &&
		hasLinkedInJobs &&
		clothResult.length > 0;
	pipelineProgress.complete(
		{ stage: "enrichJobs", executed: enrichJobsExecuted },
		{ suffix: `enrichJobs ${enrichJobsExecuted ? "completed" : "skipped"}` },
	);

	// 7. RemoteEval Stage (Conditional Remote Confirmation) (Stage 5/8)
	let judgeInputFile = postEnrichmentInputFile;
	if (config.search.remoteOnly) {
		if (shouldExecutePhase("remoteEval", resumePhase)) {
			const remoteProviderRouting = await resolveStageProviderRouting({
				stage: "remoteEval",
				providerFlag: "--re-provider",
				presetName: config.presets.remoteEval,
				configuredRouting: config.providerRouting.remoteEval,
				allPresets,
				apiKey: config.providers.apiKey || "",
				signal,
				top: config.options.astroAutoProviderTop,
			});
			const remoteTimer = logger.startTimer("Stage 5/8: RemoteEval");
			logger.info(
				`Stage 5/8: Confirming remote status with ${config.presets.remoteEval}...`,
				{
					preset: config.presets.remoteEval,
					...(config.reasoningEffort.remoteEval
						? { reasoning_effort: config.reasoningEffort.remoteEval }
						: {}),
					...(remoteProviderRouting?.only?.length
						? {
								"re-provider": remoteProviderRouting.only.join(","),
							}
						: {}),
					...(remoteProviderRouting?.quantizations?.length
						? {
								"re-provider-quant":
									remoteProviderRouting.quantizations.join(","),
							}
						: {}),
				},
			);
			const remoteResult = await runRemoteEval({
				apiKey: config.providers.apiKey || "",
				inputFile: postEnrichmentInputFile,
				outputFile: config.paths.remoteEvalOutputFile,
				preset: config.presets.remoteEval,
				sleep: config.options.sleep,
				strictParsing: false,
				showReasoning: config.options.showReasoning,
				showStream: config.options.showStream,
				useCheckpoints: config.options.useCheckpoints,
				signal,
				...(config.reasoningEffort.remoteEval
					? { reasoningLevel: config.reasoningEffort.remoteEval }
					: {}),
				...(remoteProviderRouting
					? { providerRouting: remoteProviderRouting }
					: {}),
			});
			judgeInputFile = config.paths.remoteEvalOutputFile;
			stageResults.remoteEval = remoteResult;
			remoteTimer.done("Stage 5/8: RemoteEval completed", "success", {
				jobs: remoteResult.jobs,
				passed: remoteResult.passed,
			});
		} else {
			try {
				await fs.access(config.paths.remoteEvalOutputFile);
			} catch {
				throw new Error(
					`Cannot resume from ${resumePhase} with --remote-only: required remoteEval artifact is missing: ${config.paths.remoteEvalOutputFile}`,
				);
			}
			judgeInputFile = config.paths.remoteEvalOutputFile;
			logger.info(
				`Stage 5/8: RemoteEval skipped by resume (resuming from ${resumePhase}).`,
			);
			stageResults.remoteEval = { skipped: true };
		}
	} else {
		logger.info("Stage 5/8: RemoteEval skipped (--remote-only is disabled).");
		stageResults.remoteEval = { skipped: true, reason: "remote-only-disabled" };
	}
	const remoteEvalExecuted =
		config.search.remoteOnly && shouldExecutePhase("remoteEval", resumePhase);
	pipelineProgress.complete(
		{ stage: "remoteEval", executed: remoteEvalExecuted },
		{ suffix: `remoteEval ${remoteEvalExecuted ? "completed" : "skipped"}` },
	);

	// 8. JobJudge Stage (Deep Alignment Evaluation) (Stage 6/8)
	if (shouldExecutePhase("jobJudge", resumePhase)) {
		throwIfCancelled(signal);
		const judgeProviderRouting = await resolveStageProviderRouting({
			stage: "jobJudge",
			providerFlag: "--jj-provider",
			presetName: config.presets.jobJudge,
			configuredRouting: config.providerRouting.jobJudge,
			allPresets,
			apiKey: config.providers.apiKey || "",
			signal,
			top: config.options.astroAutoProviderTop,
		});
		const judgeTimer = logger.startTimer("Stage 6/8: JobJudge");
		logger.info(
			`Stage 6/8: Job alignment evaluation with ${config.presets.jobJudge}...`,
			{
				preset: config.presets.jobJudge,
				...(config.reasoningEffort?.jobJudge
					? { reasoning_effort: config.reasoningEffort.jobJudge }
					: {}),
				...(judgeProviderRouting?.only?.length
					? {
							"jj-provider": judgeProviderRouting.only.join(","),
						}
					: {}),
				...(judgeProviderRouting?.quantizations?.length
					? {
							"jj-provider-quant": judgeProviderRouting.quantizations.join(","),
						}
					: {}),
			},
		);
		const judgeResult = await runJobJudge({
			"api-key": config.providers.apiKey || "",
			"base-url": "",
			"model-id": "",
			"input-file": judgeInputFile,
			"output-file": path.join(config.paths.dataDir, "astroapply_eval_"),
			preset: config.presets.jobJudge,
			"use-jobdb": true,
			"strict-parsing": false,
			sleep: config.options.sleep,
			"eval-mode": 1,
			"show-reasoning": config.options.showReasoning,
			"show-stream": config.options.showStream,
			verbose: config.options.verbose,
			signal,
			...(config.reasoningEffort?.jobJudge
				? {
						"jj-reasoning-effort": config.reasoningEffort.jobJudge,
						reasoningEffort: config.reasoningEffort.jobJudge,
					}
				: {}),
			...(judgeProviderRouting
				? { providerRouting: judgeProviderRouting }
				: {}),
		});
		judgeTimer.done("Stage 6/8: JobJudge completed", "success", {
			jobs: judgeResult.jobs,
			passed: judgeResult.passed,
		});
		stageResults.jobJudge = judgeResult;
	} else {
		logger.info(
			`Stage 6/8: JobJudge skipped by resume (resuming from ${resumePhase}).`,
		);
		stageResults.jobJudge = { skipped: true };
	}
	const jobJudgeExecuted = shouldExecutePhase("jobJudge", resumePhase);
	pipelineProgress.complete(
		{ stage: "jobJudge", executed: jobJudgeExecuted },
		{ suffix: `jobJudge ${jobJudgeExecuted ? "completed" : "skipped"}` },
	);

	// 9. MakeMaterials Stage (Stage 7/8)
	const shouldMaterials =
		shouldExecutePhase("makeMaterials", resumePhase) && !options?.skipMaterials;
	if (shouldMaterials) {
		throwIfCancelled(signal);
		const materialsProviderRouting = await resolveStageProviderRouting({
			stage: "makeMaterials",
			providerFlag: "--mm-provider",
			presetName: config.presets.makeMaterials,
			configuredRouting: config.providerRouting.makeMaterials,
			allPresets,
			apiKey: config.providers.apiKey || "",
			signal,
			top: config.options.astroAutoProviderTop,
		});
		const matTimer = logger.startTimer("Stage 7/8: MakeMaterials");
		logger.info(
			`Stage 7/8: Application materials generation with ${config.presets.makeMaterials}...`,
			{
				preset: config.presets.makeMaterials,
				...(config.reasoningEffort?.makeMaterials
					? { reasoning_effort: config.reasoningEffort.makeMaterials }
					: {}),
				...(materialsProviderRouting?.only?.length
					? {
							"mm-provider": materialsProviderRouting.only.join(","),
						}
					: {}),
				...(materialsProviderRouting?.quantizations?.length
					? {
							"mm-provider-quant":
								materialsProviderRouting.quantizations.join(","),
						}
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
			...(materialsProviderRouting
				? { providerRouting: materialsProviderRouting }
				: {}),
			stats,
			signal,
		});
		matTimer.done("Stage 7/8: MakeMaterials completed", "success", {
			generated: materialsResult.content.length,
		});
		stageResults.makeMaterials = { generated: materialsResult.content.length };
	} else {
		const reason = !shouldExecutePhase("makeMaterials", resumePhase)
			? `skipped by resume (resuming from ${resumePhase}).`
			: "skipped by flag.";
		logger.info(`Stage 7/8: MakeMaterials ${reason}`);
		stageResults.makeMaterials = { skipped: true };
	}
	pipelineProgress.complete(
		{ stage: "makeMaterials", executed: shouldMaterials },
		{ suffix: `makeMaterials ${shouldMaterials ? "completed" : "skipped"}` },
	);

	// 10. Deployment Stage (Stage 8/8)
	if (shouldExecutePhase("deployment", resumePhase)) {
		throwIfCancelled(signal);
		if (config.deployment.enabled) {
			const deployTimer = logger.startTimer("Stage 8/8: Deployment");
			logger.info("Stage 8/8: Deploying materials...", {
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
				signal,
			);
			stageResults.deployment = deployResult;
			deployTimer.done(
				`Stage 8/8: Deployment completed (deployed ${deployResult.deployed} material items).`,
				"success",
				{ deployedCount: deployResult.deployed },
			);
		} else {
			logger.info("Stage 8/8: Deployment skipped (disabled).");
			stageResults.deployment = { skipped: true };
		}
	} else {
		logger.info(
			`Stage 8/8: Deployment skipped by resume (resuming from ${resumePhase}).`,
		);
		stageResults.deployment = { skipped: true };
	}
	const deploymentExecuted =
		shouldExecutePhase("deployment", resumePhase) && config.deployment.enabled;
	pipelineProgress.complete(
		{ stage: "deployment", executed: deploymentExecuted },
		{ suffix: `deployment ${deploymentExecuted ? "completed" : "skipped"}` },
	);

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

export async function executePipeline(
	config: PipelineConfig,
	options?: {
		skipAcquisition?: boolean;
		skipMaterials?: boolean;
		resume?: PipelinePhase;
		signal?: AbortSignal;
		watchdogFactory?: (options: InternetWatchdogOptions) => InternetWatchdog;
		"astro_auto_provider-top"?: number;
	},
): Promise<{
	success: boolean;
	durationMs: number;
	stages: Record<string, unknown>;
}> {
	const cancellation = new PipelineCancellationController();
	const externalSignal = options?.signal;
	const onExternalAbort = () => {
		cancellation.cancel({
			kind: "signal",
			signal: "SIGINT",
			error:
				externalSignal?.reason instanceof Error
					? externalSignal.reason
					: new Error("Pipeline cancelled"),
		});
	};
	if (externalSignal?.aborted) onExternalAbort();
	else
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

	let watchdog: InternetWatchdog | undefined;
	if (config.internetWatchdog.enabled) {
		const factory =
			options?.watchdogFactory ?? ((value) => new InternetWatchdog(value));
		watchdog = factory({
			target: config.internetWatchdog.target,
			onConnectivityLost: (error) => {
				cancellation.cancel({ kind: "watchdog", error });
			},
		});
	}

	const run = async () => {
		await watchdog?.validateStartup(cancellation.signal);
		watchdog?.start(cancellation.signal);
		const result = await executePipelineInternal(config, {
			...options,
			signal: cancellation.signal,
		});
		throwIfCancelled(cancellation.signal);
		return result;
	};

	try {
		if (!config.options.trackOpenRouterCosts) return await run();

		const usageTracker = new OpenRouterUsageTracker();
		let succeeded = false;
		return await llmService.runWithUsageTracker(usageTracker, async () => {
			try {
				const result = await run();
				succeeded = result.success;
				return result;
			} finally {
				const summary = usageTracker.getSummary();
				logger.info(
					`OpenRouter pipeline usage summary: input=${summary.inputTokens}, output=${summary.outputTokens}, total=${summary.totalTokens}, cost=${formatUsd(summary.costUsd)}`,
					{
						event: "openrouter.usage.pipeline_summary",
						status: succeeded ? "success" : "failed",
						accountedCalls: summary.accountedCalls,
						unavailableUsageCalls: summary.unavailableUsageCalls,
						inputTokens: summary.inputTokens,
						outputTokens: summary.outputTokens,
						totalTokens: summary.totalTokens,
						totalCostUsd: summary.costUsd,
					},
				);
			}
		});
	} catch (error) {
		if (
			cancellation.cause?.kind === "watchdog" &&
			!(error instanceof InternetConnectivityLostError)
		) {
			throw cancellation.cause.error;
		}
		throw error;
	} finally {
		cancellation.finish();
		externalSignal?.removeEventListener("abort", onExternalAbort);
		await watchdog?.stop();
	}
}

export function addRunPipelineCommand(
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> {
	return yargs.command(
		"run-pipeline",
		"Orchestrate the full AstroEX job pipeline with preflight, checkpoints, and materials generation.",
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
						"Remote destination for rclone deployment (e.g. GoogleDrive:/autoJobGen-src).",
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
					description:
						"Age limit for jobs in hours. Omit for no age constraint.",
				})
				.option("jobcloth-preset", {
					type: "string",
					description: "Preset for jobCloth filtering stage.",
				})
				.option("jobcloth-cool-off-days", {
					type: "number",
					description:
						"Skip jobs processed by jobCloth within this many 24-hour days.",
					default: DEFAULT_JOBCLOTH_COOL_OFF_DAYS,
				})
				.option("log-cool-offs", {
					type: "boolean",
					description:
						"Write jobs suppressed by the jobCloth cool-off window to a timestamped JSON file in the logs directory.",
					default: false,
				})
				.option("remoteeval-preset", {
					type: "string",
					description: "Preset for the conditional remoteEval stage.",
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
				.option("re-reasoning-level", {
					type: "string",
					description:
						"Reasoning level for remoteEval (mapped to the provider reasoning_effort field).",
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
				.option("jc-provider", {
					type: "string",
					description:
						"Ordered OpenRouter provider routing for jobCloth (single value or comma-separated list); use astro_auto_provider alone to select providers immediately before the stage.",
				})
				.option("re-provider", {
					type: "string",
					description:
						"Ordered OpenRouter provider routing for remoteEval (single value or comma-separated list); use astro_auto_provider alone to select providers immediately before the stage.",
				})
				.option("jj-provider", {
					type: "string",
					description:
						"Ordered OpenRouter provider routing for jobJudge (single value or comma-separated list); use astro_auto_provider alone to select providers immediately before the stage.",
				})
				.option("mm-provider", {
					type: "string",
					description:
						"Ordered OpenRouter provider routing for makeMaterials (single value or comma-separated list); use astro_auto_provider alone to select providers immediately before the stage.",
				})
				.option("provider-ignore", {
					type: "string",
					description:
						"Global OpenRouter providers to ignore across all pipeline stages (single value or comma-separated list).",
				})
				.option("jc-provider-quant", {
					type: "string",
					description:
						"Allowed OpenRouter quantizations for jobCloth (single value or comma-separated list, e.g. int4, int8, fp8, fp16).",
				})
				.option("re-provider-quant", {
					type: "string",
					description:
						"Allowed OpenRouter quantizations for remoteEval (single value or comma-separated list, e.g. int4, int8, fp8, fp16).",
				})
				.option("jj-provider-quant", {
					type: "string",
					description:
						"Allowed OpenRouter quantizations for jobJudge (single value or comma-separated list, e.g. int4, int8, fp8, fp16).",
				})
				.option("mm-provider-quant", {
					type: "string",
					description:
						"Allowed OpenRouter quantizations for makeMaterials (single value or comma-separated list, e.g. int4, int8, fp8, fp16).",
				})
				.option("astro_auto_provider-top", {
					type: "number",
					description:
						"Maximum unique providers returned by astro_auto_provider for stages using automatic provider selection (default: 3).",
				})
				.option("remote-only", {
					type: "boolean",
					description:
						"Retain remotely classified acquisitions and confirm remote status with remoteEval before jobJudge.",
				})
				.option("job-provider", {
					type: "string",
					description:
						"Job acquisition provider: indeed, linkedin, or comma-separated list (default: indeed).",
					default: "indeed",
				})
				.option("sites", {
					type: "string",
					description: "Alias for --job-provider.",
				})
				.option("show-fetch-url", {
					type: "boolean",
					description:
						"Display Indeed and LinkedIn fetch URLs in console output.",
					default: false,
				})
				.option("track-or-costs", {
					type: "boolean",
					description:
						"Track and log per-call and total OpenRouter token usage and cost for this pipeline execution.",
					default: false,
				})
				.option("internet-watchdog", {
					type: "string",
					requiresArg: false,
					description:
						"Monitor an IP address or hostname during this pipeline run; a bare flag uses 8.8.8.8.",
				})
				.option("resume", {
					type: "string",
					description:
						"Resume pipeline execution from a specific phase (acquireJobs, processData, jobCloth, enrichJobs, remoteEval, jobJudge, makeMaterials, deployment).",
				})
				.check((options) => {
					if (
						options["astro_auto_provider-top"] !== undefined &&
						(!Number.isInteger(options["astro_auto_provider-top"]) ||
							(options["astro_auto_provider-top"] as number) < 1)
					) {
						throw new Error(
							"--astro_auto_provider-top must be an integer of at least 1.",
						);
					}
					if (
						options["hours-old"] !== undefined &&
						(!Number.isFinite(options["hours-old"]) ||
							options["hours-old"] <= 0)
					) {
						throw new Error(
							"--hours-old must be greater than zero when supplied",
						);
					}
					if (options.resume !== undefined) {
						validateResumePhase(options.resume);
					}
					resolveInternetWatchdogOption(options["internet-watchdog"]);
					if (
						!Number.isSafeInteger(options["jobcloth-cool-off-days"]) ||
						(options["jobcloth-cool-off-days"] ?? 0) <= 0
					) {
						throw new Error(
							"--jobcloth-cool-off-days must be a positive integer",
						);
					}
					return true;
				}),
		async (argv) => {
			const options = argv as RunPipelineOptions;
			const resumePhase =
				options.resume !== undefined
					? validateResumePhase(options.resume)
					: undefined;
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

			const rawJobProvider =
				options["job-provider"] || options.jobProvider || options.sites;
			const providerSites = rawJobProvider
				? rawJobProvider
						.split(",")
						.map((s) => s.trim().toLowerCase())
						.filter(Boolean)
				: undefined;
			const internetWatchdog = resolveInternetWatchdogOption(
				options["internet-watchdog"] ?? options.internetWatchdog,
			);

			const config = buildPipelineConfig({
				search: {
					sites: providerSites,
					jobProvider: rawJobProvider,
					searchTermsFile: options["search-terms-file"],
					resultsWanted: options["results-wanted"],
					hoursOld: options["hours-old"],
					remoteOnly: resolveRemoteOnlyOption(
						options["remote-only"],
						options.remoteOnly,
					),
				},
				presets: {
					jobCloth: options["jobcloth-preset"],
					remoteEval: options["remoteeval-preset"],
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
				internetWatchdog,
				options: {
					clean: Boolean(options.clean),
					batchSize: options.batch,
					sleep: options.sleep,
					showReasoning: resolvedShowReasoning,
					hideReasoning: hideReasoningRequested,
					verbose: Boolean(options.verbose),
					showFetchUrl: Boolean(
						options["show-fetch-url"] ||
							options.showFetchUrl ||
							process.env.ASTROEX_SHOW_FETCH_URL === "1",
					),
					trackOpenRouterCosts: Boolean(
						options["track-or-costs"] || options.trackOrCosts,
					),
					logCoolOffs: Boolean(options["log-cool-offs"] || options.logCoolOffs),
					jobClothCoolOffDays: options["jobcloth-cool-off-days"],
					resume: resumePhase,
				},
				reasoningEffort: {
					jobCloth: options["jc-reasoning-effort"],
					remoteEval: options["re-reasoning-level"],
					jobJudge: options["jj-reasoning-effort"],
					makeMaterials: options["mm-reasoning-effort"],
				},
				providerIgnore: options["provider-ignore"],
				"jc-provider-quant": options["jc-provider-quant"],
				"re-provider-quant": options["re-provider-quant"],
				"jj-provider-quant": options["jj-provider-quant"],
				"mm-provider-quant": options["mm-provider-quant"],
				"astro_auto_provider-top":
					options["astro_auto_provider-top"] ?? options.astroAutoProviderTop,
				providerRouting: {
					jobCloth: parseOpenRouterProviderRouting(options["jc-provider"]),
					remoteEval: parseOpenRouterProviderRouting(options["re-provider"]),
					jobJudge: parseOpenRouterProviderRouting(options["jj-provider"]),
					makeMaterials: parseOpenRouterProviderRouting(options["mm-provider"]),
				},
			});

			const signalController = new AbortController();
			let receivedSignal: NodeJS.Signals | undefined;
			const handleSignal = (signal: NodeJS.Signals) => {
				if (signalController.signal.aborted) return;
				receivedSignal = signal;
				logger.warn(`Received ${signal}; cancelling pipeline gracefully.`);
				signalController.abort(new Error(`Pipeline interrupted by ${signal}`));
			};
			const onSigint = () => handleSignal("SIGINT");
			const onSigterm = () => handleSignal("SIGTERM");
			process.once("SIGINT", onSigint);
			process.once("SIGTERM", onSigterm);
			try {
				const result = await executePipeline(config, {
					skipAcquisition: Boolean(options["skip-acquisition"]),
					skipMaterials: Boolean(options["skip-materials"]),
					resume: resumePhase,
					signal: signalController.signal,
					"astro_auto_provider-top":
						options["astro_auto_provider-top"] ?? options.astroAutoProviderTop,
				});
				if (!result.success) {
					process.exitCode = 1;
				}
			} catch (error) {
				logger.error(
					`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);
				process.exitCode =
					receivedSignal === "SIGINT"
						? 130
						: receivedSignal === "SIGTERM"
							? 143
							: 1;
			} finally {
				process.removeListener("SIGINT", onSigint);
				process.removeListener("SIGTERM", onSigterm);
			}
		},
	);
}
