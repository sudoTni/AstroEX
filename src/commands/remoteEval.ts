import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeArtifactManifest } from "../artifactManifest";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository } from "../jobRepository";
import { type LLMRequest, llmService } from "../llmService";
import type { JobInterface } from "../models";
import {
	abortableDelay,
	rethrowIfCancelled,
	throwIfCancelled,
} from "../pipelineCancellation";
import {
	loadAndReplacePromptTemplate,
	loadPresets,
	loadPromptTemplate,
	loadVeritasSystemPrompt,
} from "../presets";
import {
	checkStageCheckpoint,
	completeStageCheckpoint,
	computeFileHash,
	initStageCheckpoint,
} from "../stageCheckpoint";
import { createStatisticsCollector } from "../statistics";
import type { Preset, RemoteEvalArgs } from "../types";
import { getPreset } from "../types";
import { createLogger, formatDate, log } from "../utils";
import { createProgressReporter } from "../utils/progress";

const logger = createLogger("RemoteEval");

const RequiredBooleanCoerce = z.preprocess((value) => {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "y"].includes(normalized)) return true;
		if (["false", "0", "no", "n"].includes(normalized)) return false;
	}
	return value;
}, z.boolean());

const ConfidenceCoerce = z.preprocess((value) => {
	if (value === undefined || value === null || value === "") return 0;
	const numeric = Number(value);
	if (Number.isNaN(numeric)) return 0;
	if (numeric > 1 && numeric <= 100) return numeric / 100;
	if (numeric > 1) return 1;
	if (numeric < 0) return 0;
	return numeric;
}, z.number().min(0).max(1).default(0));

export const RemoteEvalResultSchema = z
	.object({
		jobTitle: z.string().optional(),
		job_title: z.string().optional(),
		title: z.string().optional(),
		isConfirmedRemote: RequiredBooleanCoerce,
		rationale: z.string().optional().default(""),
		confidence: ConfidenceCoerce,
	})
	.passthrough()
	.transform((result) => ({
		jobTitle:
			result.jobTitle ?? result.job_title ?? result.title ?? "Not Specified",
		isConfirmedRemote: result.isConfirmedRemote,
		rationale: result.rationale,
		confidence: result.confidence,
	}));

const RemoteEvalResultArraySchema = z.array(RemoteEvalResultSchema).min(1);

export const RemoteEvalResultsSchema = z.union([
	RemoteEvalResultArraySchema,
	z
		.object({
			jobs: RemoteEvalResultArraySchema.optional(),
			results: RemoteEvalResultArraySchema.optional(),
			evaluations: RemoteEvalResultArraySchema.optional(),
			data: RemoteEvalResultArraySchema.optional(),
		})
		.passthrough()
		.refine(
			(value) =>
				Boolean(value.jobs || value.results || value.evaluations || value.data),
			{ message: "Expected jobs, results, evaluations, or data array" },
		)
		.transform(
			(value) =>
				value.jobs || value.results || value.evaluations || value.data || [],
		),
	RemoteEvalResultSchema.transform((single) => [single]),
]);

export type RemoteEvalResult = z.infer<typeof RemoteEvalResultSchema>;

export function sanitizeJobForRemoteEvaluation(
	job: JobInterface,
): JobInterface {
	const {
		confidence: _confidence,
		rationale: _rationale,
		isWorthInvestigating: _isWorthInvestigating,
		isVeryHighlyAligned: _isVeryHighlyAligned,
		isHighlyAligned: _isHighlyAligned,
		remoteOk: _remoteOk,
		isRemote: _isRemote,
		isConfirmedRemote: _isConfirmedRemote,
		remoteEvalMetadata: _remoteEvalMetadata,
		...unbiasedJob
	} = job;
	return unbiasedJob as JobInterface;
}

function ensureStableId(job: JobInterface): JobInterface {
	if (job.id?.trim()) return job;
	const seed = `${job.url}\u0000${job.company}\u0000${job.title}`;
	return {
		...job,
		id: crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16),
	};
}

async function readJobs(inputFile: string): Promise<JobInterface[]> {
	const parsed: unknown = JSON.parse(await fs.readFile(inputFile, "utf8"));
	const values = Array.isArray(parsed) ? parsed : [parsed];
	return values
		.filter(
			(value): value is JobInterface =>
				Boolean(value) &&
				typeof value === "object" &&
				typeof (value as JobInterface).title === "string" &&
				typeof (value as JobInterface).company === "string" &&
				typeof (value as JobInterface).url === "string",
		)
		.map(ensureStableId);
}

async function writeJobsAtomically(
	outputFile: string,
	jobs: JobInterface[],
): Promise<void> {
	await fs.mkdir(path.dirname(outputFile), { recursive: true });
	const temporaryFile = `${outputFile}.${process.pid}.tmp`;
	try {
		await fs.writeFile(temporaryFile, JSON.stringify(jobs, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporaryFile, outputFile);
	} catch (error) {
		await fs.rm(temporaryFile, { force: true });
		throw error;
	}
}

async function validateRemoteEvalPrompt(preset: Preset): Promise<void> {
	const template = await loadPromptTemplate(preset.promptTemplate);
	const placeholders = Array.from(
		template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g),
		(match) => match[1],
	);
	if (!placeholders.includes("targJD")) {
		throw new Error(
			`remoteEval prompt ${preset.promptTemplate} must contain {targJD}`,
		);
	}
	const unsupported = [...new Set(placeholders)].filter(
		(name) => name !== "targJD",
	);
	if (unsupported.length > 0) {
		throw new Error(
			`remoteEval prompt ${preset.promptTemplate} contains unsupported placeholder(s): ${unsupported.map((name) => `{${name}}`).join(", ")}`,
		);
	}
}

async function evaluateRemoteStatus(
	job: JobInterface,
	preset: Preset,
	options: RemoteEvalArgs,
	veritasSystemPrompt: string,
): Promise<{
	result: RemoteEvalResult;
	fallbackUsed: boolean;
	retries: number;
}> {
	const llmBoundJob = sanitizeJobForRemoteEvaluation(job);
	const prompt = await loadAndReplacePromptTemplate(preset.promptTemplate, {
		targJD: JSON.stringify(llmBoundJob, null, 2),
	});
	const reasoningEffort = options.reasoningLevel?.trim() || undefined;
	const request: LLMRequest = {
		provider: preset.provider as LLMRequest["provider"],
		model: preset.modelId,
		messages: [
			{ role: "system", content: veritasSystemPrompt },
			{ role: "user", content: prompt },
		],
		temperature: preset.temperature,
		topP: preset.topP,
		maxTokens: preset.maxTokens ?? 16_000,
		timeout: 30_000,
		responseSchema: RemoteEvalResultsSchema,
		showReasoningTokens: Boolean(options.showReasoning),
		hideReasoningTokens: !options.showReasoning,
		showResponseStream: Boolean(options.showStream),
		...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
		...(options.providerRouting
			? { providerRouting: options.providerRouting }
			: {}),
	};

	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		throwIfCancelled(options.signal);
		try {
			const response = await llmService.call(request, {
				payloadLogStage: "remoteEval",
				...(options.signal ? { signal: options.signal } : {}),
			});
			const results = RemoteEvalResultsSchema.parse(response.content);
			return { result: results[0], fallbackUsed: false, retries: attempt };
		} catch (error) {
			rethrowIfCancelled(error, options.signal);
			lastError = error;
			if (attempt < 2) {
				const retryDelayMs = options.retryDelayMs ?? 2 ** (attempt + 1) * 1000;
				await abortableDelay(retryDelayMs, options.signal);
			}
		}
	}

	if (options.strictParsing) {
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	return {
		result: {
			jobTitle: job.title,
			isConfirmedRemote: false,
			rationale:
				"LLM remote evaluation failed; recorded a conservative non-passing fallback.",
			confidence: 0,
		},
		fallbackUsed: true,
		retries: 3,
	};
}

export async function runRemoteEval(options: RemoteEvalArgs): Promise<{
	jobs: number;
	evaluated: number;
	passed: number;
	failed: number;
	outputFile: string;
}> {
	const stats = createStatisticsCollector("remoteEval");
	throwIfCancelled(options.signal);
	stats.startCollection();
	let repository: JobRepository | undefined;
	let jobs: JobInterface[] = [];
	let passedJobs: JobInterface[] = [];
	let evaluated = 0;

	try {
		const presets = await loadPresets();
		const preset = getPreset("remoteEval", options.preset, presets);
		if (!preset)
			throw new Error(`Unknown remoteEval preset: ${options.preset}`);
		await validateRemoteEvalPrompt(preset);

		jobs = await readJobs(options.inputFile);
		const inputHash = await computeFileHash(options.inputFile);
		let processedJobIds = new Set<string>();

		if (options.useCheckpoints !== false) {
			repository = new JobRepository({
				dbFilePath: path.join(path.dirname(options.outputFile), "jobDB.sqlite"),
				defaultExpirationMs: JOB_DB_RETENTION_MS,
				enableJobDB: true,
			});
			await repository.initialize();
			await repository.load();
			const checkpoint = await checkStageCheckpoint(
				"remoteEval",
				options.inputFile,
				options.outputFile,
				preset.name,
				preset.modelId,
				repository,
			);
			if (checkpoint.isCompleted) {
				passedJobs = await readJobs(options.outputFile);
				logger.info(
					`Durable checkpoint match: remoteEval already completed for ${options.inputFile}.`,
				);
				return {
					jobs: jobs.length,
					evaluated: jobs.length,
					passed: passedJobs.length,
					failed: jobs.length - passedJobs.length,
					outputFile: options.outputFile,
				};
			}
			if (checkpoint.hasMatchingWork) {
				try {
					passedJobs = await readJobs(options.outputFile);
					processedJobIds = checkpoint.processedJobIds;
				} catch {
					log(
						"RemoteEval",
						"Checkpoint output is unavailable; restarting remote evaluation safely.",
						"warn",
					);
					passedJobs = [];
					processedJobIds = new Set();
				}
			}
			await initStageCheckpoint(
				"remoteEval",
				options.inputFile,
				inputHash,
				options.outputFile,
				preset.name,
				preset.modelId,
				jobs.length,
				Array.from(processedJobIds),
				repository,
			);
		}

		await writeJobsAtomically(options.outputFile, passedJobs);
		llmService.initialize(
			[
				{
					name: preset.provider,
					baseUrl: preset.base_url,
					apiKey: options.apiKey || process.env.OPENAI_API_KEY || "",
					model: preset.modelId,
				},
			],
			preset.provider,
		);
		const veritasSystemPrompt = await loadVeritasSystemPrompt();
		const progress = createProgressReporter(logger, {
			label: "Stage 5/8: RemoteEval",
			unitLabel: "job",
			totalUnits: jobs.length,
			maxUpdates: Math.max(1, jobs.length),
		});

		for (const job of jobs) {
			throwIfCancelled(options.signal);
			if (processedJobIds.has(job.id)) {
				progress.complete(
					{ jobId: job.id, jobTitle: job.title, outcome: "checkpoint_skip" },
					{ suffix: "already evaluated from checkpoint" },
				);
				continue;
			}

			let result: RemoteEvalResult;
			let fallbackUsed = false;
			let retries = 0;
			if (!job.descriptionText?.trim()) {
				result = {
					jobTitle: job.title,
					isConfirmedRemote: false,
					rationale: "Job has no description to evaluate.",
					confidence: 0,
				};
				fallbackUsed = true;
			} else {
				const started = performance.now();
				stats.incrementCounter("api.totalCalls", 1);
				const outcome = await evaluateRemoteStatus(
					job,
					preset,
					options,
					veritasSystemPrompt,
				);
				result = outcome.result;
				fallbackUsed = outcome.fallbackUsed;
				retries = outcome.retries;
				stats.incrementCounter("api.successfulCalls", 1);
				stats.recordHistogram("api.responseTime", performance.now() - started);
				evaluated++;
			}

			if (result.isConfirmedRemote === true) {
				const confirmedJob: JobInterface = {
					...job,
					isConfirmedRemote: true,
					remoteEvalMetadata: {
						jobTitle: result.jobTitle,
						rationale: result.rationale,
						confidence: result.confidence,
						timestamp: new Date().toISOString(),
						fallbackUsed,
						retryCount: retries,
					},
				};
				passedJobs = [
					...passedJobs.filter((existing) => existing.id !== job.id),
					confirmedJob,
				];
			} else {
				stats.incrementCounter("data.recordsFiltered", 1);
			}

			await writeJobsAtomically(options.outputFile, passedJobs);
			if (repository) {
				repository.recordJobInCheckpoint(
					"remoteEval",
					inputHash,
					preset.name,
					preset.modelId,
					job.id,
				);
			}
			progress.complete(
				{
					jobId: job.id,
					jobTitle: job.title,
					outcome: result.isConfirmedRemote ? "passed" : "filtered",
				},
				fallbackUsed
					? { level: "warn", suffix: "conservative fallback" }
					: undefined,
			);
			if (options.sleep && options.sleep > 0) {
				const sleepMs = options.sleep * 1000;
				await abortableDelay(sleepMs, options.signal);
			}
		}

		throwIfCancelled(options.signal);
		await writeArtifactManifest(options.outputFile, "remoteEval", {
			preset: preset.name,
			model: preset.modelId,
			inputJobs: jobs.length,
			passed: passedJobs.length,
			failed: jobs.length - passedJobs.length,
		});
		if (repository) {
			await completeStageCheckpoint(
				"remoteEval",
				inputHash,
				options.outputFile,
				preset.name,
				preset.modelId,
				jobs.length,
				repository,
			);
		}

		stats.recordSuccess("remoteEval.complete", {
			jobs: jobs.length,
			passed: passedJobs.length,
		});
		await fs.mkdir(path.join(path.dirname(options.outputFile), "statistics"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(
				path.dirname(options.outputFile),
				"statistics",
				`remoteEval_stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
			),
			stats.export("json"),
			{ encoding: "utf8", mode: 0o600 },
		);
		logger.success(
			`Remote evaluation kept ${passedJobs.length} of ${jobs.length} jobs.`,
		);
		return {
			jobs: jobs.length,
			evaluated,
			passed: passedJobs.length,
			failed: jobs.length - passedJobs.length,
			outputFile: options.outputFile,
		};
	} finally {
		if (repository) await repository.close();
		stats.endCollection();
	}
}
