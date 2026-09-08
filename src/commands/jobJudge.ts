import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { z } from "zod";
import { writeArtifactManifest } from "../artifactManifest";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository } from "../jobRepository";
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
	getProjectDirectory,
} from "../runtimePaths";
import {
	checkStageCheckpoint,
	completeStageCheckpoint,
	computeFileHash,
	initStageCheckpoint,
} from "../stageCheckpoint";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs, JobJudgeArgs, Preset } from "../types";
import { getPreset } from "../types";
import {
	closeFileLogging,
	createLogger,
	formatDate,
	initializeFileLogging,
	log,
} from "../utils";
import { loadApplicationData } from "../utils/sharedCommandUtils";
import { withSpinner } from "../utils/spinner";

const logger = createLogger("JobJudge");

const rootDirectory = getProjectDirectory();

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

const JobAnalysisSchema = z
	.object({
		jobTitle: z.string().optional(),
		job_title: z.string().optional(),
		title: z.string().optional(),
		isVeryHighlyAligned: BooleanCoerce,
		isWorthInvestigating: BooleanCoerce,
		isHighlyAligned: BooleanCoerce,
		rationale: z.string().optional().default(""),
		confidence: ConfidenceCoerce,
	})
	.refine((data) => Boolean(data.jobTitle || data.job_title || data.title), {
		message: "jobTitle, job_title, or title is required",
	})
	.transform((data) => {
		const isAligned = Boolean(
			data.isVeryHighlyAligned ??
				data.isWorthInvestigating ??
				data.isHighlyAligned ??
				false,
		);
		return {
			jobTitle: data.jobTitle ?? data.job_title ?? data.title ?? "",
			isVeryHighlyAligned: isAligned,
			isWorthInvestigating: isAligned,
			isHighlyAligned: isAligned,
			rationale: data.rationale,
			confidence: data.confidence,
		};
	});
const JobAnalysisResultsSchema = z.union([
	z.array(JobAnalysisSchema).min(1),
	z
		.object({
			jobs: z.array(JobAnalysisSchema).min(1).optional(),
			results: z.array(JobAnalysisSchema).min(1).optional(),
			evaluations: z.array(JobAnalysisSchema).min(1).optional(),
			data: z.array(JobAnalysisSchema).min(1).optional(),
		})
		.refine(
			(obj) => Boolean(obj.jobs || obj.results || obj.evaluations || obj.data),
			{ message: "Expected jobs, results, evaluations, or data array" },
		)
		.transform(
			(obj) => obj.jobs || obj.results || obj.evaluations || obj.data || [],
		),
	JobAnalysisSchema.transform((single) => [single]),
]);
type JobAnalysisResult = z.infer<typeof JobAnalysisSchema>;

export type JudgeCli = GlobalArgs &
	JobJudgeArgs & {
		"input-file": string;
		"output-file": string;
		"use-jobdb": boolean;
		"max-tokens"?: number;
		"strict-parsing": boolean;
		"log-payload": boolean;
		sleep: number;
		"eval-mode": number;
		"hide-reasoning"?: boolean;
		"hide-reasoning-tokens"?: boolean;
		hr?: boolean;
		sr?: boolean;
	};

/** Discover a file, directory, or a single-directory wildcard without shell expansion. */
export async function findJobFiles(
	input: string,
	baseDirectory = rootDirectory,
): Promise<string[]> {
	const absolute = path.resolve(baseDirectory, input);
	if (!input.includes("*")) {
		const stat = await fs.stat(absolute);
		if (stat.isFile()) return [absolute];
		return (await fs.readdir(absolute))
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => path.join(absolute, file));
	}
	const directory = path.dirname(absolute);
	const matcher = new RegExp(
		`^${path
			.basename(input)
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")}$`,
	);
	return (await fs.readdir(directory))
		.filter((file) => matcher.test(file))
		.sort()
		.map((file) => path.join(directory, file));
}

function parseJobFile(content: string, filePath: string): JobInterface[] {
	try {
		const parsed: unknown = JSON.parse(content);
		const jobs = Array.isArray(parsed) ? parsed : [parsed];
		return jobs.filter(isJobRecord).map((job) => withStableId(job, filePath));
	} catch {
		const jobs: JobInterface[] = [];
		for (const line of content.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isJobRecord(parsed)) jobs.push(withStableId(parsed, filePath));
			} catch {
				throw new Error(
					`${path.basename(filePath)} is neither a JSON array/object nor newline-delimited JSON.`,
				);
			}
		}
		return jobs;
	}
}

function isJobRecord(value: unknown): value is JobInterface {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<JobInterface>;
	return (
		typeof job.title === "string" &&
		typeof job.company === "string" &&
		typeof job.url === "string"
	);
}

function withStableId(job: JobInterface, filePath: string): JobInterface {
	if (job.id?.trim()) return job;
	let urlId: string | null = null;
	try {
		urlId = new URL(job.url).searchParams.get("jk");
	} catch {}
	const seed =
		urlId ??
		`${job.url}\u0000${job.company}\u0000${job.title}\u0000${filePath}`;
	return {
		...job,
		id: crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16),
	};
}

function isIndeedJob(job: JobInterface): boolean {
	try {
		return (
			job.source === "indeed" ||
			new URL(job.url).hostname.endsWith("indeed.com")
		);
	} catch {
		return false;
	}
}

function safeFileName(job: JobInterface): string {
	return (job.sourceJobId || job.id || "job").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function evaluate(
	job: JobInterface,
	preset: Preset,
	argv: JudgeCli,
	appData: { resume: string; testimonials: string },
	veritasSystemPrompt: string,
): Promise<{
	result: JobAnalysisResult;
	fallbackUsed: boolean;
	retries: number;
}> {
	const prompt = await loadAndReplacePromptTemplate(preset.promptTemplate, {
		targJD: JSON.stringify(job, null, 2),
		myResume: appData.resume,
		myTestimonials: appData.testimonials,
	});
	const hideReasoning = Boolean(
		argv["hide-reasoning"] ||
			argv["hide-reasoning-tokens"] ||
			argv.hr ||
			process.env.ASTROEX_HIDE_REASONING === "1",
	);
	const showReasoning =
		!hideReasoning &&
		Boolean(argv["show-reasoning"] || argv["show-reasoning-tokens"] || argv.sr);

	const rawReasoningEffort =
		argv["jj-reasoning-effort"] ??
		argv["reasoning-effort"] ??
		argv.reasoningEffort;
	const effectiveReasoningEffort =
		typeof rawReasoningEffort === "string" &&
		rawReasoningEffort.trim().length > 0
			? rawReasoningEffort.trim()
			: undefined;

	const request: LLMRequest = {
		provider: preset.provider as LLMRequest["provider"],
		model: preset.modelId,
		messages: [
			{ role: "system", content: veritasSystemPrompt },
			{ role: "user", content: prompt },
		],
		temperature: preset.temperature,
		topP: preset.topP,
		maxTokens: argv["max-tokens"] ?? preset.maxTokens ?? 16_000,
		timeout: 30_000,
		responseSchema: JobAnalysisResultsSchema,
		showReasoningTokens: showReasoning,
		hideReasoningTokens: hideReasoning,
		showResponseStream: Boolean(
			argv["show-stream"] || argv["show-stream-tokens"],
		),
		...(effectiveReasoningEffort !== undefined
			? { reasoning_effort: effectiveReasoningEffort }
			: {}),
	};

	if (argv["log-payload"]) {
		const payloadPath = path.join(
			String(argv.logDir ?? getLogsDirectory()),
			`indeed_${safeFileName(job)}_payload_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
		);
		await fs.mkdir(path.dirname(payloadPath), { recursive: true });
		await fs.writeFile(payloadPath, JSON.stringify(request, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await withSpinner(
				`Waiting for LLM evaluation of ${job.title} (${attempt + 1}/3)...`,
				() => llmService.call(request),
				{
					enabled: !request.showReasoningTokens && !request.showResponseStream,
				},
			);
			const results = JobAnalysisResultsSchema.parse(response.content);
			return { result: results[0], fallbackUsed: false, retries: attempt };
		} catch (error) {
			lastError = error;
			if (attempt < 2) {
				await new Promise((resolve) =>
					setTimeout(resolve, 2 ** (attempt + 1) * 1000),
				);
			}
		}
	}
	if (argv["strict-parsing"]) {
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	return {
		result: {
			jobTitle: job.title,
			isVeryHighlyAligned: false,
			isWorthInvestigating: false,
			isHighlyAligned: false,
			rationale:
				"LLM evaluation failed; recorded a conservative non-passing fallback.",
			confidence: 0,
		},
		fallbackUsed: true,
		retries: 3,
	};
}

export function addJobJudgeCommand(
	yargs: Argv<GlobalArgs>,
	jobJudgePresets: string[],
): Argv<GlobalArgs> {
	return yargs.command({
		command: "jobJudge",
		describe:
			"Evaluate Indeed job descriptions and write passing and failing results.",
		builder: (yy) =>
			(yy as Argv<JudgeCli>)
				.option("input-file", {
					type: "string",
					default: "./data/clothed_jobs_*.json",
					description:
						"Indeed job artifact, directory, or wildcard to evaluate.",
				})
				.option("preset", {
					type: "string",
					choices: jobJudgePresets,
					demandOption: true,
				})
				.option("eval-mode", { type: "number", default: 4 })
				.option("output-file", {
					type: "string",
					default: "./data/astroapply_eval_",
					description:
						"Reserved output root; results are written to astroapply_eval_{pass,fail,dupe}.",
				})
				.option("sleep", { type: "number", default: 2 })
				.option("strict-parsing", { type: "boolean", default: false })
				.option("use-jobdb", { type: "boolean", default: true })
				.option("max-tokens", { type: "number" })
				.option("log-payload", {
					type: "boolean",
					default: false,
					description:
						"Save sensitive outbound LLM payloads (owner-readable only).",
				})
				.option("show-reasoning", {
					alias: "sr",
					type: "boolean",
					default: false,
					description: "Show reasoning/thinking tokens from the LLM.",
				})
				.option("show-reasoning-tokens", {
					type: "boolean",
					default: false,
					description: "Alias for --show-reasoning",
				})
				.option("hide-reasoning", {
					alias: "hr",
					type: "boolean",
					default: false,
					description: "Hide reasoning/thinking tokens from the LLM.",
				})
				.option("hide-reasoning-tokens", {
					type: "boolean",
					default: false,
					description: "Alias for --hide-reasoning",
				})
				.option("show-stream", { type: "boolean", default: false })
				.option("show-stream-tokens", { type: "boolean", default: false })
				.option("jj-reasoning-effort", {
					type: "string",
					description:
						"Reasoning effort for jobJudge LLM requests (e.g. low, medium, high, max).",
				})
				.option("reasoning-effort", {
					type: "string",
					description: "Alias for --jj-reasoning-effort",
				})
				.check((argv) => {
					if (!Number.isFinite(argv.sleep) || argv.sleep < 0)
						throw new Error("--sleep must be zero or greater");
					if (argv["max-tokens"] !== undefined && argv["max-tokens"] <= 0)
						throw new Error("--max-tokens must be positive");
					return true;
				}),
		handler: async (rawArgv: Arguments<JudgeCli>) => {
			await runJobJudge(rawArgv as JudgeCli);
		},
	});
}

export async function runJobJudge(
	argv: JudgeCli,
): Promise<{ jobs: number; passed: number }> {
	const stats = createStatisticsCollector("jobJudge");
	stats.startCollection();
	const dataDirectory =
		argv["output-file"] && argv["output-file"] !== "./data/astroapply_eval_"
			? path.dirname(argv["output-file"])
			: getDataDirectory();
	const defaultLogDirectory = getLogsDirectory();
	let repository: JobRepository | undefined;
	let passed = 0;
	let totalJobsCount = 0;
	try {
		if (!argv.disableFileLogging) {
			initializeFileLogging(
				String(argv.logDir ?? defaultLogDirectory),
				`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_jobJudge_${String(argv.logFile ?? "astroex.log")}`,
				"JobJudge",
			);
		}
		const presets = await loadPresets();
		if (!argv.preset) throw new Error("--preset is required");
		const preset = getPreset("jobJudge", argv.preset, presets);
		if (!preset) throw new Error(`Unknown jobJudge preset: ${argv.preset}`);
		const rawReasoningEffort =
			argv["jj-reasoning-effort"] ??
			argv["reasoning-effort"] ??
			argv.reasoningEffort;
		const effectiveReasoningEffort =
			typeof rawReasoningEffort === "string" &&
			rawReasoningEffort.trim().length > 0
				? rawReasoningEffort.trim()
				: undefined;

		logger.info(`Starting JobJudge evaluation with ${preset.name}`, {
			preset: preset.name,
			...(effectiveReasoningEffort
				? { reasoning_effort: effectiveReasoningEffort }
				: {}),
		});
		llmService.initialize(
			[
				{
					name: preset.provider,
					baseUrl: preset.base_url,
					apiKey: argv["api-key"] || process.env.OPENAI_API_KEY || "",
					model: preset.modelId,
				},
			],
			preset.provider,
		);
		repository = new JobRepository({
			dbFilePath: path.join(dataDirectory, "jobDB.sqlite"),
			legacyJsonPath: path.join(dataDirectory, "jobDB.json"),
			defaultExpirationMs: JOB_DB_RETENTION_MS,
			enableJobDB: argv["use-jobdb"],
		});
		await repository.initialize();
		await repository.load();
		stats.incrementCounter(
			"jobDB.expiredEntriesRemoved",
			await repository.cleanupExpired(),
		);

		const [passDir, failDir, dupeDir] = [
			path.join(dataDirectory, "astroapply_eval_pass"),
			path.join(dataDirectory, "astroapply_eval_fail"),
			path.join(dataDirectory, "astroapply_eval_dupe"),
		];
		await Promise.all(
			[passDir, failDir, dupeDir].map((directory) =>
				fs.mkdir(directory, { recursive: true }),
			),
		);
		const files = await findJobFiles(argv["input-file"]);
		if (files.length === 0)
			throw new Error(`No files matched ${argv["input-file"]}`);

		const appData = await loadApplicationData();
		const veritasSystemPrompt = await loadVeritasSystemPrompt();

		for (const file of files) {
			let fileHash = "";
			try {
				fileHash = await computeFileHash(file);
			} catch {
				fileHash = "";
			}
			const checkpoint = fileHash
				? await checkStageCheckpoint(
						"jobJudge",
						file,
						passDir,
						preset.name,
						preset.modelId,
						repository,
					)
				: {
						hasMatchingWork: false,
						isCompleted: false,
						inputHash: "",
						processedJobIds: new Set<string>(),
					};

			if (checkpoint.isCompleted) {
				log(
					"JobJudge",
					`Durable checkpoint match: jobJudge already completed for ${file} with preset ${preset.name}. Skipping evaluation.`,
					"info",
				);
				continue;
			}

			const parsed = parseJobFile(await fs.readFile(file, "utf8"), file);
			stats.incrementCounter("files.read", 1);
			const fileJobs: JobInterface[] = [];
			for (const job of parsed) {
				if (isIndeedJob(job)) fileJobs.push(job);
				else
					log("JobJudge", "Skipped retired non-Indeed artifact", "warn", {
						file,
						id: job.id,
					});
			}
			totalJobsCount += fileJobs.length;
			stats.incrementCounter("data.recordsProcessed", fileJobs.length);

			if (fileHash) {
				await initStageCheckpoint(
					"jobJudge",
					file,
					fileHash,
					passDir,
					preset.name,
					preset.modelId,
					fileJobs.length,
					Array.from(checkpoint.processedJobIds),
					repository,
				);
			}

			for (const job of fileJobs) {
				if (checkpoint.processedJobIds.has(job.id)) {
					log(
						"JobJudge",
						"Skipping already-judged job from checkpoint",
						"debug",
						{ id: job.id },
					);
					continue;
				}
				const identity = {
					id: job.id,
					source: "indeed" as const,
					sourceJobId: job.sourceJobId,
					title: job.title,
					company: job.company,
					url: job.url,
				};
				const fileName = `${safeFileName(job)}.json`;
				if (repository.isJobMatched(identity)) {
					await fs.writeFile(
						path.join(dupeDir, fileName),
						JSON.stringify(
							{ ...job, evaluationResult: { duplicate: true } },
							null,
							2,
						),
						{ encoding: "utf8", mode: 0o600 },
					);
					stats.incrementCounter("data.duplicatesRemoved", 1);
					if (fileHash) {
						repository.recordJobInCheckpoint(
							"jobJudge",
							fileHash,
							preset.name,
							preset.modelId,
							job.id,
						);
					}
					continue;
				}
				if (!job.descriptionText?.trim()) {
					log("JobJudge", "Skipped Indeed job without a description", "warn", {
						id: job.id,
					});
					stats.incrementCounter("data.recordsFiltered", 1);
					if (fileHash) {
						repository.recordJobInCheckpoint(
							"jobJudge",
							fileHash,
							preset.name,
							preset.modelId,
							job.id,
						);
					}
					continue;
				}
				const started = performance.now();
				stats.incrementCounter("api.totalCalls", 1);
				const outcome = await evaluate(
					job,
					preset,
					argv,
					appData,
					veritasSystemPrompt,
				);
				stats.incrementCounter("api.successfulCalls", 1);
				stats.recordHistogram("api.responseTime", performance.now() - started);
				const output = {
					...job,
					evaluationResult: {
						mode: argv["eval-mode"],
						isPass: outcome.result.isVeryHighlyAligned,
						timestamp: new Date().toISOString(),
						fallbackUsed: outcome.fallbackUsed,
						analysisResult: outcome.result,
						retryCount: outcome.retries,
					},
				};
				const targetDir = outcome.result.isVeryHighlyAligned
					? passDir
					: failDir;
				await fs.writeFile(
					path.join(targetDir, fileName),
					JSON.stringify(output, null, 2),
					{ encoding: "utf8", mode: 0o600 },
				);
				await writeArtifactManifest(
					path.join(targetDir, fileName),
					"jobJudge",
					{
						preset: preset.name,
						model: preset.modelId,
						evaluationMode: argv["eval-mode"],
						passed: outcome.result.isVeryHighlyAligned,
						retries: outcome.retries,
					},
				);
				await repository.addJob(identity);
				if (fileHash) {
					repository.recordJobInCheckpoint(
						"jobJudge",
						fileHash,
						preset.name,
						preset.modelId,
						job.id,
					);
				}
				stats.incrementCounter("files.written", 1);
				if (outcome.result.isVeryHighlyAligned) passed++;
				if (argv.sleep > 0)
					await new Promise((resolve) =>
						setTimeout(resolve, argv.sleep * 1000),
					);
			}

			if (fileHash) {
				repository.completeStageCheckpoint(
					"jobJudge",
					fileHash,
					preset.name,
					preset.modelId,
					"completed",
					fileJobs.length,
				);
			}
		}
		stats.recordSuccess("jobJudge.complete", { jobs: totalJobsCount, passed });
		await fs.mkdir(path.join(dataDirectory, "statistics"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(
				dataDirectory,
				"statistics",
				`jobJudge_stats_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
			),
			stats.export("json"),
			{ encoding: "utf8", mode: 0o600 },
		);
		logger.success(
			`Evaluated ${totalJobsCount} Indeed jobs; ${passed} passed.`,
			{
				evaluatedCount: totalJobsCount,
				passedCount: passed,
			},
		);
	} finally {
		if (repository) await repository.close();
		stats.endCollection();
		await closeFileLogging();
	}
	return { jobs: totalJobsCount, passed };
}
