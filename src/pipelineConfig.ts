import * as path from "node:path";
import { z } from "zod";
import { DEFAULT_TOP } from "./astroAutoProvider";
import { DEFAULT_JOBCLOTH_COOL_OFF_DAYS } from "./constants";
import {
	DEFAULT_WATCHDOG_TARGET,
	validateAndNormalizeProbeTarget,
} from "./internetWatchdog";
import {
	getDataDirectory,
	getMaterialsDirectory,
	getProfileDirectory,
} from "./runtimePaths";
import type { OpenRouterProviderRouting } from "./types";

export const PIPELINE_PHASES = [
	"acquireJobs",
	"processData",
	"jobCloth",
	"enrichJobs",
	"remoteEval",
	"jobJudge",
	"makeMaterials",
	"deployment",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export function validateResumePhase(phase: unknown): PipelinePhase {
	if (
		typeof phase !== "string" ||
		!PIPELINE_PHASES.includes(phase as PipelinePhase)
	) {
		throw new Error(
			`Invalid --resume phase "${String(phase)}".\nValid phases: ${PIPELINE_PHASES.join(", ")}`,
		);
	}
	return phase as PipelinePhase;
}

export function shouldExecutePhase(
	currentPhase: PipelinePhase,
	resumePhase?: PipelinePhase,
): boolean {
	if (!resumePhase) return true;
	const resumeIndex = PIPELINE_PHASES.indexOf(resumePhase);
	const currentIndex = PIPELINE_PHASES.indexOf(currentPhase);
	return currentIndex >= resumeIndex;
}

/** Parse an ordered, comma-separated list of strings. */
export function parseCommaSeparatedList(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** Parse an ordered, comma-separated OpenRouter provider routing list. */
export function parseOpenRouterProviderRouting(
	value: unknown,
): OpenRouterProviderRouting | undefined {
	const only = parseCommaSeparatedList(value);
	return only ? { only } : undefined;
}

const OpenRouterProviderRoutingSchema = z
	.object({
		only: z.array(z.string().trim().min(1)).min(1).optional(),
		ignore: z.array(z.string().trim().min(1)).min(1).optional(),
		quantizations: z.array(z.string().trim().min(1)).min(1).optional(),
	})
	.refine(
		(val) =>
			Boolean(
				val.only?.length || val.ignore?.length || val.quantizations?.length,
			),
		{
			message:
				"providerRouting must contain at least one of 'only', 'ignore', or 'quantizations'",
		},
	);

export const PipelineConfigSchema = z.object({
	search: z.object({
		sites: z.array(z.string()).default(["indeed"]),
		jobProvider: z.string().optional(),
		searchTermsFile: z.string().default("search_terms.txt"),
		searchTerms: z.array(z.string()).optional(),
		locations: z.array(z.string()).default([""]),
		indeedCountry: z.string().default("USA"),
		hoursOld: z.number().positive().optional(),
		resultsWanted: z.number().positive().default(9999),
		descriptionMode: z.enum(["available", "full", "auto"]).default("available"),
		remoteOnly: z.boolean().default(false),
	}),
	paths: z.object({
		dataDir: z.string(),
		materialsDir: z.string(),
		profileDir: z.string(),
		deployedMaterialsDir: z.string(),
		acquiredJobsFile: z.string(),
		acquiredJobsIndeedFile: z.string().optional(),
		acquiredJobsLinkedInFile: z.string().optional(),
		processedJobsFile: z.string(),
		clothedJobsFile: z.string(),
		clothedJobsEnrichedFile: z.string(),
		remoteEvalOutputFile: z.string(),
	}),
	presets: z.object({
		jobCloth: z.string().default("jc_glm-5.3-flash"),
		remoteEval: z.string().default("re_glm-5.3-flash"),
		jobJudge: z.string().default("jep_glm-5.3-flash"),
		makeMaterials: z.string().default("rop_g5.6-luna_or"),
	}),
	providers: z.object({
		apiKey: z.string().optional(),
		indeedApiKey: z.string().optional(),
	}),
	budgets: z.object({
		maxLlmRequests: z.number().positive().optional(),
		maxLlmOutputTokens: z.number().positive().optional(),
		maxTotalLlmOutputTokens: z.number().positive().optional(),
		llmDeadlineMs: z.number().positive().optional(),
	}),
	deployment: z.object({
		enabled: z.boolean().default(false),
		destination: z.string().optional(),
	}),
	internetWatchdog: z.discriminatedUnion("enabled", [
		z.object({ enabled: z.literal(false) }),
		z.object({
			enabled: z.literal(true),
			target: z.string().transform(validateAndNormalizeProbeTarget),
		}),
	]),
	options: z.object({
		clean: z.boolean().default(false),
		batchSize: z.number().positive().default(25),
		sleep: z.number().nonnegative().default(5),
		showReasoning: z.boolean().default(true),
		hideReasoning: z.boolean().default(false),
		showStream: z.boolean().default(true),
		verbose: z.boolean().default(false),
		useCheckpoints: z.boolean().default(true),
		showFetchUrl: z.boolean().default(false),
		trackOpenRouterCosts: z.boolean().default(false),
		logCoolOffs: z.boolean().default(false),
		jobClothCoolOffDays: z
			.number()
			.int()
			.positive()
			.safe()
			.default(DEFAULT_JOBCLOTH_COOL_OFF_DAYS),
		astroAutoProviderTop: z
			.number()
			.int()
			.positive()
			.safe()
			.default(DEFAULT_TOP),
		resume: z.enum(PIPELINE_PHASES).optional(),
	}),
	reasoningEffort: z
		.object({
			jobCloth: z.string().optional(),
			remoteEval: z.string().optional(),
			jobJudge: z.string().optional(),
			makeMaterials: z.string().optional(),
		})
		.default({}),
	providerIgnore: z.array(z.string().trim().min(1)).optional(),
	providerRouting: z
		.object({
			jobCloth: OpenRouterProviderRoutingSchema.optional(),
			remoteEval: OpenRouterProviderRoutingSchema.optional(),
			jobJudge: OpenRouterProviderRoutingSchema.optional(),
			makeMaterials: OpenRouterProviderRoutingSchema.optional(),
		})
		.default({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type PipelineConfigInput = z.input<typeof PipelineConfigSchema>;

export type BuildPipelineConfigOverrides = Omit<
	Partial<PipelineConfigInput>,
	"providerIgnore"
> & {
	providerIgnore?: string[] | string;
	"provider-ignore"?: string;
	"jc-provider-quant"?: string;
	"re-provider-quant"?: string;
	"jj-provider-quant"?: string;
	"mm-provider-quant"?: string;
	"astro_auto_provider-top"?: number | string;
	astroAutoProviderTop?: number | string;
	providerQuantizations?: {
		jobCloth?: string[] | string;
		remoteEval?: string[] | string;
		jobJudge?: string[] | string;
		makeMaterials?: string[] | string;
	};
};

function parsePositiveInt(val?: string): number | undefined {
	if (!val) return undefined;
	const parsed = Number.parseInt(val, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Merges environment variables, defaults, and runtime overrides into a validated PipelineConfig.
 */
export function buildPipelineConfig(
	overrides?: BuildPipelineConfigOverrides,
): PipelineConfig {
	const dataDir = overrides?.paths?.dataDir || getDataDirectory();
	const materialsDir =
		overrides?.paths?.materialsDir || getMaterialsDirectory();
	const profileDir = overrides?.paths?.profileDir || getProfileDirectory();
	const deployedMaterialsDir =
		overrides?.paths?.deployedMaterialsDir ||
		process.env.ASTROEX_DEPLOYED_MATERIALS_DIR ||
		path.join(path.dirname(materialsDir), "materials-deployed");

	const envJobProvider = (
		process.env.ASTROEX_JOB_PROVIDER || process.env.AEX_JOB_PROVIDER
	)?.trim();
	const defaultSites = envJobProvider
		? envJobProvider
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean)
		: ["indeed"];
	const sites =
		overrides?.search?.sites ??
		(overrides?.search?.jobProvider
			? overrides.search.jobProvider
					.split(",")
					.map((s) => s.trim().toLowerCase())
					.filter(Boolean)
			: defaultSites);

	const rawProviderIgnore =
		overrides?.providerIgnore ?? overrides?.["provider-ignore"];
	const globalIgnore = Array.isArray(rawProviderIgnore)
		? rawProviderIgnore.map((s) => s.trim()).filter(Boolean)
		: parseCommaSeparatedList(rawProviderIgnore);

	const resolveStageQuant = (
		flagVal?: unknown,
		stageVal?: string[] | string,
	): string[] | undefined => {
		if (Array.isArray(stageVal)) {
			const mapped = stageVal
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			return mapped.length > 0 ? mapped : undefined;
		}
		const val = stageVal ?? flagVal;
		const parsed = parseCommaSeparatedList(val);
		return parsed ? parsed.map((q) => q.toLowerCase()) : undefined;
	};

	const buildStageRouting = (
		stageRoute?: OpenRouterProviderRouting,
		stageQuant?: string[],
	): OpenRouterProviderRouting | undefined => {
		if (!stageRoute && !stageQuant && !globalIgnore) {
			return undefined;
		}
		const only = stageRoute?.only;
		const quantList = stageRoute?.quantizations ?? stageQuant;
		const ignoreList = stageRoute?.ignore ?? globalIgnore;

		if (
			only === undefined &&
			quantList === undefined &&
			ignoreList === undefined
		) {
			return undefined;
		}
		return {
			...(only !== undefined ? { only } : {}),
			...(ignoreList !== undefined ? { ignore: ignoreList } : {}),
			...(quantList !== undefined ? { quantizations: quantList } : {}),
		};
	};

	const stageQuants = {
		jobCloth: resolveStageQuant(
			overrides?.["jc-provider-quant"],
			overrides?.providerQuantizations?.jobCloth,
		),
		remoteEval: resolveStageQuant(
			overrides?.["re-provider-quant"],
			overrides?.providerQuantizations?.remoteEval,
		),
		jobJudge: resolveStageQuant(
			overrides?.["jj-provider-quant"],
			overrides?.providerQuantizations?.jobJudge,
		),
		makeMaterials: resolveStageQuant(
			overrides?.["mm-provider-quant"],
			overrides?.providerQuantizations?.makeMaterials,
		),
	};

	const rawTop =
		overrides?.["astro_auto_provider-top"] ??
		overrides?.astroAutoProviderTop ??
		overrides?.options?.astroAutoProviderTop;
	const envTop = process.env.ASTROEX_ASTRO_AUTO_PROVIDER_TOP;
	let astroAutoProviderTop: unknown;
	if (rawTop !== undefined && rawTop !== null) {
		if (typeof rawTop === "string") {
			const trimmed = rawTop.trim();
			const parsed = Number(trimmed);
			astroAutoProviderTop = Number.isFinite(parsed) ? parsed : rawTop;
		} else {
			astroAutoProviderTop = rawTop;
		}
	} else if (envTop !== undefined && envTop.trim() !== "") {
		const trimmed = envTop.trim();
		const parsed = Number(trimmed);
		astroAutoProviderTop = Number.isFinite(parsed) ? parsed : envTop;
	} else {
		astroAutoProviderTop = DEFAULT_TOP;
	}

	const rawConfig: PipelineConfigInput = {
		search: {
			sites,
			jobProvider:
				overrides?.search?.jobProvider ?? (envJobProvider || sites.join(",")),
			searchTermsFile: overrides?.search?.searchTermsFile ?? "search_terms.txt",
			searchTerms: overrides?.search?.searchTerms,
			locations: overrides?.search?.locations ?? [""],
			indeedCountry: overrides?.search?.indeedCountry ?? "USA",
			hoursOld: overrides?.search?.hoursOld,
			resultsWanted: overrides?.search?.resultsWanted ?? 9999,
			descriptionMode: overrides?.search?.descriptionMode ?? "available",
			remoteOnly:
				overrides?.search?.remoteOnly !== undefined
					? overrides.search.remoteOnly
					: process.env.ASTROEX_REMOTE_ONLY === "1",
		},
		paths: {
			dataDir,
			materialsDir,
			profileDir,
			deployedMaterialsDir,
			acquiredJobsFile:
				overrides?.paths?.acquiredJobsFile ??
				path.join(dataDir, "acquired_jobs_indeed.json"),
			acquiredJobsIndeedFile:
				overrides?.paths?.acquiredJobsIndeedFile ??
				overrides?.paths?.acquiredJobsFile ??
				path.join(dataDir, "acquired_jobs_indeed.json"),
			acquiredJobsLinkedInFile:
				overrides?.paths?.acquiredJobsLinkedInFile ??
				path.join(dataDir, "acquired_jobs_linkedin.json"),
			processedJobsFile:
				overrides?.paths?.processedJobsFile ??
				path.join(dataDir, "processed_jobs_indeed.json"),
			clothedJobsFile:
				overrides?.paths?.clothedJobsFile ??
				path.join(dataDir, "clothed_jobs_indeed.json"),
			clothedJobsEnrichedFile:
				overrides?.paths?.clothedJobsEnrichedFile ??
				path.join(dataDir, "clothed_jobs_enriched.json"),
			remoteEvalOutputFile:
				overrides?.paths?.remoteEvalOutputFile ??
				path.join(dataDir, "remote_eval_pass.json"),
		},
		presets: {
			jobCloth:
				overrides?.presets?.jobCloth ??
				process.env.ASTROEX_JOB_CLOTH_PRESET ??
				"jc_glm-5.3-flash",
			remoteEval:
				overrides?.presets?.remoteEval ??
				process.env.ASTROEX_REMOTE_EVAL_PRESET ??
				"re_glm-5.3-flash",
			jobJudge:
				overrides?.presets?.jobJudge ??
				process.env.ASTROEX_JOB_JUDGE_PRESET ??
				"jep_glm-5.3-flash",
			makeMaterials:
				overrides?.presets?.makeMaterials ??
				process.env.ASTROEX_MAKE_MATERIALS_PRESET ??
				"rop_g5.6-luna_or",
		},
		providers: {
			apiKey:
				overrides?.providers?.apiKey ??
				process.env.AEX_OR_API_KEY ??
				process.env.OPENAI_API_KEY,
			indeedApiKey:
				overrides?.providers?.indeedApiKey ??
				process.env.ASTROEX_INDEED_API_KEY,
		},
		budgets: {
			maxLlmRequests:
				overrides?.budgets?.maxLlmRequests ??
				parsePositiveInt(process.env.ASTROEX_MAX_LLM_REQUESTS),
			maxLlmOutputTokens:
				overrides?.budgets?.maxLlmOutputTokens ??
				parsePositiveInt(process.env.ASTROEX_MAX_LLM_OUTPUT_TOKENS),
			maxTotalLlmOutputTokens:
				overrides?.budgets?.maxTotalLlmOutputTokens ??
				parsePositiveInt(process.env.ASTROEX_MAX_TOTAL_LLM_OUTPUT_TOKENS),
			llmDeadlineMs:
				overrides?.budgets?.llmDeadlineMs ??
				parsePositiveInt(process.env.ASTROEX_LLM_DEADLINE_MS),
		},
		deployment: {
			enabled:
				overrides?.deployment?.enabled ??
				process.env.AEX_DEPLOY === "1" ??
				false,
			destination:
				overrides?.deployment?.destination ??
				process.env.AEX_DEPLOY_DESTINATION,
		},
		internetWatchdog:
			overrides?.internetWatchdog?.enabled === true
				? {
						enabled: true,
						target:
							overrides.internetWatchdog.target ?? DEFAULT_WATCHDOG_TARGET,
					}
				: { enabled: false },
		options: {
			clean:
				overrides?.options?.clean ?? process.env.AEX_CLEAN === "1" ?? false,
			batchSize: overrides?.options?.batchSize ?? 25,
			sleep: overrides?.options?.sleep ?? 5,
			showReasoning:
				overrides?.options?.hideReasoning === true ||
				process.env.ASTROEX_HIDE_REASONING === "1"
					? false
					: (overrides?.options?.showReasoning ?? true),
			hideReasoning:
				overrides?.options?.hideReasoning ??
				process.env.ASTROEX_HIDE_REASONING === "1" ??
				false,
			showStream: overrides?.options?.showStream ?? true,
			verbose:
				overrides?.options?.verbose ?? process.env.ASTROEX_VERBOSE === "1",
			useCheckpoints: overrides?.options?.useCheckpoints ?? true,
			showFetchUrl:
				overrides?.options?.showFetchUrl ??
				(process.env.ASTROEX_SHOW_FETCH_URL === "1" || false),
			trackOpenRouterCosts: overrides?.options?.trackOpenRouterCosts ?? false,
			logCoolOffs: overrides?.options?.logCoolOffs ?? false,
			jobClothCoolOffDays:
				overrides?.options?.jobClothCoolOffDays ??
				DEFAULT_JOBCLOTH_COOL_OFF_DAYS,
			astroAutoProviderTop: astroAutoProviderTop as number,
			resume: overrides?.options?.resume,
		},
		reasoningEffort: {
			jobCloth:
				typeof overrides?.reasoningEffort?.jobCloth === "string" &&
				overrides.reasoningEffort.jobCloth.trim().length > 0
					? overrides.reasoningEffort.jobCloth.trim()
					: undefined,
			remoteEval:
				typeof overrides?.reasoningEffort?.remoteEval === "string" &&
				overrides.reasoningEffort.remoteEval.trim().length > 0
					? overrides.reasoningEffort.remoteEval.trim()
					: undefined,
			jobJudge:
				typeof overrides?.reasoningEffort?.jobJudge === "string" &&
				overrides.reasoningEffort.jobJudge.trim().length > 0
					? overrides.reasoningEffort.jobJudge.trim()
					: undefined,
			makeMaterials:
				typeof overrides?.reasoningEffort?.makeMaterials === "string" &&
				overrides.reasoningEffort.makeMaterials.trim().length > 0
					? overrides.reasoningEffort.makeMaterials.trim()
					: undefined,
		},
		providerIgnore:
			globalIgnore && globalIgnore.length > 0 ? globalIgnore : undefined,
		providerRouting: {
			jobCloth: buildStageRouting(
				overrides?.providerRouting?.jobCloth,
				stageQuants.jobCloth,
			),
			remoteEval: buildStageRouting(
				overrides?.providerRouting?.remoteEval,
				stageQuants.remoteEval,
			),
			jobJudge: buildStageRouting(
				overrides?.providerRouting?.jobJudge,
				stageQuants.jobJudge,
			),
			makeMaterials: buildStageRouting(
				overrides?.providerRouting?.makeMaterials,
				stageQuants.makeMaterials,
			),
		},
	};

	return PipelineConfigSchema.parse(rawConfig);
}
