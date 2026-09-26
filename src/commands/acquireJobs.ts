import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { IndeedProvider } from "../acquisition/jobspyProvider";
import { isCanonicalAcquiredJob, toLegacyJob } from "../acquisition/normalize";
import type {
	AcquisitionFailure,
	AcquisitionSource,
	CanonicalAcquiredJob,
} from "../acquisition/types";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository } from "../jobRepository";
import { abortableDelay, throwIfCancelled } from "../pipelineCancellation";
import { getDataDirectory, getProfileFile } from "../runtimePaths";
import { createStatisticsCollector } from "../statistics";
import type { GlobalArgs } from "../types";
import { createLogger, formatDuration, log } from "../utils";
import { createProgressReporter } from "../utils/progress";

const logger = createLogger("AcquireJobs");

const defaultSearchTermsFile = getProfileFile("search_terms.txt");

export type AcquireJobsCli = GlobalArgs & {
	sites: string;
	"job-provider"?: string;
	jobProvider?: string;
	"search-terms": string;
	"search-terms-file": string;
	locations: string;
	"results-wanted": number;
	distance: number;
	"hours-old"?: number;
	remote?: boolean;
	"remote-only"?: boolean;
	remoteOnly?: boolean;
	"job-type"?: string;
	"easy-apply": boolean;
	"indeed-country": string;
	"description-mode": string;
	"description-format": string;
	proxies: string;
	"user-agent"?: string;
	"output-file": string;
	"output-file-indeed"?: string;
	"output-file-linkedin"?: string;
	outputFilesBySource?: Partial<Record<AcquisitionSource, string>>;
	"use-jobdb": boolean;
	"show-fetch-url"?: boolean;
	showFetchUrl?: boolean;
	signal?: AbortSignal;
};

export function resolveOutputFiles(
	dataDirectory: string,
	sources: AcquisitionSource[],
	rawOutputFile?: string,
	outputFilesBySource?: Partial<Record<AcquisitionSource, string>>,
	outputFileIndeed?: string,
	outputFileLinkedIn?: string,
): Record<AcquisitionSource, string> {
	const defaultIndeed = path.join(dataDirectory, "acquired_jobs_indeed.json");
	const defaultLinkedIn = path.join(
		dataDirectory,
		"acquired_jobs_linkedin.json",
	);
	const result: Record<AcquisitionSource, string> = {
		indeed: outputFilesBySource?.indeed || outputFileIndeed || defaultIndeed,
		linkedin:
			outputFilesBySource?.linkedin || outputFileLinkedIn || defaultLinkedIn,
	};
	if (rawOutputFile) {
		if (sources.length === 1) {
			result[sources[0]] = rawOutputFile;
		} else {
			const base = path.basename(rawOutputFile);
			if (base.includes("indeed") || base === "acquired_jobs_indeed.json") {
				result.indeed = rawOutputFile;
			} else if (
				base.includes("linkedin") ||
				base === "acquired_jobs_linkedin.json"
			) {
				result.linkedin = rawOutputFile;
			}
		}
	}
	return result;
}

export function parseAcquisitionSources(value: string): AcquisitionSource[] {
	const sources = value
		.split(",")
		.map((source) => source.trim().toLowerCase())
		.filter(Boolean);
	if (sources.length === 0) {
		throw new Error(
			"--sites must include at least one supported source (indeed, linkedin)",
		);
	}
	const supportedSources = new Set<string>(["indeed", "linkedin"]);
	const invalid = sources.filter((source) => !supportedSources.has(source));
	if (invalid.length > 0) {
		throw new Error(
			`Unsupported acquisition site(s): ${invalid.join(", ")}. Supported sources: indeed, linkedin.`,
		);
	}
	return [...new Set(sources)] as AcquisitionSource[];
}

function parseList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

async function loadSearchTerms(
	inlineTerms: string,
	filePath: string,
): Promise<string[]> {
	const supplied = parseList(inlineTerms);
	if (supplied.length > 0) return supplied;
	const contents = await fs.readFile(filePath, "utf-8");
	return contents
		.split(/\r?\n/)
		.map((term) => term.trim())
		.filter((term) => term.length > 0 && !term.startsWith("#"));
}

function deduplicateJobs(jobs: CanonicalAcquiredJob[]): CanonicalAcquiredJob[] {
	const ids = new Set<string>();
	return jobs.filter((job) => {
		if (ids.has(job.id)) return false;
		ids.add(job.id);
		return true;
	});
}

/**
 * Retains only jobs where `isRemote` is strictly `true`.
 *
 * Jobs with `isRemote === false`, `undefined`, `null`, or missing properties
 * are treated as non-remote and excluded from the acquired dataset when
 * remote-only filtering is active.
 */
export function filterRemoteOnlyJobs(
	jobs: CanonicalAcquiredJob[],
): CanonicalAcquiredJob[] {
	return jobs.filter((job) => job.isRemote === true);
}

/** Resolve an explicitly supplied CLI value before falling back to the environment. */
export function resolveRemoteOnlyOption(
	kebabValue?: boolean,
	camelValue?: boolean,
	environmentValue = process.env.ASTROEX_REMOTE_ONLY,
): boolean {
	if (kebabValue !== undefined) return kebabValue;
	if (camelValue !== undefined) return camelValue;
	return environmentValue === "1";
}

export async function loadAcquisitionCheckpoint(
	outputFile: string,
): Promise<CanonicalAcquiredJob[]> {
	try {
		const content = await fs.readFile(outputFile, "utf-8");
		const parsed: unknown = JSON.parse(content);
		if (!Array.isArray(parsed)) {
			throw new Error("expected a JSON array");
		}
		const canonicalJobs = parsed.filter(isCanonicalAcquiredJob);
		if (canonicalJobs.length !== parsed.length) {
			log(
				"AcquireJobs",
				"Ignored noncanonical or retired-source entries in acquisition checkpoint.",
				"warn",
				{ outputFile, ignoredEntries: parsed.length - canonicalJobs.length },
			);
		}
		return deduplicateJobs(canonicalJobs);
	} catch (error: unknown) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw new Error(
			`Unable to resume acquisition output ${outputFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function writeAcquisitionCheckpoint(
	outputFile: string,
	jobs: CanonicalAcquiredJob[],
): Promise<void> {
	await fs.mkdir(path.dirname(outputFile), { recursive: true });
	const tempFile = `${outputFile}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.writeFile(tempFile, JSON.stringify(jobs, null, 2), "utf-8");
		await fs.rename(tempFile, outputFile);
	} catch (error) {
		try {
			await fs.unlink(tempFile);
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
}

/** Apply a bounded source-specific pause after a retryable provider failure. */
export function getProviderCooldownMs(
	failure: AcquisitionFailure,
	consecutiveFailures: number,
): number {
	const attempt = Math.max(1, consecutiveFailures);
	if (/\b429\b/.test(failure.message)) {
		return Math.min(5 * 60_000, 60_000 * 2 ** (attempt - 1));
	}
	return Math.min(2 * 60_000, 15_000 * 2 ** (attempt - 1));
}

/** A definitive provider rejection cannot be resolved by changing the search term. */
export function shouldDisableAcquisitionSource(
	failure: AcquisitionFailure,
): boolean {
	return !failure.retryable || /\b(?:400|401|403|404)\b/.test(failure.message);
}

export function isJobRepositoryCapacityError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/^Database size limit \(\d+\) reached(?:;|$)/.test(error.message)
	);
}

export const addAcquireJobsCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> =>
	yargs.command({
		command: "acquire-jobs",
		describe:
			"Acquire jobs from supported endpoints (Indeed, LinkedIn) into canonical artifacts.",
		builder: (yy: Argv<GlobalArgs>) => {
			const builder: Argv = yy;
			return builder
				.option("sites", {
					type: "string",
					default: "indeed",
					description:
						"Acquisition source(s): indeed, linkedin, or comma-separated list.",
				})
				.option("job-provider", {
					type: "string",
					description:
						"Alias for --sites (supports indeed, linkedin, or comma-separated list).",
				})
				.option("search-terms", {
					type: "string",
					default: "",
					description:
						"Comma-separated search terms; overrides --search-terms-file when supplied.",
				})
				.option("search-terms-file", {
					type: "string",
					default: defaultSearchTermsFile,
					description:
						"Newline-delimited search-term file used when --search-terms is empty.",
				})
				.option("locations", {
					type: "string",
					default: "",
					description:
						"Comma-separated locations. Empty searches each term without a location filter.",
				})
				.option("results-wanted", {
					type: "number",
					default: 25,
					description: "Maximum results per source, search term, and location.",
				})
				.option("distance", {
					type: "number",
					default: 50,
					description: "Search radius in miles.",
				})
				.option("hours-old", {
					type: "number",
					description:
						"Only include jobs posted within this many hours. Omit for no age constraint.",
				})
				.option("remote", {
					type: "boolean",
					default: false,
					description:
						"Legacy search-level remote constraint. Disabled by default; prefer --remote-only for strict filtering.",
				})
				.option("remote-only", {
					type: "boolean",
					description:
						"Retain only acquired jobs whose isRemote property is explicitly true. Excludes non-remote or indeterminate jobs.",
				})
				.option("job-type", {
					type: "string",
					choices: ["fulltime", "parttime", "contract", "internship"] as const,
					description: "Optional employment-type restriction.",
				})
				.option("easy-apply", {
					type: "boolean",
					default: false,
					description:
						"Restrict to easy-apply jobs where the source supports it.",
				})
				.option("indeed-country", {
					type: "string",
					default: "USA",
					description:
						"Indeed market, for example USA, Canada, UK, Germany, or India.",
				})
				.option("description-mode", {
					type: "string",
					choices: ["none", "available", "full"] as const,
					default: "full",
					description:
						"none omits descriptions; available and full retain Indeed descriptions returned in search responses.",
				})
				.option("description-format", {
					type: "string",
					choices: ["markdown", "html", "plain"] as const,
					default: "markdown",
					description: "Stored representation for acquired job descriptions.",
				})
				.option("proxies", {
					type: "string",
					default: "",
					description: "Comma-separated HTTP(S) or SOCKS proxy URLs.",
				})
				.option("user-agent", {
					type: "string",
					description: "Optional user agent for provider requests.",
				})
				.option("output-file", {
					type: "string",
					default: "",
					description:
						"Canonical JSON output path. When multiple sources are acquired, defaults to acquired_jobs_<source>.json in the output directory.",
				})
				.option("output-file-indeed", {
					type: "string",
					description:
						"Output path for Indeed jobs (defaults to acquired_jobs_indeed.json).",
				})
				.option("output-file-linkedin", {
					type: "string",
					description:
						"Output path for LinkedIn jobs (defaults to acquired_jobs_linkedin.json).",
				})
				.option("use-jobdb", {
					type: "boolean",
					default: true,
					description:
						"Skip records discovered during the SQLite repository retention period.",
				})
				.option("show-fetch-url", {
					type: "boolean",
					default: false,
					description:
						"Display Indeed and LinkedIn fetch URLs in console output.",
				})
				.check((argv) => {
					const rawSites = String(
						argv["job-provider"] || argv.sites || "indeed",
					);
					parseAcquisitionSources(rawSites);
					if (
						!Number.isInteger(argv["results-wanted"]) ||
						argv["results-wanted"] <= 0
					)
						throw new Error("--results-wanted must be a positive integer");
					if (!Number.isFinite(argv.distance) || argv.distance < 0)
						throw new Error("--distance must be zero or greater");
					if (
						argv["hours-old"] !== undefined &&
						(!Number.isFinite(argv["hours-old"]) || argv["hours-old"] <= 0)
					)
						throw new Error(
							"--hours-old must be greater than zero when supplied",
						);
					return true;
				});
		},
		handler: async (argv: Arguments) => {
			await runAcquireJobs(argv as unknown as AcquireJobsCli);
		},
	});

export async function runAcquireJobs(
	argv: AcquireJobsCli,
): Promise<{ outputFile: string; outputFiles?: string[]; jobs: number }> {
	const stats = createStatisticsCollector("acquire-jobs");
	stats.startCollection();
	const started = performance.now();
	const isRemoteOnly = resolveRemoteOnlyOption(
		argv["remote-only"],
		argv.remoteOnly,
	);
	let jobRepository: JobRepository | undefined;
	let outputFile = "";
	let savedJobsCount = 0;
	let sources: AcquisitionSource[] = [];
	let resolvedOutputFiles: Record<AcquisitionSource, string> = {
		indeed: "",
		linkedin: "",
	};
	const dataDirectory = argv["output-file"]
		? path.dirname(argv["output-file"])
		: getDataDirectory();
	try {
		const rawSites = String(
			argv["job-provider"] || argv.jobProvider || argv.sites || "indeed",
		);
		const showFetchUrl = Boolean(
			argv["show-fetch-url"] ||
				argv.showFetchUrl ||
				process.env.ASTROEX_SHOW_FETCH_URL === "1",
		);
		sources = parseAcquisitionSources(rawSites);
		const terms = await loadSearchTerms(
			argv["search-terms"],
			argv["search-terms-file"],
		);
		if (terms.length === 0)
			throw new Error(
				"No search terms supplied or found in --search-terms-file",
			);
		const locations = parseList(argv.locations);
		const queryLocations = locations.length > 0 ? locations : [undefined];

		resolvedOutputFiles = resolveOutputFiles(
			dataDirectory,
			sources,
			argv["output-file"],
			argv.outputFilesBySource,
			argv["output-file-indeed"],
			argv["output-file-linkedin"],
		);
		outputFile = resolvedOutputFiles[sources[0]] ?? argv["output-file"];

		jobRepository = new JobRepository({
			dbFilePath: path.join(dataDirectory, "jobDB.sqlite"),
			legacyJsonPath: path.join(dataDirectory, "jobDB.json"),
			defaultExpirationMs: JOB_DB_RETENTION_MS,
			enableJobDB: argv["use-jobdb"] ?? true,
		});
		await jobRepository.initialize();
		await jobRepository.load();
		const expired = await jobRepository.cleanupExpired();
		if (expired)
			logger.info(`Removed ${expired} expired repository entries.`, {
				expiredCount: expired,
			});

		const provider = new IndeedProvider();
		const savedJobsBySource = new Map<
			AcquisitionSource,
			CanonicalAcquiredJob[]
		>();
		const initialCheckpointJobCounts = new Map<AcquisitionSource, number>();
		const savedJobIds = new Set<string>();

		for (const source of sources) {
			const file = resolvedOutputFiles[source];
			await fs.mkdir(path.dirname(file), { recursive: true });
			let sourceJobs = await loadAcquisitionCheckpoint(file);
			if (isRemoteOnly) {
				const initialCount = sourceJobs.length;
				sourceJobs = filterRemoteOnlyJobs(sourceJobs);
				const removedCount = initialCount - sourceJobs.length;
				if (removedCount > 0) {
					logger.info(
						`Filtered out ${removedCount} non-remote jobs from resumed checkpoint ${file} (--remote-only enabled).`,
						{
							retainedCount: sourceJobs.length,
							removedCount,
							outputFile: file,
						},
					);
					await writeAcquisitionCheckpoint(file, sourceJobs);
				}
			}
			savedJobsBySource.set(source, sourceJobs);
			initialCheckpointJobCounts.set(source, sourceJobs.length);
			for (const job of sourceJobs) {
				savedJobIds.add(job.id);
			}
			if (sourceJobs.length > 0) {
				logger.info(`Resuming ${sourceJobs.length} jobs from ${file}.`, {
					resumedCount: sourceJobs.length,
					outputFile: file,
				});
				try {
					await jobRepository.addSearchedJobs(sourceJobs.map(toLegacyJob));
				} catch (error) {
					if (!isJobRepositoryCapacityError(error)) throw error;
					log(
						"AcquireJobs",
						"Repository discovery capacity reached while restoring the acquisition checkpoint.",
						"warn",
					);
				}
			}
		}

		let acquiredCount = 0;
		const providerFailures: AcquisitionFailure[] = [];
		const disabledSources = new Set<AcquisitionSource>();
		const cooldownUntilBySource = new Map<AcquisitionSource, number>();
		const consecutiveFailuresBySource = new Map<AcquisitionSource, number>();
		const totalQueries = terms.length * queryLocations.length;
		const acquisitionProgress = createProgressReporter(logger, {
			label: "Stage 1/8: AcquireJobs",
			unitLabel: "query",
			totalUnits: totalQueries,
			maxUpdates: Math.max(1, totalQueries),
		});
		acquisitionProgress.start({
			searchTerms: terms.length,
			locations: queryLocations.length,
		});
		for (const searchTerm of terms) {
			for (const location of queryLocations) {
				throwIfCancelled(argv.signal);
				let activeSources = sources.filter(
					(source) => !disabledSources.has(source),
				);
				if (activeSources.length === 0) {
					acquisitionProgress.complete(
						{ searchTerm, location, outcome: "skipped" },
						{ level: "warn", suffix: "no active providers" },
					);
					continue;
				}

				const now = Date.now();
				const coolingSources = activeSources.filter(
					(source) => (cooldownUntilBySource.get(source) ?? 0) > now,
				);
				activeSources = activeSources.filter(
					(source) => !coolingSources.includes(source),
				);
				if (coolingSources.length > 0) {
					log(
						"AcquireJobs",
						`Skipping cooling provider(s): ${coolingSources.join(", ")}.`,
						"info",
					);
				}
				if (activeSources.length === 0) {
					const waitMs = Math.max(
						0,
						Math.min(
							...coolingSources.map(
								(source) => cooldownUntilBySource.get(source) ?? now,
							),
						) - Date.now(),
					);
					log(
						"AcquireJobs",
						`All active providers are cooling down; waiting ${Math.ceil(waitMs / 1000)}s before retrying this query.`,
						"warn",
					);
					await abortableDelay(waitMs, argv.signal);
					activeSources = sources.filter(
						(source) =>
							!disabledSources.has(source) &&
							(cooldownUntilBySource.get(source) ?? 0) <= Date.now(),
					);
					if (activeSources.length === 0) {
						acquisitionProgress.complete(
							{ searchTerm, location, outcome: "skipped" },
							{ level: "warn", suffix: "providers unavailable" },
						);
						continue;
					}
				}
				log(
					"AcquireJobs",
					`Acquiring ${activeSources.join(", ")} jobs for ${JSON.stringify(searchTerm)}${location ? ` in ${JSON.stringify(location)}` : ""}.`,
				);
				const timer = stats.startTimer("acquisition.query");
				const result = await provider.acquire({
					sources: activeSources,
					searchTerm,
					location,
					distance: argv.distance,
					resultsWanted: argv["results-wanted"],
					hoursOld: argv["hours-old"],
					isRemote: isRemoteOnly
						? true
						: argv.remote === true
							? true
							: undefined,
					remoteOnly: isRemoteOnly || undefined,
					jobType: argv["job-type"] as
						| "fulltime"
						| "parttime"
						| "contract"
						| "internship"
						| undefined,
					easyApply: argv["easy-apply"] || undefined,
					indeedCountry: argv["indeed-country"],
					indeedApiKey: process.env.ASTROEX_INDEED_API_KEY,
					includeDescriptions: argv["description-mode"] !== "none",
					descriptionFormat: argv["description-format"] as
						| "markdown"
						| "html"
						| "plain",
					proxies: parseList(argv.proxies),
					userAgent: argv["user-agent"],
					showFetchUrl,
					signal: argv.signal,
				});
				throwIfCancelled(argv.signal);
				stats.endTimer(timer);
				stats.incrementCounter("network.connections", activeSources.length);
				const failedSources = new Set(
					result.failures.map((failure) => failure.source),
				);
				for (const source of activeSources) {
					if (!failedSources.has(source)) {
						consecutiveFailuresBySource.delete(source);
						cooldownUntilBySource.delete(source);
					}
				}
				for (const failure of result.failures) {
					providerFailures.push(failure);
					stats.recordWarning(`Provider failure: ${failure.source}`, {
						failure,
					});
					log("AcquireJobs", `${failure.source}: ${failure.message}`, "warn");
					if (shouldDisableAcquisitionSource(failure)) {
						disabledSources.add(failure.source);
						log(
							"AcquireJobs",
							"Disabled provider for the remainder of this run after an unrecoverable failure",
							"warn",
							{ source: failure.source, message: failure.message },
						);
					} else if (failure.retryable) {
						const consecutiveFailures =
							(consecutiveFailuresBySource.get(failure.source) ?? 0) + 1;
						consecutiveFailuresBySource.set(
							failure.source,
							consecutiveFailures,
						);
						const cooldownMs = getProviderCooldownMs(
							failure,
							consecutiveFailures,
						);
						cooldownUntilBySource.set(failure.source, Date.now() + cooldownMs);
						log(
							"AcquireJobs",
							`${failure.source} will cool down for ${Math.ceil(cooldownMs / 1000)}s after ${consecutiveFailures} retryable failure(s).`,
							"warn",
						);
					}
				}

				const candidateJobs = isRemoteOnly
					? filterRemoteOnlyJobs(result.jobs)
					: result.jobs;
				if (isRemoteOnly && result.jobs.length > candidateJobs.length) {
					const nonRemoteCount = result.jobs.length - candidateJobs.length;
					stats.incrementCounter("data.recordsFiltered", nonRemoteCount);
					logger.debug(
						`Filtered out ${nonRemoteCount} non-remote jobs from query results (--remote-only enabled).`,
						{
							rawCount: result.jobs.length,
							retainedCount: candidateJobs.length,
							nonRemoteCount,
						},
					);
				}

				acquiredCount += candidateJobs.length;
				const newJobs = deduplicateJobs(candidateJobs).filter(
					(job) =>
						!savedJobIds.has(job.id) &&
						!jobRepository?.isJobMatched(toLegacyJob(job)),
				);
				if (newJobs.length === 0) {
					acquisitionProgress.complete(
						{
							searchTerm,
							location,
							providers: activeSources,
							candidateJobs: candidateJobs.length,
							newJobs: 0,
							outcome: "completed",
						},
						{ suffix: "no new jobs" },
					);
					continue;
				}

				// Persist the artifact before the repository marker so an interrupted run
				// can resume from the same output file without losing completed work.
				for (const source of sources) {
					const sourceNewJobs = newJobs.filter((job) => job.source === source);
					if (sourceNewJobs.length === 0) continue;
					const current = savedJobsBySource.get(source) ?? [];
					const updated = [...current, ...sourceNewJobs];
					savedJobsBySource.set(source, updated);
					const file = resolvedOutputFiles[source];
					await writeAcquisitionCheckpoint(file, updated);
					stats.incrementCounter("files.written", 1);
				}
				for (const job of newJobs) savedJobIds.add(job.id);
				try {
					const recorded = await jobRepository.addSearchedJobs(
						newJobs.map(toLegacyJob),
					);
					stats.incrementCounter("jobDB.discoveryRecorded", recorded);
				} catch (error) {
					if (!isJobRepositoryCapacityError(error)) throw error;
					stats.recordWarning(
						"Repository discovery capacity reached; checkpoint artifact was saved without recording additional entries",
						{ jobCount: newJobs.length },
					);
				}
				acquisitionProgress.complete({
					searchTerm,
					location,
					providers: activeSources,
					candidateJobs: candidateJobs.length,
					newJobs: newJobs.length,
					outcome: "completed",
				});
			}
		}

		let totalSavedJobs = 0;
		let totalInitialJobs = 0;
		for (const source of sources) {
			const count = (savedJobsBySource.get(source) ?? []).length;
			totalSavedJobs += count;
			totalInitialJobs += initialCheckpointJobCounts.get(source) ?? 0;
		}

		if (totalSavedJobs === 0 && providerFailures.length > 0) {
			throw new Error(
				`No jobs were acquired because every active provider failed. First failure: ${providerFailures[0].source}: ${providerFailures[0].message}`,
			);
		}

		stats.incrementCounter("data.recordsProcessed", acquiredCount);
		stats.incrementCounter(
			"data.duplicatesRemoved",
			acquiredCount - (totalSavedJobs - totalInitialJobs),
		);

		for (const source of sources) {
			const file = resolvedOutputFiles[source];
			const sourceJobs = savedJobsBySource.get(source) ?? [];
			try {
				await fs.access(file);
			} catch {
				await writeAcquisitionCheckpoint(file, sourceJobs);
			}
			stats.recordSuccess("acquire-jobs.complete", {
				source,
				outputFile: file,
				jobs: sourceJobs.length,
				sources,
				terms: terms.length,
			});
			logger.success(
				`Wrote ${sourceJobs.length} canonical ${source} jobs to ${file}`,
				{
					source,
					count: sourceJobs.length,
					outputFile: file,
					durationMs: Math.round(performance.now() - started),
				},
			);
		}
		savedJobsCount = totalSavedJobs;
	} catch (error) {
		const normalized =
			error instanceof Error ? error : new Error(String(error));
		stats.recordError(normalized);
		logger.error(`Acquisition failed: ${normalized.message}`, normalized);
		throw normalized;
	} finally {
		if (jobRepository) await jobRepository.close();
		const summary = stats.endCollection();
		logger.info("Final statistics", { summary });
	}
	return {
		outputFile: resolvedOutputFiles[sources[0]] ?? outputFile,
		outputFiles: sources.map((s) => resolvedOutputFiles[s]),
		jobs: savedJobsCount,
	};
}
