import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { isCanonicalAcquiredJob, toLegacyJob } from "../acquisition/normalize";
import { writeArtifactManifest } from "../artifactManifest";
import {
	DEFAULT_JOBCLOTH_COOL_OFF_DAYS,
	MILLISECONDS_PER_DAY,
} from "../constants";
import { type JobRepository, createJobClothMatchKey } from "../jobRepository";
import type { JobInterface } from "../models";
import { abortableDelay, throwIfCancelled } from "../pipelineCancellation";
import { getLogsDirectory, getProfileDirectory } from "../runtimePaths";
import { getSharedJobRepository } from "../stageCheckpoint";
import {
	type StatisticsCollector,
	createStatisticsCollector,
} from "../statistics";
import type { GlobalArgs } from "../types";
import { createLogger, formatDuration, log } from "../utils";
import { createProgressReporter } from "../utils/progress";

const logger = createLogger("ProcessData");

export interface ProcessDataOptions {
	inputDirectory?: string;
	inputFiles?: string[];
	outputFile: string;
	companyFilters?: string[];
	titleFilters?: string[];
	remoteOnly?: boolean;
	batchSize?: number;
	sleepMinMs?: number;
	sleepMaxMs?: number;
	jobClothCoolOffDays?: number;
	logCoolOffs?: boolean;
	coolOffLogDirectory?: string;
	jobRepository?: JobRepository;
	jobRepositoryFactory?: () => Promise<JobRepository>;
	signal?: AbortSignal;
}

export interface ProcessDataResult {
	filesProcessed: number;
	recordsMerged: number;
	duplicatesRemoved: number;
	filteredEntries: number;
	remoteFilteredEntries: number;
	retiredOrInvalidEntries: number;
	jobDbCoolOffSkippedEntries: number;
	outputRecordCount: number;
	coolOffLogFile?: string;
}

export interface CoolOffSuppressionRecord {
	id: string;
	company: string;
	title: string;
}

export interface CoolOffSuppressionReport {
	generatedAt: string;
	coolOffDays: number;
	count: number;
	jobs: CoolOffSuppressionRecord[];
}

const DEFAULT_BATCH_SIZE = 1_000;

function normalizeFilter(values: string[]): string[] {
	return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function isPipelineUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host.endsWith("indeed.com") || host.endsWith("linkedin.com");
	} catch {
		return false;
	}
}

/**
 * Accept legacy job shapes only when their URL unambiguously belongs to
 * a supported source (Indeed or LinkedIn). This preserves existing artifacts
 * without allowing retired source artifacts through the compatibility path.
 */
function isLegacyPipelineJob(value: unknown): value is JobInterface {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<JobInterface>;
	return (
		typeof job.id === "string" &&
		typeof job.title === "string" &&
		job.title.trim().length > 0 &&
		typeof job.company === "string" &&
		job.company.trim().length > 0 &&
		isPipelineUrl(job.url)
	);
}

function normalizePipelineJob(value: unknown): JobInterface | undefined {
	if (isCanonicalAcquiredJob(value)) return toLegacyJob(value);
	if (!isLegacyPipelineJob(value)) return undefined;
	let source: "indeed" | "linkedin" = "indeed";
	if (
		value.source === "linkedin" ||
		(typeof value.url === "string" && value.url.includes("linkedin.com"))
	) {
		source = "linkedin";
	}
	return { ...value, source };
}

async function loadDefaultFilters(): Promise<{
	companyFilters: string[];
	titleFilters: string[];
}> {
	const filterDirectory = getProfileDirectory();
	const [companyContent, titleContent] = await Promise.all([
		fs
			.readFile(path.join(filterDirectory, "company_filters.txt"), "utf8")
			.catch(() => ""),
		fs
			.readFile(path.join(filterDirectory, "title_filters.txt"), "utf8")
			.catch(() => ""),
	]);
	return {
		companyFilters: normalizeFilter(companyContent.split(/\r?\n/)),
		titleFilters: normalizeFilter(titleContent.split(/\r?\n/)),
	};
}

async function writeJsonAtomically(
	outputFile: string,
	value: unknown,
): Promise<void> {
	const outputDirectory = path.dirname(outputFile);
	await fs.mkdir(outputDirectory, { recursive: true });
	const temporaryFile = path.join(
		outputDirectory,
		`.${path.basename(outputFile)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		await fs.writeFile(temporaryFile, JSON.stringify(value, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(temporaryFile, outputFile);
	} catch (error) {
		await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

function timestampForFile(date: Date): string {
	return date.toISOString().replace(/[-:.]/g, "");
}

async function writeCoolOffSuppressionLog(
	jobs: CoolOffSuppressionRecord[],
	coolOffDays: number,
	logDirectory = getLogsDirectory(),
): Promise<string> {
	const generatedAt = new Date();
	const resolvedDirectory = path.resolve(logDirectory);
	await fs.mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
	const fileName = [
		"processData_cool_off_suppressions",
		timestampForFile(generatedAt),
		`p${process.pid}`,
		crypto.randomUUID(),
	].join("_");
	const filePath = path.join(resolvedDirectory, `${fileName}.json`);
	const report: CoolOffSuppressionReport = {
		generatedAt: generatedAt.toISOString(),
		coolOffDays,
		count: jobs.length,
		jobs,
	};
	await writeJsonAtomically(filePath, report);
	return filePath;
}

function isFiltered(
	job: JobInterface,
	companyFilters: string[],
	titleFilters: string[],
): boolean {
	const company = job.company.toLowerCase();
	const title = job.title.toLowerCase();
	return (
		companyFilters.some((filter) => company.includes(filter)) ||
		titleFilters.some((filter) => title.includes(filter))
	);
}

function deduplicationKey(job: JobInterface): string {
	return createJobClothMatchKey(job) as string;
}

function coolOffDaysToMilliseconds(days: number): number {
	const milliseconds = days * MILLISECONDS_PER_DAY;
	if (
		!Number.isSafeInteger(days) ||
		days <= 0 ||
		!Number.isSafeInteger(milliseconds)
	) {
		throw new Error("jobClothCoolOffDays must be a positive safe integer");
	}
	return milliseconds;
}

/**
 * Normalize, deduplicate, and filter canonical or historical acquisition artifacts.
 * JSON-array output is deliberately retained for downstream compatibility.
 */
export async function processAcquiredJobs(
	options: ProcessDataOptions,
	stats?: StatisticsCollector,
): Promise<ProcessDataResult> {
	const startedAt = performance.now();
	throwIfCancelled(options.signal);
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	if (!Number.isInteger(batchSize) || batchSize <= 0)
		throw new Error("batchSize must be a positive integer");
	const sleepMinMs = options.sleepMinMs ?? 0;
	const sleepMaxMs = options.sleepMaxMs ?? sleepMinMs;
	if (sleepMinMs < 0 || sleepMaxMs < sleepMinMs)
		throw new Error("sleep limits must be non-negative and ordered");
	const jobClothCoolOffDays =
		options.jobClothCoolOffDays ?? DEFAULT_JOBCLOTH_COOL_OFF_DAYS;
	const jobClothCoolOffMs = coolOffDaysToMilliseconds(jobClothCoolOffDays);

	const defaults = await loadDefaultFilters();
	const companyFilters = normalizeFilter([
		...defaults.companyFilters,
		...(options.companyFilters ?? []),
	]);
	const titleFilters = normalizeFilter([
		...defaults.titleFilters,
		...(options.titleFilters ?? []),
	]);
	const outputFile = path.resolve(options.outputFile);
	const discoveredFiles = new Set<string>();

	if (options.inputFiles && options.inputFiles.length > 0) {
		for (const file of options.inputFiles) {
			if (file && path.resolve(file) !== outputFile) {
				discoveredFiles.add(path.resolve(file));
			}
		}
	}

	if (options.inputDirectory) {
		const entries = await fs.readdir(options.inputDirectory, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (
				entry.isFile() &&
				entry.name.startsWith("acquired_jobs_") &&
				entry.name.endsWith(".json")
			) {
				const resolved = path.resolve(
					path.join(options.inputDirectory, entry.name),
				);
				if (resolved !== outputFile) {
					discoveredFiles.add(resolved);
				}
			}
		}
	}

	const inputFiles = Array.from(discoveredFiles).sort();

	const result: ProcessDataResult = {
		filesProcessed: 0,
		recordsMerged: 0,
		duplicatesRemoved: 0,
		filteredEntries: 0,
		remoteFilteredEntries: 0,
		retiredOrInvalidEntries: 0,
		jobDbCoolOffSkippedEntries: 0,
		outputRecordCount: 0,
	};
	const jobIndexById = new Map<string, number>();
	const jobIndexByTitleCompany = new Map<string, number>();
	const output: JobInterface[] = [];

	for (const inputFile of inputFiles) {
		throwIfCancelled(options.signal);
		let values: unknown;
		try {
			values = JSON.parse(await fs.readFile(inputFile, "utf8"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stats?.recordWarning("Unreadable acquisition artifact", {
				inputFile,
				message,
			});
			log(
				"ProcessData",
				`Skipping unreadable artifact ${inputFile}: ${message}`,
				"warn",
			);
			continue;
		}
		if (!Array.isArray(values)) {
			stats?.recordWarning("Acquisition artifact is not a JSON array", {
				inputFile,
			});
			log("ProcessData", `Skipping non-array artifact ${inputFile}`, "warn");
			continue;
		}

		result.filesProcessed++;
		result.recordsMerged += values.length;
		const recordProgress = createProgressReporter(logger, {
			label: "Stage 2/8: ProcessData",
			unitLabel: "record",
			totalUnits: values.length,
			phase: `progress for ${path.basename(inputFile)}`,
		});
		recordProgress.start({ inputFile });
		for (const value of values) {
			throwIfCancelled(options.signal);
			const job = normalizePipelineJob(value);
			if (!job) {
				result.retiredOrInvalidEntries++;
				recordProgress.complete({ outcome: "invalid" });
				continue;
			}
			if (options.remoteOnly && job.remoteOk !== true) {
				result.filteredEntries++;
				result.remoteFilteredEntries++;
				recordProgress.complete({
					jobId: job.id,
					outcome: "remote-filtered",
				});
				continue;
			}
			const titleCompany = deduplicationKey(job);
			if (jobIndexById.has(job.id)) {
				result.duplicatesRemoved++;
				recordProgress.complete({ jobId: job.id, outcome: "duplicate" });
				continue;
			}
			const existingIndex = jobIndexByTitleCompany.get(titleCompany);
			if (existingIndex !== undefined) {
				result.duplicatesRemoved++;
				const existingJob = output[existingIndex];
				// Preserve Indeed's full description on duplicate detection
				if (
					(!existingJob.descriptionText && job.descriptionText) ||
					(existingJob.source === "linkedin" && job.source === "indeed")
				) {
					jobIndexById.delete(existingJob.id);
					output[existingIndex] = job;
					jobIndexById.set(job.id, existingIndex);
				}
				recordProgress.complete({ jobId: job.id, outcome: "duplicate" });
				continue;
			}
			if (isFiltered(job, companyFilters, titleFilters)) {
				result.filteredEntries++;
				recordProgress.complete({ jobId: job.id, outcome: "filtered" });
				continue;
			}
			const newIndex = output.length;
			jobIndexById.set(job.id, newIndex);
			jobIndexByTitleCompany.set(titleCompany, newIndex);
			output.push(job);
			if (output.length % batchSize === 0) {
				log(
					"ProcessData",
					`Accepted ${output.length} pipeline jobs so far`,
					"info",
				);
				if (sleepMaxMs > 0) {
					const delay = sleepMinMs + Math.random() * (sleepMaxMs - sleepMinMs);
					await abortableDelay(delay, options.signal);
				}
			}
			recordProgress.complete({ jobId: job.id, outcome: "accepted" });
		}
	}

	const recentJobClothKeys =
		output.length === 0
			? new Set<string>()
			: (
					options.jobRepository ??
					(await (options.jobRepositoryFactory?.() ?? getSharedJobRepository()))
				).getRecentJobClothProcessingKeys(output, jobClothCoolOffMs);
	const coolOffSuppressedJobs: CoolOffSuppressionRecord[] | undefined =
		options.logCoolOffs ? [] : undefined;
	const filteredOutput = output.filter((job) => {
		const key = createJobClothMatchKey(job);
		const isSuppressed = Boolean(key && recentJobClothKeys.has(key));
		if (isSuppressed) {
			coolOffSuppressedJobs?.push({
				id: job.id,
				company: job.company,
				title: job.title,
			});
		}
		return !isSuppressed;
	});
	result.jobDbCoolOffSkippedEntries = output.length - filteredOutput.length;
	result.filteredEntries += result.jobDbCoolOffSkippedEntries;
	result.outputRecordCount = filteredOutput.length;
	logger.info("Applied jobCloth JobDB cool-off filter", {
		jobClothCoolOffDays,
		candidateJobs: output.length,
		jobDbCoolOffSkippedEntries: result.jobDbCoolOffSkippedEntries,
		outputRecordCount: result.outputRecordCount,
	});
	const writeTimer = stats?.startTimer("file.write");
	await writeJsonAtomically(outputFile, filteredOutput);
	if (coolOffSuppressedJobs) {
		const coolOffLogFile = await writeCoolOffSuppressionLog(
			coolOffSuppressedJobs,
			jobClothCoolOffDays,
			options.coolOffLogDirectory,
		);
		result.coolOffLogFile = coolOffLogFile;
		logger.success(
			`Wrote ${coolOffSuppressedJobs.length} cool-off suppression record${coolOffSuppressedJobs.length === 1 ? "" : "s"} to ${coolOffLogFile}`,
			{
				outputFile: coolOffLogFile,
				records: coolOffSuppressedJobs.length,
				jobClothCoolOffDays,
			},
		);
	}
	await writeArtifactManifest(outputFile, "processData", {
		inputFiles: inputFiles.map((file) => path.basename(file)),
		result,
	});
	if (writeTimer) stats?.endTimer(writeTimer);
	stats?.incrementCounter("files.found", inputFiles.length);
	stats?.incrementCounter("files.processed", result.filesProcessed);
	stats?.incrementCounter("files.written", 1);
	if (result.coolOffLogFile) stats?.incrementCounter("files.written", 1);
	stats?.incrementCounter("data.recordsProcessed", result.recordsMerged);
	stats?.incrementCounter("data.recordsFiltered", result.filteredEntries);
	stats?.incrementCounter(
		"data.jobDbCoolOffSkipped",
		result.jobDbCoolOffSkippedEntries,
	);
	stats?.incrementCounter("data.duplicatesRemoved", result.duplicatesRemoved);
	stats?.incrementCounter(
		"data.retiredOrInvalid",
		result.retiredOrInvalidEntries,
	);
	stats?.recordSuccess("processData.complete", result);
	logger.success("Processed acquisition artifacts", {
		...result,
		duration: formatDuration(performance.now() - startedAt),
	});
	return result;
}

export const addProcessDataCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> =>
	yargs.command({
		command: "processData",
		describe: "Process canonical and historical acquisition artifacts.",
		builder: (yy) =>
			(yy as Argv<GlobalArgs & ProcessDataCli>)
				.option("input-dir", {
					alias: "i",
					type: "string",
					default: "./data",
					description: "Directory containing acquired_jobs_*.json artifacts.",
				})
				.option("input-files", {
					type: "string",
					description:
						"Comma-separated list of acquisition artifact JSON files (e.g. acquired_jobs_indeed.json,acquired_jobs_linkedin.json).",
				})
				.option("output-file", {
					alias: "o",
					type: "string",
					default: "./data/processed_jobs.json",
					description: "Output JSON file; replaced atomically on success.",
				})
				.option("company-filters", {
					type: "string",
					default: "",
					description: "Comma-separated company names to exclude.",
				})
				.option("title-filters", {
					type: "string",
					default: "",
					description: "Comma-separated title terms to exclude.",
				})
				.option("remote-only", {
					type: "boolean",
					default: false,
					description:
						"Retain only jobs whose canonical isRemote or legacy remoteOk value is explicitly true.",
				})
				.option("jobcloth-cool-off-days", {
					type: "number",
					default: DEFAULT_JOBCLOTH_COOL_OFF_DAYS,
					description:
						"Skip jobs processed by jobCloth within this many 24-hour days.",
				})
				.option("batch-size", {
					alias: "b",
					type: "number",
					default: DEFAULT_BATCH_SIZE,
					description: "Progress-reporting interval.",
				})
				.option("sleep-min", {
					alias: "smin",
					type: "number",
					default: 0,
					description: "Minimum yield delay between batches, in seconds.",
				})
				.option("sleep-max", {
					alias: "smax",
					type: "number",
					default: 0,
					description: "Maximum yield delay between batches, in seconds.",
				})
				.check((argv) => {
					if (typeof argv["input-dir"] !== "string")
						throw new Error("input-dir must be a string");
					if (typeof argv["output-file"] !== "string")
						throw new Error("output-file must be a string");
					if (!Number.isInteger(argv["batch-size"]) || argv["batch-size"] <= 0)
						throw new Error("batch-size must be a positive integer");
					coolOffDaysToMilliseconds(argv["jobcloth-cool-off-days"]);
					if (argv["sleep-min"] < 0 || argv["sleep-max"] < argv["sleep-min"])
						throw new Error(
							"sleep-max must be greater than or equal to sleep-min",
						);
					return true;
				}) as Argv<GlobalArgs & ProcessDataCli>,
		handler: async (argv: Arguments<GlobalArgs & ProcessDataCli>) => {
			const stats = createStatisticsCollector("processData");
			stats.startCollection();
			try {
				await processAcquiredJobs(
					{
						inputDirectory: argv["input-dir"],
						inputFiles: argv["input-files"]
							? argv["input-files"]
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean)
							: undefined,
						outputFile: argv["output-file"],
						companyFilters: argv["company-filters"].split(","),
						titleFilters: argv["title-filters"].split(","),
						remoteOnly: argv["remote-only"],
						jobClothCoolOffDays: argv["jobcloth-cool-off-days"],
						batchSize: argv["batch-size"],
						sleepMinMs: argv["sleep-min"] * 1_000,
						sleepMaxMs: argv["sleep-max"] * 1_000,
					},
					stats,
				);
			} catch (error) {
				const failure =
					error instanceof Error ? error : new Error(String(error));
				stats.recordError(failure);
				process.exitCode = 1;
				log("ProcessData", `Processing failed: ${failure.message}`, "error");
			} finally {
				log("ProcessData", "Final statistics", "info", {
					summary: stats.endCollection(),
				});
			}
		},
	});

type ProcessDataCli = GlobalArgs & {
	"input-dir": string;
	"input-files"?: string;
	"output-file": string;
	"company-filters": string;
	"title-filters": string;
	"remote-only": boolean;
	"jobcloth-cool-off-days": number;
	"batch-size": number;
	"sleep-min": number;
	"sleep-max": number;
};
