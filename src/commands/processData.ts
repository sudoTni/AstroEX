import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { isCanonicalAcquiredJob, toLegacyJob } from "../acquisition/normalize";
import { writeArtifactManifest } from "../artifactManifest";
import type { JobInterface } from "../models";
import { getProfileDirectory } from "../runtimePaths";
import {
	type StatisticsCollector,
	createStatisticsCollector,
} from "../statistics";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	createLogger,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";

const logger = createLogger("ProcessData");

export interface ProcessDataOptions {
	inputDirectory: string;
	outputFile: string;
	companyFilters?: string[];
	titleFilters?: string[];
	batchSize?: number;
	sleepMinMs?: number;
	sleepMaxMs?: number;
}

export interface ProcessDataResult {
	filesProcessed: number;
	recordsMerged: number;
	duplicatesRemoved: number;
	filteredEntries: number;
	retiredOrInvalidEntries: number;
	outputRecordCount: number;
}

const DEFAULT_BATCH_SIZE = 1_000;

function normalizeFilter(values: string[]): string[] {
	return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function isIndeedUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).hostname.toLowerCase().endsWith("indeed.com");
	} catch {
		return false;
	}
}

/**
 * Accept the old AstroEX job shape only when its URL unambiguously belongs to
 * Indeed. This preserves existing Indeed artifacts without allowing retired
 * source artifacts through the compatibility path.
 */
function isLegacyIndeedJob(value: unknown): value is JobInterface {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<JobInterface>;
	return (
		typeof job.id === "string" &&
		typeof job.title === "string" &&
		job.title.trim().length > 0 &&
		typeof job.company === "string" &&
		job.company.trim().length > 0 &&
		isIndeedUrl(job.url)
	);
}

function normalizeIndeedJob(value: unknown): JobInterface | undefined {
	if (isCanonicalAcquiredJob(value)) return toLegacyJob(value);
	if (!isLegacyIndeedJob(value)) return undefined;
	return { ...value, source: "indeed" };
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
	return `${job.title.toLowerCase().trim()}\u0000${job.company.toLowerCase().trim()}`;
}

/**
 * Normalize, deduplicate, and filter canonical or historical Indeed artifacts.
 * JSON-array output is deliberately retained for downstream compatibility.
 */
export async function processAcquiredJobs(
	options: ProcessDataOptions,
	stats?: StatisticsCollector,
): Promise<ProcessDataResult> {
	const startedAt = performance.now();
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	if (!Number.isInteger(batchSize) || batchSize <= 0)
		throw new Error("batchSize must be a positive integer");
	const sleepMinMs = options.sleepMinMs ?? 0;
	const sleepMaxMs = options.sleepMaxMs ?? sleepMinMs;
	if (sleepMinMs < 0 || sleepMaxMs < sleepMinMs)
		throw new Error("sleep limits must be non-negative and ordered");

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
	const entries = await fs.readdir(options.inputDirectory, {
		withFileTypes: true,
	});
	const inputFiles = entries
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith("acquired_jobs_") &&
				entry.name.endsWith(".json"),
		)
		.map((entry) => path.join(options.inputDirectory, entry.name))
		.filter((file) => path.resolve(file) !== outputFile)
		.sort();

	const result: ProcessDataResult = {
		filesProcessed: 0,
		recordsMerged: 0,
		duplicatesRemoved: 0,
		filteredEntries: 0,
		retiredOrInvalidEntries: 0,
		outputRecordCount: 0,
	};
	const seenIds = new Set<string>();
	const seenTitleCompanies = new Set<string>();
	const output: JobInterface[] = [];

	for (const inputFile of inputFiles) {
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
		for (const value of values) {
			const job = normalizeIndeedJob(value);
			if (!job) {
				result.retiredOrInvalidEntries++;
				continue;
			}
			const titleCompany = deduplicationKey(job);
			if (seenIds.has(job.id) || seenTitleCompanies.has(titleCompany)) {
				result.duplicatesRemoved++;
				continue;
			}
			if (isFiltered(job, companyFilters, titleFilters)) {
				result.filteredEntries++;
				continue;
			}
			seenIds.add(job.id);
			seenTitleCompanies.add(titleCompany);
			output.push(job);
			if (output.length % batchSize === 0) {
				log(
					"ProcessData",
					`Accepted ${output.length} Indeed jobs so far`,
					"info",
				);
				if (sleepMaxMs > 0) {
					const delay = sleepMinMs + Math.random() * (sleepMaxMs - sleepMinMs);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
	}

	result.outputRecordCount = output.length;
	const writeTimer = stats?.startTimer("file.write");
	await writeJsonAtomically(outputFile, output);
	await writeArtifactManifest(outputFile, "processData", {
		inputFiles: inputFiles.map((file) => path.basename(file)),
		result,
	});
	if (writeTimer) stats?.endTimer(writeTimer);
	stats?.incrementCounter("files.found", inputFiles.length);
	stats?.incrementCounter("files.processed", result.filesProcessed);
	stats?.incrementCounter("files.written", 1);
	stats?.incrementCounter("data.recordsProcessed", result.recordsMerged);
	stats?.incrementCounter("data.recordsFiltered", result.filteredEntries);
	stats?.incrementCounter("data.duplicatesRemoved", result.duplicatesRemoved);
	stats?.incrementCounter(
		"data.retiredOrInvalid",
		result.retiredOrInvalidEntries,
	);
	stats?.recordSuccess("processData.complete", result);
	logger.success("Processed Indeed acquisition artifacts", {
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
		describe: "Process canonical and historical Indeed acquisition artifacts.",
		builder: (yy) =>
			(yy as Argv<GlobalArgs & ProcessDataCli>)
				.option("input-dir", {
					alias: "i",
					type: "string",
					default: "./data",
					description: "Directory containing acquired_jobs_*.json artifacts.",
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
					if (argv["sleep-min"] < 0 || argv["sleep-max"] < argv["sleep-min"])
						throw new Error(
							"sleep-max must be greater than or equal to sleep-min",
						);
					return true;
				}) as Argv<GlobalArgs & ProcessDataCli>,
		handler: async (argv: Arguments<GlobalArgs & ProcessDataCli>) => {
			const stats = createStatisticsCollector("processData");
			stats.startCollection();
			if (!argv.disableFileLogging) {
				initializeFileLogging(
					argv.logDir ?? "./logs",
					`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_ProcessData_${argv.logFile ?? "astroex.log"}`,
					"ProcessData",
				);
			}
			try {
				await processAcquiredJobs(
					{
						inputDirectory: argv["input-dir"],
						outputFile: argv["output-file"],
						companyFilters: argv["company-filters"].split(","),
						titleFilters: argv["title-filters"].split(","),
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
				await closeFileLogging();
			}
		},
	});

type ProcessDataCli = GlobalArgs & {
	"input-dir": string;
	"output-file": string;
	"company-filters": string;
	"title-filters": string;
	"batch-size": number;
	"sleep-min": number;
	"sleep-max": number;
};
