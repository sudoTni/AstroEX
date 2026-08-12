/**
 * Standalone provider assembled from vendored ts-jobspy components (MIT).
 * Only explicitly supported sources are permitted; ts-jobspy's experimental
 * board adapters are deliberately not exposed through AstroEX.
 */
import { acquireIndeedJobs } from "./jobspy/indeed";
import { acquireLinkedInJobs } from "./jobspy/linkedin";
import type {
	AcquisitionProvider,
	AcquisitionQuery,
	AcquisitionResult,
} from "./types";

export class JobSpyProvider implements AcquisitionProvider {
	async acquire(query: AcquisitionQuery): Promise<AcquisitionResult> {
		const failures: AcquisitionResult["failures"] = [];
		const jobs = await Promise.all(
			query.sources.map(async (source) => {
				try {
					if (source === "linkedin") {
						return await acquireLinkedInJobs({
							searchTerm: query.searchTerm,
							location: query.location,
							distance: query.distance,
							resultsWanted: query.linkedinResultsWanted ?? query.resultsWanted,
							hoursOld: query.hoursOld,
							isRemote: query.isRemote,
							jobType: query.jobType,
							easyApply: query.easyApply,
							offset: query.offset,
							fetchDescription: query.linkedinFetchDescription,
							descriptionFormat: query.descriptionFormat ?? "markdown",
							proxies: query.proxies,
							userAgent: query.userAgent,
						});
					}
					return await acquireIndeedJobs({
						searchTerm: query.searchTerm,
						location: query.location,
						distance: query.distance,
						resultsWanted: query.resultsWanted,
						hoursOld: query.hoursOld,
						isRemote: query.isRemote,
						jobType: query.jobType,
						easyApply: query.easyApply,
						offset: query.offset,
						country: query.indeedCountry,
						descriptionFormat: query.descriptionFormat ?? "markdown",
						proxies: query.proxies,
						userAgent: query.userAgent,
					});
				} catch (error: unknown) {
					const message =
						error instanceof Error ? error.message : String(error);
					failures.push({
						source,
						message,
						retryable: /429|timeout|network|5\d\d/i.test(message),
					});
					return [];
				}
			}),
		);
		const acquired = jobs.flat();
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
