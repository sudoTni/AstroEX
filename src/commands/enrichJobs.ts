import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Arguments, Argv } from "yargs";
import { fetchLinkedInJobDetails } from "../acquisition/jobspy/linkedinEnrichment";
import { extractJobIdFromUrl } from "../acquisition/jobspy/linkedinUtil";
import { writeArtifactManifest } from "../artifactManifest";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository } from "../jobRepository";
import type { JobInterface } from "../models";
import { abortableDelay, throwIfCancelled } from "../pipelineCancellation";
import { getDataDirectory } from "../runtimePaths";
import {
	type StatisticsCollector,
	createStatisticsCollector,
} from "../statistics";
import type { GlobalArgs } from "../types";
import { createLogger, formatDuration } from "../utils";

const logger = createLogger("EnrichJobs");

export interface EnrichJobsCli extends GlobalArgs {
	"input-file": string;
	"output-file": string;
	delay?: number;
	"description-format"?: string;
	proxies?: string;
	"user-agent"?: string;
	"use-jobdb"?: boolean;
	"show-fetch-url"?: boolean;
	showFetchUrl?: boolean;
}

export interface EnrichJobsOptions {
	inputFile: string;
	outputFile: string;
	delayMs?: number;
	descriptionFormat?: "markdown" | "html" | "plain";
	proxies?: string[];
	userAgent?: string;
	jobRepository?: JobRepository;
	stats?: StatisticsCollector;
	signal?: AbortSignal;
	"show-fetch-url"?: boolean;
	showFetchUrl?: boolean;
}

export interface EnrichJobsResult {
	totalJobs: number;
	enrichedCount: number;
	outputFile: string;
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

export async function runEnrichLinkedInJobs(
	options: EnrichJobsOptions,
): Promise<EnrichJobsResult> {
	const showFetchUrl = Boolean(
		options["show-fetch-url"] ||
			options.showFetchUrl ||
			process.env.ASTROEX_SHOW_FETCH_URL === "1",
	);
	const startedAt = performance.now();
	const stats = options.stats;
	const inputFile = path.resolve(options.inputFile);
	const outputFile = path.resolve(options.outputFile);

	let rawContent: string;
	try {
		rawContent = await fs.readFile(inputFile, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Could not read input file ${inputFile}: ${message}`);
		throw error;
	}

	const jobs: JobInterface[] = JSON.parse(rawContent);
	if (!Array.isArray(jobs)) {
		throw new Error(`Input file ${inputFile} did not contain a JSON array`);
	}

	const linkedinIndicesNeedingEnrichment: number[] = [];
	for (let i = 0; i < jobs.length; i++) {
		const job = jobs[i];
		const isLinkedIn =
			job.source === "linkedin" ||
			(typeof job.url === "string" && job.url.includes("linkedin.com"));
		if (isLinkedIn && !job.descriptionText?.trim()) {
			linkedinIndicesNeedingEnrichment.push(i);
		}
	}

	const totalToEnrich = linkedinIndicesNeedingEnrichment.length;
	logger.info(
		`Stage 4/8: [enrich][linkedin] 0/${totalToEnrich} Starting description enrichment for surviving LinkedIn jobs...`,
		{
			totalJobs: jobs.length,
			toEnrich: totalToEnrich,
		},
	);

	let enrichedCount = 0;
	const delayMs = options.delayMs ?? 1000;

	for (let step = 0; step < totalToEnrich; step++) {
		const jobIdx = linkedinIndicesNeedingEnrichment[step];
		const job = jobs[jobIdx];

		throwIfCancelled(options.signal);

		if (step > 0 && delayMs > 0) {
			await abortableDelay(delayMs, options.signal);
		}

		const rawId = job.sourceJobId || job.id;
		const jobId =
			extractJobIdFromUrl(job.url || "") || rawId.replace(/^linkedin:/, "");

		if (!jobId) {
			logger.warn(
				`Stage 4/8: [enrich][linkedin] ${step + 1}/${totalToEnrich} Skipping job with unresolvable jobId: "${job.title}" at "${job.company}"`,
			);
			continue;
		}

		const details = await fetchLinkedInJobDetails({
			jobId,
			proxies: options.proxies,
			userAgent: options.userAgent,
			descriptionFormat: options.descriptionFormat ?? "markdown",
			signal: options.signal,
		});

		if (details.description?.trim()) {
			job.descriptionText = details.description;
			if (details.descriptionHtml) {
				job.descriptionHtml = details.descriptionHtml;
			}
			if (details.directUrl) {
				job.directUrl = details.directUrl;
			}
			if (details.jobLevel && !job.seniorityLevel) {
				job.seniorityLevel = details.jobLevel;
			}
			if (details.jobType && !job.employmentType) {
				job.employmentType = details.jobType;
			}
			if (details.jobFunction && !job.jobFunction) {
				job.jobFunction = details.jobFunction;
			}
			if (details.companyIndustry && !job.industries) {
				job.industries = details.companyIndustry;
			}
			if (details.companyLogo && !job.img) {
				job.img = details.companyLogo;
			}

			enrichedCount++;
			stats?.incrementCounter("linkedin.enriched", 1);
			logger.info(
				showFetchUrl
					? `Stage 4/8: [enrich][linkedin] ${step + 1}/${totalToEnrich} Enriched "${job.title}" at "${job.company}" url=https://www.linkedin.com/jobs/view/${jobId}`
					: `Stage 4/8: [enrich][linkedin] ${step + 1}/${totalToEnrich} Enriched "${job.title}" at "${job.company}"`,
				showFetchUrl
					? {
							step: step + 1,
							total: totalToEnrich,
							jobId,
							url: `https://www.linkedin.com/jobs/view/${jobId}`,
						}
					: {
							step: step + 1,
							total: totalToEnrich,
							jobId,
						},
			);

			if (options.jobRepository) {
				try {
					await options.jobRepository.markJobDescriptionScraped(job);
				} catch (repoErr) {
					logger.warn(
						`Failed to record description scrape checkpoint in JobRepository: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`,
					);
				}
			}
		} else {
			logger.warn(
				showFetchUrl
					? `Stage 4/8: [enrich][linkedin] ${step + 1}/${totalToEnrich} No description retrieved for "${job.title}" at "${job.company}" (jobId: ${jobId}, url: https://www.linkedin.com/jobs/view/${jobId})`
					: `Stage 4/8: [enrich][linkedin] ${step + 1}/${totalToEnrich} No description retrieved for "${job.title}" at "${job.company}" (jobId: ${jobId})`,
				showFetchUrl
					? {
							step: step + 1,
							total: totalToEnrich,
							jobId,
							url: `https://www.linkedin.com/jobs/view/${jobId}`,
						}
					: {
							step: step + 1,
							total: totalToEnrich,
							jobId,
						},
			);
		}
	}

	await writeJsonAtomically(outputFile, jobs);
	await writeArtifactManifest(outputFile, "enrichJobs", {
		inputFile: path.basename(inputFile),
		totalJobs: jobs.length,
		enrichedCount,
		durationMs: Math.round(performance.now() - startedAt),
	});

	logger.success(
		`LinkedIn enrichment complete: ${enrichedCount}/${totalToEnrich} enriched out of ${jobs.length} jobs.`,
		{
			totalJobs: jobs.length,
			enrichedCount,
			outputFile,
			duration: formatDuration(performance.now() - startedAt),
		},
	);

	return {
		totalJobs: jobs.length,
		enrichedCount,
		outputFile,
	};
}

export const addEnrichJobsCommand = (
	yargs: Argv<GlobalArgs>,
): Argv<GlobalArgs> =>
	yargs.command({
		command: "enrich-jobs",
		describe:
			"Enrich LinkedIn jobs in an artifact with descriptions and full metadata.",
		builder: (yy: Argv<GlobalArgs>) =>
			(yy as Argv<EnrichJobsCli>)
				.option("input-file", {
					type: "string",
					demandOption: true,
					description: "Path to JSON job artifact (e.g. clothed_jobs.json).",
				})
				.option("output-file", {
					type: "string",
					demandOption: true,
					description:
						"Path to output JSON job artifact (e.g. clothed_jobs_enriched.json).",
				})
				.option("delay", {
					type: "number",
					default: 1000,
					description: "Delay between requests in milliseconds.",
				})
				.option("description-format", {
					type: "string",
					choices: ["markdown", "html", "plain"] as const,
					default: "markdown",
					description: "Format for enriched descriptions.",
				})
				.option("proxies", {
					type: "string",
					default: "",
					description: "Comma-separated proxy list.",
				})
				.option("user-agent", {
					type: "string",
					description: "Custom user agent header.",
				})
				.option("use-jobdb", {
					type: "boolean",
					default: true,
					description:
						"Record description scrape timestamp in SQLite repository.",
				})
				.option("show-fetch-url", {
					type: "boolean",
					default: false,
					description: "Display LinkedIn fetch URLs in console output.",
				}),
		handler: async (argv: Arguments<EnrichJobsCli>) => {
			const dataDir = getDataDirectory();
			const stats = createStatisticsCollector("enrich-jobs");
			stats.startCollection();

			let jobRepository: JobRepository | undefined;
			if (argv["use-jobdb"]) {
				jobRepository = new JobRepository({
					dbFilePath: path.join(dataDir, "jobDB.sqlite"),
					defaultExpirationMs: JOB_DB_RETENTION_MS,
					enableJobDB: true,
				});
				await jobRepository.initialize();
				await jobRepository.load();
				await jobRepository.cleanupExpired();
			}

			try {
				await runEnrichLinkedInJobs({
					inputFile: argv["input-file"],
					outputFile: argv["output-file"],
					delayMs: argv.delay,
					descriptionFormat: argv["description-format"] as
						| "markdown"
						| "html"
						| "plain",
					proxies: argv.proxies ? argv.proxies.split(",").filter(Boolean) : [],
					userAgent: argv["user-agent"],
					jobRepository,
					stats,
					showFetchUrl: argv["show-fetch-url"],
				});
			} finally {
				if (jobRepository) await jobRepository.close();
				stats.endCollection();
			}
		},
	});
