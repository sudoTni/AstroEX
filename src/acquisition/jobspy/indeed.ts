/**
 * Adapted from ts-jobspy (Copyright 2025-2026 Alpha Romer Coma) and
 * JobSpy (Copyright 2023 Cullen Watson, Zachary Hampton), licensed under MIT.
 * See THIRD_PARTY_NOTICES.md for complete license texts.
 */
import type { AxiosResponse } from "axios";

import { throwIfCancelled } from "../../pipelineCancellation";
import { createLogger } from "../../utils";
import type { CanonicalAcquiredJob, CanonicalCompensation } from "../types";
import { createJobSpySession, descriptionToFormat } from "./http";

const logger = createLogger("IndeedSearch");

const INDEED_API_URL = "https://apis.indeed.com/graphql";
const INDEED_HEADERS = {
	Host: "apis.indeed.com",
	"content-type": "application/json",
	accept: "application/json",
	"indeed-locale": "en-US",
	"accept-language": "en-US,en;q=0.9",
	"user-agent":
		"Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1",
	"indeed-app-info":
		"appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone",
};

// Public client identifier extracted from Indeed's mobile application for GraphQL search queries.
// Not a private key or user credential. Can be overridden via ASTROEX_INDEED_CLIENT_KEY.
const DEFAULT_INDEED_CLIENT_KEY =
	process.env.ASTROEX_INDEED_CLIENT_KEY ||
	"161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8";

const QUERY_TEMPLATE =
	"query AstroExIndeed { jobSearch({what} {location} limit: 100 {cursor} sort: RELEVANCE {filters}) { pageInfo { nextCursor } results { job { key title datePublished description { html } location { city admin1Code countryCode formatted { long } } compensation { baseSalary { unitOfWork range { ... on Range { min max } } } estimated { currencyCode baseSalary { unitOfWork range { ... on Range { min max } } } } currencyCode } attributes { key label } employer { name relativeCompanyPageUrl dossier { employerDetails { industry } images { squareLogoUrl } links { corporateWebsite } } } recruit { viewJobUrl } } } } }";

interface IndeedRange {
	min?: number;
	max?: number;
}
interface IndeedSalary {
	unitOfWork?: string;
	range?: IndeedRange;
}
interface IndeedJob {
	key: string;
	title: string;
	datePublished?: number;
	description?: { html?: string };
	location?: {
		city?: string;
		admin1Code?: string;
		countryCode?: string;
		formatted?: { long?: string };
	};
	compensation?: {
		baseSalary?: IndeedSalary;
		estimated?: { currencyCode?: string; baseSalary?: IndeedSalary };
		currencyCode?: string;
	};
	attributes?: Array<{ key: string; label: string }>;
	employer?: {
		name?: string;
		relativeCompanyPageUrl?: string;
		dossier?: {
			employerDetails?: { industry?: string };
			images?: { squareLogoUrl?: string };
			links?: { corporateWebsite?: string };
		};
	};
	recruit?: { viewJobUrl?: string };
}
interface IndeedResponse {
	data?: {
		jobSearch?: {
			pageInfo?: { nextCursor?: string | null };
			results?: Array<{ job: IndeedJob }>;
		};
	};
}

type IndeedSearch = NonNullable<
	NonNullable<IndeedResponse["data"]>["jobSearch"]
>;

function countryCode(country?: string): { domain: string; code: string } {
	const key = (country ?? "usa").toLowerCase().replace(/\s+/g, "");
	const countries: Record<string, { domain: string; code: string }> = {
		usa: { domain: "www", code: "US" },
		uk: { domain: "uk", code: "GB" },
		canada: { domain: "ca", code: "CA" },
		australia: { domain: "au", code: "AU" },
		india: { domain: "in", code: "IN" },
		germany: { domain: "de", code: "DE" },
		france: { domain: "fr", code: "FR" },
		brazil: { domain: "br", code: "BR" },
		japan: { domain: "jp", code: "JP" },
	};
	return countries[key] ?? countries.usa;
}

function escapeGraphQL(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildIndeedFilters(options: {
	hoursOld?: number;
	easyApply?: boolean;
	isRemote?: boolean;
	remoteOnly?: boolean;
	jobType?: string;
}): string {
	if (options.hoursOld !== undefined) {
		if (!Number.isFinite(options.hoursOld) || options.hoursOld <= 0) {
			throw new Error("hoursOld must be greater than zero when supplied");
		}
		return `filters: { date: { field: "dateOnIndeed", start: "${options.hoursOld}h" } }`;
	}
	if (options.remoteOnly && options.easyApply) {
		throw new Error(
			"Indeed remote-only and easy-apply filters cannot be combined without hoursOld",
		);
	}
	if (options.remoteOnly) {
		const remoteKeys = ["DSQF7"];
		const jobTypeKeys: Record<string, string> = {
			fulltime: "CF3CP",
			parttime: "75GKK",
			contract: "NJXCK",
			internship: "VDTG7",
		};
		if (options.jobType && jobTypeKeys[options.jobType]) {
			remoteKeys.unshift(jobTypeKeys[options.jobType]);
		}
		return `filters: { composite: { filters: [{ keyword: { field: "attributes", keys: [${remoteKeys.map((key) => `"${key}"`).join(", ")}]} }] } }`;
	}
	if (options.easyApply)
		return 'filters: { keyword: { field: "indeedApplyScope", keys: ["DESKTOP"] } }';
	const keys: string[] = [];
	const jobTypeKeys: Record<string, string> = {
		fulltime: "CF3CP",
		parttime: "75GKK",
		contract: "NJXCK",
		internship: "VDTG7",
	};
	if (options.jobType && jobTypeKeys[options.jobType])
		keys.push(jobTypeKeys[options.jobType]);
	if (options.isRemote) keys.push("DSQF7");
	return keys.length
		? `filters: { composite: { filters: [{ keyword: { field: "attributes", keys: [${keys.map((key) => `"${key}"`).join(", ")}]} }] } }`
		: "";
}

/**
 * Classify returned records for strict remote-only validation. Indeed's remote
 * attribute is authoritative; text matching remains a fallback for date-filtered
 * searches, where the mutually exclusive DSQF7 request filter cannot be sent.
 */
export function isIndeedRemoteJob(job: {
	title?: string;
	attributes?: Array<{ key: string; label: string }>;
	location?: { formatted?: { long?: string } };
}): boolean {
	if (job.attributes?.some((attribute) => attribute.key === "DSQF7")) {
		return true;
	}
	const attributes = job.attributes
		?.map((attribute) => `${attribute.key} ${attribute.label}`)
		.join(" ");
	return /\b(remote|work from home|work-from-home|wfh)\b/i.test(
		[attributes, job.title, job.location?.formatted?.long]
			.filter(Boolean)
			.join(" "),
	);
}

function interval(value?: string): CanonicalCompensation["interval"] {
	const normalized = value?.toLowerCase();
	if (["year", "yearly", "annual"].includes(normalized ?? "")) return "yearly";
	if (["month", "monthly"].includes(normalized ?? "")) return "monthly";
	if (["week", "weekly"].includes(normalized ?? "")) return "weekly";
	if (["day", "daily"].includes(normalized ?? "")) return "daily";
	if (["hour", "hourly"].includes(normalized ?? "")) return "hourly";
	return undefined;
}

export async function acquireIndeedJobs(options: {
	searchTerm: string;
	location?: string;
	distance?: number;
	resultsWanted: number;
	hoursOld?: number;
	isRemote?: boolean;
	remoteOnly?: boolean;
	jobType?: string;
	easyApply?: boolean;
	offset?: number;
	country?: string;
	descriptionFormat: "markdown" | "html" | "plain";
	proxies?: string[];
	userAgent?: string;
	apiKey?: string;
	showFetchUrl?: boolean;
	signal?: AbortSignal;
}): Promise<CanonicalAcquiredJob[]> {
	const showFetchUrl = Boolean(
		options.showFetchUrl || process.env.ASTROEX_SHOW_FETCH_URL === "1",
	);
	const session = createJobSpySession({
		proxies: options.proxies,
		userAgent: options.userAgent,
	});
	const country = countryCode(options.country);
	const jobs: CanonicalAcquiredJob[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	const wanted = options.resultsWanted + (options.offset ?? 0);
	const remoteRequested =
		options.remoteOnly === true || options.isRemote === true;

	let pageNum = 0;
	while (jobs.length < wanted) {
		throwIfCancelled(options.signal);
		pageNum += 1;
		const query: string = QUERY_TEMPLATE.replace(
			"{what}",
			options.searchTerm ? `what: "${escapeGraphQL(options.searchTerm)}"` : "",
		)
			.replace(
				"{location}",
				options.location
					? `location: {where: "${escapeGraphQL(options.location)}", radius: ${options.distance ?? 50}, radiusUnit: MILES}`
					: "",
			)
			.replace("{cursor}", cursor ? `cursor: "${escapeGraphQL(cursor)}"` : "")
			.replace("{filters}", buildIndeedFilters(options));
		const fetchUrl = INDEED_API_URL;
		const filterMode =
			options.hoursOld !== undefined
				? `hoursOld:${options.hoursOld}`
				: options.remoteOnly
					? "remoteOnly:DSQF7"
					: options.easyApply
						? "easyApply"
						: options.isRemote
							? "remote:DSQF7"
							: options.jobType
								? `jobType:${options.jobType}`
								: "none";
		if (showFetchUrl) {
			logger.info(
				`[search][indeed] POST ${fetchUrl} filter=${filterMode} cursor=${cursor ? "present" : "none"}`,
			);
		}
		const response: AxiosResponse<IndeedResponse> =
			await session.post<IndeedResponse>(
				INDEED_API_URL,
				{ query },
				{
					headers: {
						...INDEED_HEADERS,
						"indeed-api-key":
							options.apiKey ??
							process.env.ASTROEX_INDEED_API_KEY ??
							DEFAULT_INDEED_CLIENT_KEY,
						"indeed-co": country.code,
					},
					timeout: 10_000,
					signal: options.signal,
				},
			);
		const search: IndeedSearch | undefined = response.data.data?.jobSearch;
		const results = search?.results ?? [];
		if (!results.length) break;

		let pageFetched = 0;
		for (const result of results) {
			const job = result.job;
			if (!job.key || seen.has(job.key)) continue;
			const isRemote = isIndeedRemoteJob(job);
			if (remoteRequested && !isRemote) continue;
			seen.add(job.key);
			const html = job.description?.html ?? "";
			const baseSalary =
				job.compensation?.baseSalary ?? job.compensation?.estimated?.baseSalary;
			const compensation =
				baseSalary?.range?.min && baseSalary.range.max
					? {
							interval: interval(baseSalary.unitOfWork),
							minAmount: baseSalary.range.min,
							maxAmount: baseSalary.range.max,
							currency:
								job.compensation?.currencyCode ??
								job.compensation?.estimated?.currencyCode ??
								"USD",
							source: "direct_data" as const,
						}
					: undefined;
			jobs.push({
				id: `indeed:${job.key}`,
				source: "indeed",
				sourceJobId: job.key,
				canonicalUrl: `https://${country.domain}.indeed.com/viewjob?jk=${job.key}`,
				directUrl: job.recruit?.viewJobUrl,
				title: job.title,
				company: job.employer?.name ?? "Unknown",
				companyUrl: job.employer?.relativeCompanyPageUrl
					? `https://${country.domain}.indeed.com${job.employer.relativeCompanyPageUrl}`
					: undefined,
				location:
					job.location?.formatted?.long ??
					([
						job.location?.city,
						job.location?.admin1Code,
						job.location?.countryCode,
					]
						.filter(Boolean)
						.join(", ") ||
						undefined),
				postedAt: job.datePublished
					? new Date(job.datePublished).toISOString()
					: undefined,
				description: html
					? descriptionToFormat(html, options.descriptionFormat)
					: undefined,
				descriptionRepresentation: html ? options.descriptionFormat : "unknown",
				isRemote,
				jobType:
					job.attributes
						?.map((attribute) => attribute.label)
						.filter(Boolean)
						.join(", ") || undefined,
				companyIndustry: job.employer?.dossier?.employerDetails?.industry
					?.replace("Iv1", "")
					.replace(/_/g, " ")
					.trim(),
				companyLogo: job.employer?.dossier?.images?.squareLogoUrl,
				compensation,
				acquiredAt: new Date().toISOString(),
			});
			pageFetched += 1;
			if (jobs.length >= wanted) break;
		}
		logger.info(
			showFetchUrl
				? `[search][indeed] page=${pageNum} fetched=${pageFetched} cumulative=${jobs.length} url=${fetchUrl} filter=${filterMode}`
				: `[search][indeed] page=${pageNum} fetched=${pageFetched} cumulative=${jobs.length}`,
			showFetchUrl
				? {
						page: pageNum,
						fetched: pageFetched,
						cumulative: jobs.length,
						url: fetchUrl,
						filterMode,
					}
				: {
						page: pageNum,
						fetched: pageFetched,
						cumulative: jobs.length,
					},
		);
		cursor = search?.pageInfo?.nextCursor ?? null;
		if (!cursor) break;
	}
	return jobs.slice(
		options.offset ?? 0,
		(options.offset ?? 0) + options.resultsWanted,
	);
}
