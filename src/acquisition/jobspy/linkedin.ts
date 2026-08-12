/**
 * Vendored and adapted from ts-jobspy-main/src/linkedin (MIT).
 * This module intentionally uses LinkedIn's public guest search endpoint and
 * is called only through AstroEX's source-limited acquisition provider.
 */
import * as cheerio from "cheerio";
import type { CanonicalAcquiredJob } from "../types";
import { createJobSpySession, descriptionToFormat } from "./http";

const LINKEDIN_HEADERS = {
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
};

function jobTypeCode(jobType?: string): string | undefined {
	return (
		{ fulltime: "F", parttime: "P", contract: "C", internship: "I" } as Record<
			string,
			string
		>
	)[jobType ?? ""];
}

function parseDate(value?: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function acquireLinkedInJobs(options: {
	searchTerm: string;
	location?: string;
	distance?: number;
	resultsWanted: number;
	hoursOld?: number;
	isRemote?: boolean;
	jobType?: string;
	easyApply?: boolean;
	offset?: number;
	companyIds?: number[];
	fetchDescription?: boolean;
	descriptionFormat: "markdown" | "html" | "plain";
	proxies?: string[];
	userAgent?: string;
}): Promise<CanonicalAcquiredJob[]> {
	const session = createJobSpySession({
		proxies: options.proxies,
		userAgent: options.userAgent,
		hasRetry: true,
		retryDelaySeconds: 5,
	});
	Object.assign(session.defaults.headers, LINKEDIN_HEADERS);
	const jobs: CanonicalAcquiredJob[] = [];
	const seen = new Set<string>();
	let start = Math.max(0, Math.floor((options.offset ?? 0) / 10) * 10);

	while (jobs.length < options.resultsWanted && start < 1000) {
		const params: Record<string, string | number | undefined> = {
			keywords: options.searchTerm,
			location: options.location,
			distance: options.distance ?? 50,
			f_WT: options.isRemote ? 2 : undefined,
			f_JT: jobTypeCode(options.jobType),
			f_AL: options.easyApply ? "true" : undefined,
			f_C: options.companyIds?.join(","),
			f_TPR: options.hoursOld ? `r${options.hoursOld * 3600}` : undefined,
			start,
		};
		const response = await session.get<string>(
			"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
			{
				params: Object.fromEntries(
					Object.entries(params).filter(([, value]) => value !== undefined),
				),
				timeout: 10_000,
			},
		);
		const $ = cheerio.load(response.data);
		const cards = $("div.base-search-card").toArray();
		if (!cards.length) break;

		for (const card of cards) {
			const card$ = cheerio.load(card);
			const href = card$("a.base-card__full-link")
				.first()
				.attr("href")
				?.split("?")[0];
			const sourceJobId = href?.match(/-(\d+)$/)?.[1];
			if (!href || !sourceJobId || seen.has(sourceJobId)) continue;
			seen.add(sourceJobId);
			const title = card$("span.sr-only").first().text().trim();
			const companyLink = card$("h4.base-search-card__subtitle a").first();
			const company = companyLink.text().trim();
			if (!title || !company) continue;
			const location =
				card$("span.job-search-card__location").first().text().trim() ||
				undefined;
			const postedAt = parseDate(
				card$(
					"time.job-search-card__listdate, time.job-search-card__listdate--new",
				)
					.first()
					.attr("datetime"),
			);
			const salary = card$("span.job-search-card__salary-info")
				.first()
				.text()
				.trim();
			const amounts = salary.match(/\$?([\d,]+)\s*[-–—]\s*\$?([\d,]+)/);
			let description: string | undefined;
			let directUrl: string | undefined;
			if (options.fetchDescription) {
				try {
					const details = await session.get<string>(
						`https://www.linkedin.com/jobs/view/${sourceJobId}`,
						{ timeout: 10_000 },
					);
					const details$ = cheerio.load(details.data);
					const html = details$("div.show-more-less-html__markup")
						.first()
						.html();
					if (html)
						description = descriptionToFormat(html, options.descriptionFormat);
					const applyUrl = details$("code#applyUrl")
						.first()
						.html()
						?.match(/(?<=\?url=)[^"]+/)?.[0];
					if (applyUrl) directUrl = decodeURIComponent(applyUrl);
				} catch {
					// Search data remains useful when individual detail retrieval is blocked.
				}
			}
			jobs.push({
				id: `linkedin:${sourceJobId}`,
				source: "linkedin",
				sourceJobId,
				canonicalUrl: `https://www.linkedin.com/jobs/view/${sourceJobId}`,
				directUrl,
				title,
				company,
				companyUrl: companyLink.attr("href")?.split("?")[0],
				location,
				postedAt,
				description,
				descriptionRepresentation: description
					? options.descriptionFormat
					: "unknown",
				isRemote: /\b(remote|work from home|wfh)\b/i.test(
					`${title} ${location ?? ""} ${description ?? ""}`,
				),
				compensation: amounts
					? {
							minAmount: Number(amounts[1].replace(/,/g, "")),
							maxAmount: Number(amounts[2].replace(/,/g, "")),
							currency: "USD",
							source: "direct_data",
						}
					: undefined,
				acquiredAt: new Date().toISOString(),
			});
			if (jobs.length >= options.resultsWanted) break;
		}
		start += cards.length;
	}
	return jobs;
}
