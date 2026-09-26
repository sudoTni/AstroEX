/**
 * Adapted from ts-jobspy (Copyright 2025-2026 Alpha Romer Coma) and
 * JobSpy (Copyright 2023 Cullen Watson, Zachary Hampton), licensed under MIT.
 * See THIRD_PARTY_NOTICES.md for complete license texts.
 */
import type { AxiosInstance, AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import { throwIfCancelled } from "../../pipelineCancellation";
import { createLogger } from "../../utils";
import { createJobSpySession, descriptionToFormat } from "./http";
import { LINKEDIN_HEADERS } from "./linkedinUtil";

const logger = createLogger("LinkedInEnrichment");

export interface LinkedInJobDetails {
	description?: string;
	descriptionHtml?: string;
	directUrl?: string;
	jobType?: string;
	jobLevel?: string;
	jobFunction?: string;
	companyIndustry?: string;
	companyLogo?: string;
}

export interface EnrichLinkedInOptions {
	jobId: string;
	session?: AxiosInstance;
	proxies?: string[];
	userAgent?: string;
	descriptionFormat?: "markdown" | "html" | "plain";
	signal?: AbortSignal;
}

const DIRECT_URL_REGEX = /(?<=\?url=)[^"]+/;

export function extractDirectUrl($: cheerio.CheerioAPI): string | undefined {
	const codeTag = $("code#applyUrl").first();
	if (codeTag.length) {
		const content = codeTag.html() ?? "";
		const match = content.match(/(?<=\?url=)[^"'\s<]+/);
		if (match) {
			try {
				const decoded = decodeURIComponent(match[0]);
				return decoded.replace(/-+>.*$/, "").trim();
			} catch {
				return match[0].replace(/-+>.*$/, "").trim();
			}
		}
	}
	return undefined;
}

export function parseLinkedInJobCriteria($: cheerio.CheerioAPI): {
	seniorityLevel?: string;
	employmentType?: string;
	jobFunction?: string;
	industries?: string;
} {
	const result: {
		seniorityLevel?: string;
		employmentType?: string;
		jobFunction?: string;
		industries?: string;
	} = {};

	$("li.description__job-criteria-item").each((_, elem) => {
		const header = $(elem)
			.find("h3.description__job-criteria-subheader")
			.text()
			.trim()
			.toLowerCase();
		const text = $(elem)
			.find("span.description__job-criteria-text")
			.text()
			.trim();
		if (!text) return;

		if (header.includes("seniority")) {
			result.seniorityLevel = text;
		} else if (header.includes("employment")) {
			result.employmentType = text;
		} else if (header.includes("function")) {
			result.jobFunction = text;
		} else if (header.includes("industries")) {
			result.industries = text;
		}
	});

	return result;
}

export async function fetchLinkedInJobDetails(
	options: EnrichLinkedInOptions,
): Promise<LinkedInJobDetails> {
	throwIfCancelled(options.signal);
	const session =
		options.session ??
		createJobSpySession({
			proxies: options.proxies,
			userAgent: options.userAgent,
			hasRetry: true,
			retryDelaySeconds: 2,
		});

	const customHeaders = {
		...LINKEDIN_HEADERS,
		...(options.userAgent ? { "user-agent": options.userAgent } : {}),
	};

	const url = `https://www.linkedin.com/jobs/view/${options.jobId}`;
	let response: AxiosResponse<string>;

	try {
		response = await session.get<string>(url, {
			headers: customHeaders,
			timeout: 10_000,
			signal: options.signal,
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			`Failed to fetch job details for LinkedIn job ${options.jobId}: ${message}`,
			{
				jobId: options.jobId,
				error: message,
			},
		);
		return {};
	}

	if (response.status < 200 || response.status >= 400) {
		logger.warn(
			`LinkedIn detail fetch returned HTTP ${response.status} for job ${options.jobId}`,
			{ jobId: options.jobId, status: response.status },
		);
		return {};
	}

	// Detect redirect to auth wall or login/signup
	const responseUrl: string | undefined = (
		response.request as { res?: { responseUrl?: string } } | undefined
	)?.res?.responseUrl;
	if (
		responseUrl &&
		(responseUrl.includes("linkedin.com/signup") ||
			responseUrl.includes("linkedin.com/login") ||
			responseUrl.includes("linkedin.com/authwall"))
	) {
		logger.warn(
			`LinkedIn job details for ${options.jobId} blocked by login/signup redirect: ${responseUrl}`,
			{ jobId: options.jobId, responseUrl },
		);
		return {};
	}

	const $ = cheerio.load(response.data);

	// Extract description
	const markupDiv = $("div.show-more-less-html__markup").first();
	let description: string | undefined;
	let descriptionHtml: string | undefined;

	if (markupDiv.length) {
		// Clean script and style tags inside markup
		markupDiv.find("script, style").remove();
		const rawHtml = markupDiv.html() ?? "";
		descriptionHtml = rawHtml;
		const format = options.descriptionFormat ?? "markdown";
		description = descriptionToFormat(rawHtml, format);
	}

	// Extract direct URL
	const directUrl = extractDirectUrl($);

	// Extract criteria
	const criteria = parseLinkedInJobCriteria($);

	// Extract company logo
	const logoImg = $("img.artdeco-entity-image").first();
	const companyLogo =
		logoImg.attr("data-delayed-url") ||
		logoImg.attr("data-ghost-url") ||
		logoImg.attr("src") ||
		undefined;

	return {
		description,
		descriptionHtml,
		directUrl,
		jobLevel: criteria.seniorityLevel,
		jobType: criteria.employmentType,
		jobFunction: criteria.jobFunction,
		companyIndustry: criteria.industries,
		companyLogo,
	};
}
