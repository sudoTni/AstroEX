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
import {
	getDataDirectory,
	getLogsDirectory,
	getProfileFile,
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

const logger = createLogger("AcquireJobs");

const defaultSearchTermsFile = getProfileFile("search_terms.txt");

export type AcquireJobsCli = GlobalArgs & {
	sites: string;
	"search-terms": string;
	"search-terms-file": string;
	locations: string;
	"results-wanted": number;
	distance: number;
	"hours-old": number;
	remote: boolean;
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
	"use-jobdb": boolean;
};

export function parseAcquisitionSources(value: string): AcquisitionSource[] {
	const sources = value
		.split(",")
		.map((source) => source.trim().toLowerCase())
		.filter(Boolean);
	if (sources.length === 0) {
		throw new Error("--sites must include indeed");
	}
	const invalid = sources.filter((source) => source !== "indeed");
	if (invalid.length > 0) {
		throw new Error(
			`Unsupported acquisition site(s): ${invalid.join(", ")}. Only indeed is supported.`,
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
			"Acquire jobs from the public Indeed endpoint into canonical Indeed artifacts.",
		builder: (yy: Argv<GlobalArgs>) =>
			(yy as Argv<AcquireJobsCli>)
				.option("sites", {
					type: "string",
					default: "indeed",
					description: "Acquisition source. Only indeed is supported.",
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
					default: 168,
					description: "Only include jobs posted within this many hours.",
				})
				.option("remote", {
					type: "boolean",
					default: true,
					description:
						"Restrict searches to remote jobs. Enabled by default; use --no-remote for broad searches.",
				})
				.option("remote-only", {
					type: "boolean",
					default: false,
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
						"Canonical JSON output path. Defaults to data/acquired_jobs_<timestamp>.json.",
				})
				.option("use-jobdb", {
					type: "boolean",
					default: true,
					description:
						"Skip records discovered during the SQLite repository retention period.",
				})
				.check((argv) => {
					parseAcquisitionSources(String(argv.sites ?? ""));
					if (
						!Number.isInteger(argv["results-wanted"]) ||
						argv["results-wanted"] <= 0
					)
						throw new Error("--results-wanted must be a positive integer");
					if (!Number.isFinite(argv.distance) || argv.distance < 0)
						throw new Error("--distance must be zero or greater");
					if (!Number.isFinite(argv["hours-old"]) || argv["hours-old"] < 0)
						throw new Error("--hours-old must be zero or greater");
					return true;
				}),
		handler: async (argv: Arguments<AcquireJobsCli>) => {
			await runAcquireJobs(argv as AcquireJobsCli);
		},
	});

export async function runAcquireJobs(
	argv: AcquireJobsCli,
): Promise<{ outputFile: string; jobs: number }> {
	const stats = createStatisticsCollector("acquire-jobs");
	stats.startCollection();
	const started = performance.now();
	const isRemoteOnly = Boolean(argv["remote-only"] || argv.remoteOnly);
	let jobRepository: JobRepository | undefined;
	let outputFile = "";
	let savedJobsCount = 0;
	const dataDirectory = argv["output-file"]
		? path.dirname(argv["output-file"])
		: getDataDirectory();
	const defaultLogDirectory = getLogsDirectory();
	try {
		if (!argv.disableFileLogging) {
			initializeFileLogging(
				typeof argv.logDir === "string" ? argv.logDir : defaultLogDirectory,
				`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_acquire-jobs_${typeof argv.logFile === "string" ? argv.logFile : "astroex.log"}`,
				"AcquireJobs",
			);
		}
		const sources = parseAcquisitionSources(argv.sites);
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
		outputFile =
			argv["output-file"] ||
			path.join(
				dataDirectory,
				`acquired_jobs_${formatDate(new Date(), "yyyyMMdd_HHmmss")}.json`,
			);
		await fs.mkdir(path.dirname(outputFile), { recursive: true });

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
		let savedJobs = await loadAcquisitionCheckpoint(outputFile);
		if (isRemoteOnly) {
			const initialCount = savedJobs.length;
			savedJobs = filterRemoteOnlyJobs(savedJobs);
			const removedCount = initialCount - savedJobs.length;
			if (removedCount > 0) {
				logger.info(
					`Filtered out ${removedCount} non-remote jobs from resumed checkpoint ${outputFile} (--remote-only enabled).`,
					{
						retainedCount: savedJobs.length,
						removedCount,
						outputFile,
					},
				);
				await writeAcquisitionCheckpoint(outputFile, savedJobs);
			}
		}
		const savedJobIds = new Set(savedJobs.map((job) => job.id));
		const initialCheckpointJobCount = savedJobs.length;
		if (savedJobs.length > 0) {
			logger.info(`Resuming ${savedJobs.length} jobs from ${outputFile}.`, {
				resumedCount: savedJobs.length,
				outputFile,
			});
			try {
				await jobRepository.addSearchedJobs(savedJobs.map(toLegacyJob));
			} catch (error) {
				if (!isJobRepositoryCapacityError(error)) throw error;
				log(
					"AcquireJobs",
					"Repository discovery capacity reached while restoring the acquisition checkpoint.",
					"warn",
				);
			}
		}

		let acquiredCount = 0;
		const providerFailures: AcquisitionFailure[] = [];
		const disabledSources = new Set<AcquisitionSource>();
		const cooldownUntilBySource = new Map<AcquisitionSource, number>();
		const consecutiveFailuresBySource = new Map<AcquisitionSource, number>();
		acquisitionLoop: for (const searchTerm of terms) {
			for (const location of queryLocations) {
				let activeSources = sources.filter(
					(source) => !disabledSources.has(source),
				);
				if (activeSources.length === 0) break acquisitionLoop;

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
					await new Promise((resolve) => setTimeout(resolve, waitMs));
					activeSources = sources.filter(
						(source) =>
							!disabledSources.has(source) &&
							(cooldownUntilBySource.get(source) ?? 0) <= Date.now(),
					);
					if (activeSources.length === 0) continue;
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
					hoursOld: argv["hours-old"] || undefined,
					isRemote: isRemoteOnly ? true : argv.remote || undefined,
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
				});
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
						!jobRepository?.isJobSeen(toLegacyJob(job)),
				);
				if (newJobs.length === 0) continue;

				// Persist the artifact before the repository marker so an interrupted run
				// can resume from the same output file without losing completed work.
				savedJobs = [...savedJobs, ...newJobs];
				await writeAcquisitionCheckpoint(outputFile, savedJobs);
				for (const job of newJobs) savedJobIds.add(job.id);
				stats.incrementCounter("files.written", 1);
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
			}
		}
		if (savedJobs.length === 0 && providerFailures.length > 0) {
			throw new Error(
				`No jobs were acquired because every active provider failed. First failure: ${providerFailures[0].source}: ${providerFailures[0].message}`,
			);
		}

		stats.incrementCounter("data.recordsProcessed", acquiredCount);
		stats.incrementCounter(
			"data.duplicatesRemoved",
			acquiredCount - (savedJobs.length - initialCheckpointJobCount),
		);
		stats.recordSuccess("acquire-jobs.complete", {
			outputFile,
			jobs: savedJobs.length,
			sources,
			terms: terms.length,
		});
		savedJobsCount = savedJobs.length;
		logger.success(
			`Wrote ${savedJobs.length} canonical jobs to ${outputFile}`,
			{
				count: savedJobs.length,
				outputFile,
				durationMs: Math.round(performance.now() - started),
			},
		);
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
		await closeFileLogging();
	}
	return { outputFile, jobs: savedJobsCount };
}
