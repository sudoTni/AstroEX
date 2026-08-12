import type { JobInterface } from "../models";
import type { CanonicalAcquiredJob } from "./types";

function locationParts(location?: string): {
	city: string;
	countryText: string;
	countryCode: string;
} {
	const parts = (location ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return {
		city: parts[0] ?? "",
		countryText: parts[parts.length - 1] ?? "",
		countryCode: "",
	};
}

/**
 * Compatibility projection for existing AstroEX filtering and LLM commands.
 * Canonical artifacts retain the richer, source-specific representation;
 * legacy-shaped artifacts let current commands consume acquired jobs unchanged.
 */
export function toLegacyJob(job: CanonicalAcquiredJob): JobInterface {
	const location = locationParts(job.location);
	const date = job.postedAt ? new Date(job.postedAt) : new Date(job.acquiredAt);
	const descriptionHtml =
		job.descriptionRepresentation === "html" ? job.description : undefined;
	return {
		id: job.id,
		title: job.title,
		img: job.companyLogo ?? "",
		url: job.canonicalUrl,
		companyUrl: job.companyUrl ?? "",
		date: date.toISOString().slice(0, 10),
		postedDate: date,
		company: job.company,
		location: job.location ?? "",
		countryCode: location.countryCode,
		countryText: location.countryText,
		descriptionHtml,
		descriptionText: job.description,
		city: location.city,
		remoteOk: job.isRemote ?? false,
		salaryMin: job.compensation?.minAmount ?? 0,
		salaryMax: job.compensation?.maxAmount ?? 0,
		salaryCurrency:
			(job.compensation?.currency as JobInterface["salaryCurrency"]) ?? "",
		stackRequired: [],
		seniorityLevel: job.jobLevel,
		employmentType: job.jobType,
		jobFunction: job.jobFunction,
		industries: job.companyIndustry,
		salaryRange:
			job.compensation?.minAmount && job.compensation.maxAmount
				? `${job.compensation.minAmount}-${job.compensation.maxAmount} ${job.compensation.currency ?? ""}`.trim()
				: undefined,
		source: job.source,
		sourceJobId: job.sourceJobId,
		canonicalUrl: job.canonicalUrl,
		directUrl: job.directUrl,
		acquiredAt: job.acquiredAt,
	};
}

export function isCanonicalAcquiredJob(
	value: unknown,
): value is CanonicalAcquiredJob {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<CanonicalAcquiredJob>;
	return (
		(job.source === "linkedin" || job.source === "indeed") &&
		typeof job.id === "string" &&
		typeof job.canonicalUrl === "string" &&
		typeof job.title === "string" &&
		typeof job.company === "string" &&
		typeof job.acquiredAt === "string"
	);
}
