import * as path from "node:path";
import { z } from "zod";
import {
	getDataDirectory,
	getLogsDirectory,
	getMaterialsDirectory,
	getProfileDirectory,
} from "./runtimePaths";

export const PipelineConfigSchema = z.object({
	search: z.object({
		sites: z.array(z.string()).default(["indeed"]),
		searchTermsFile: z.string().default("search_terms.txt"),
		searchTerms: z.array(z.string()).optional(),
		locations: z.array(z.string()).default([""]),
		indeedCountry: z.string().default("USA"),
		hoursOld: z.number().nonnegative().default(24),
		resultsWanted: z.number().positive().default(9999),
		descriptionMode: z.enum(["available", "full", "auto"]).default("available"),
		remoteOnly: z.boolean().default(false),
	}),
	paths: z.object({
		dataDir: z.string(),
		logDir: z.string(),
		materialsDir: z.string(),
		profileDir: z.string(),
		deployedMaterialsDir: z.string(),
		acquiredJobsFile: z.string(),
		processedJobsFile: z.string(),
		clothedJobsFile: z.string(),
	}),
	presets: z.object({
		jobCloth: z.string().default("jc_glm-5.3-flash"),
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
	options: z.object({
		clean: z.boolean().default(false),
		batchSize: z.number().positive().default(25),
		sleep: z.number().nonnegative().default(5),
		showReasoning: z.boolean().default(true),
		hideReasoning: z.boolean().default(false),
		showStream: z.boolean().default(true),
		verbose: z.boolean().default(false),
		useCheckpoints: z.boolean().default(true),
	}),
	reasoningEffort: z
		.object({
			jobCloth: z.string().optional(),
			jobJudge: z.string().optional(),
			makeMaterials: z.string().optional(),
		})
		.default({}),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type PipelineConfigInput = z.input<typeof PipelineConfigSchema>;

function parsePositiveInt(val?: string): number | undefined {
	if (!val) return undefined;
	const parsed = Number.parseInt(val, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Merges environment variables, defaults, and runtime overrides into a validated PipelineConfig.
 */
export function buildPipelineConfig(
	overrides?: Partial<PipelineConfigInput>,
): PipelineConfig {
	const dataDir = overrides?.paths?.dataDir || getDataDirectory();
	const logDir = overrides?.paths?.logDir || getLogsDirectory();
	const materialsDir =
		overrides?.paths?.materialsDir || getMaterialsDirectory();
	const profileDir = overrides?.paths?.profileDir || getProfileDirectory();
	const deployedMaterialsDir =
		overrides?.paths?.deployedMaterialsDir ||
		process.env.ASTROEX_DEPLOYED_MATERIALS_DIR ||
		path.join(path.dirname(materialsDir), "materials-deployed");

	const rawConfig: PipelineConfigInput = {
		search: {
			sites: overrides?.search?.sites ?? ["indeed"],
			searchTermsFile: overrides?.search?.searchTermsFile ?? "search_terms.txt",
			searchTerms: overrides?.search?.searchTerms,
			locations: overrides?.search?.locations ?? [""],
			indeedCountry: overrides?.search?.indeedCountry ?? "USA",
			hoursOld: overrides?.search?.hoursOld ?? 24,
			resultsWanted: overrides?.search?.resultsWanted ?? 9999,
			descriptionMode: overrides?.search?.descriptionMode ?? "available",
			remoteOnly:
				overrides?.search?.remoteOnly !== undefined
					? overrides.search.remoteOnly
					: process.env.ASTROEX_REMOTE_ONLY === "1",
		},
		paths: {
			dataDir,
			logDir,
			materialsDir,
			profileDir,
			deployedMaterialsDir,
			acquiredJobsFile:
				overrides?.paths?.acquiredJobsFile ??
				path.join(dataDir, "acquired_jobs_indeed.json"),
			processedJobsFile:
				overrides?.paths?.processedJobsFile ??
				path.join(dataDir, "processed_jobs_indeed.json"),
			clothedJobsFile:
				overrides?.paths?.clothedJobsFile ??
				path.join(dataDir, "clothed_jobs_indeed.json"),
		},
		presets: {
			jobCloth:
				overrides?.presets?.jobCloth ??
				process.env.ASTROEX_JOB_CLOTH_PRESET ??
				"jc_glm-5.3-flash",
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
		},
		reasoningEffort: {
			jobCloth:
				typeof overrides?.reasoningEffort?.jobCloth === "string" &&
				overrides.reasoningEffort.jobCloth.trim().length > 0
					? overrides.reasoningEffort.jobCloth.trim()
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
	};

	return PipelineConfigSchema.parse(rawConfig);
}
