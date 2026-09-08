import { createLogger } from "../utils";
import { acquireIndeedJobs } from "./jobspy/indeed";
import type {
	AcquisitionProvider,
	AcquisitionQuery,
	AcquisitionResult,
} from "./types";

const logger = createLogger("IndeedProvider");

export class IndeedProvider implements AcquisitionProvider {
	async acquire(query: AcquisitionQuery): Promise<AcquisitionResult> {
		logger.debug("Executing Indeed acquisition query", {
			searchTerm: query.searchTerm,
			location: query.location,
			isRemote: query.isRemote,
			resultsWanted: query.resultsWanted,
		});
		const failures: AcquisitionResult["failures"] = [];
		const jobs = await Promise.all(
			query.sources.map(async (source) => {
				try {
					if (source !== "indeed") {
						throw new Error(`Unsupported acquisition source: ${source}`);
					}
					const results = await acquireIndeedJobs({
						searchTerm: query.searchTerm,
						location: query.location,
						distance: query.distance,
						resultsWanted: query.resultsWanted,
						hoursOld: query.hoursOld,
						isRemote: query.remoteOnly ? true : query.isRemote,
						jobType: query.jobType,
						easyApply: query.easyApply,
						offset: query.offset,
						country: query.indeedCountry,
						apiKey: query.indeedApiKey,
						descriptionFormat: query.descriptionFormat ?? "markdown",
						proxies: query.proxies,
						userAgent: query.userAgent,
					});
					logger.debug(`Acquired ${results.length} jobs for source ${source}`, {
						source,
						count: results.length,
					});
					return results;
				} catch (error: unknown) {
					const message =
						error instanceof Error ? error.message : String(error);
					const retryable = /429|timeout|network|5\d\d/i.test(message);
					logger.warn(
						`Indeed acquisition failure for source ${source}: ${message}`,
						{
							source,
							error: message,
							retryable,
						},
					);
					failures.push({
						source,
						message,
						retryable,
					});
					return [];
				}
			}),
		);
		const acquired = jobs.flat();
		logger.debug("Acquisition query completed", {
			totalAcquired: acquired.length,
			failureCount: failures.length,
		});
		return {
			jobs:
				query.includeDescriptions === false
					? acquired.map((job) => ({
							...job,
							description: undefined,
							descriptionRepresentation: "unknown" as const,
						}))
					: acquired,
			failures,
		};
	}
}
