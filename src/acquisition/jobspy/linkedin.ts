/**
 * Adapted from ts-jobspy (Copyright 2025-2026 Alpha Romer Coma),
 * JobSpy (Copyright 2023 Cullen Watson, Zachary Hampton), and
 * linkedin-jobs-scraper (Copyright 2023 llpujol), licensed under MIT.
 * See THIRD_PARTY_NOTICES.md for complete license texts.
 */
import type { AxiosInstance, AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import { abortableDelay, throwIfCancelled } from "../../pipelineCancellation";
import { createLogger } from "../../utils";
import type { CanonicalAcquiredJob } from "../types";
import { createJobSpySession } from "./http";
import {
	LINKEDIN_HEADERS,
	extractJobIdFromUrl,
	isExplicitlyNonRemote,
	isLinkedInRemote,
	jobTypeCode,
	parseSalaryInfo,
} from "./linkedinUtil";

const logger = createLogger("LinkedInSearch");

export interface AcquireLinkedInOptions {
	searchTerm: string;
	location?: string;
	distance?: number;
	resultsWanted: number;
	hoursOld?: number;
	isRemote?: boolean;
	jobType?: string;
	easyApply?: boolean;
	offset?: number;
	country?: string;
	proxies?: string[];
	userAgent?: string;
	pageDelayMs?: number;
	signal?: AbortSignal;
	showFetchUrl?: boolean;
	onProgress?: (progress: {
		page: number;
		fetched: number;
		cumulative: number;
	}) => void;
}

export async function acquireLinkedInJobs(
	options: AcquireLinkedInOptions,
): Promise<CanonicalAcquiredJob[]> {
	const showFetchUrl = Boolean(
		options.showFetchUrl || process.env.ASTROEX_SHOW_FETCH_URL === "1",
	);
	const session: AxiosInstance = createJobSpySession({
		proxies: options.proxies,
		userAgent: options.userAgent,
		hasRetry: true,
		retryDelaySeconds: 3,
	});

	const customHeaders = {
		...LINKEDIN_HEADERS,
		...(options.userAgent ? { "user-agent": options.userAgent } : {}),
	};

	const jobs: CanonicalAcquiredJob[] = [];
	const seenIds = new Set<string>();
	const offset = options.offset ?? 0;
	let start = Math.floor(offset / 10) * 10;
	const skip = offset - start;
	const resultsWanted = options.resultsWanted ?? 25;
	const targetCount = resultsWanted + skip;
	let pageNum = 0;
	const delayMs = options.pageDelayMs ?? 1000;

	const continueSearch = () => jobs.length < targetCount && start < 1000;

	while (continueSearch()) {
		throwIfCancelled(options.signal);
		pageNum += 1;

		const params: Record<string, string | number | undefined> = {
			keywords: options.searchTerm,
			location: options.location,
			distance: options.location ? options.distance : undefined,
			f_WT: options.isRemote ? 2 : undefined,
			f_JT: jobTypeCode(options.jobType) || undefined,
			pageNum: 0,
			start,
			f_AL: options.easyApply ? "true" : undefined,
			f_TPR: options.hoursOld ? `r${options.hoursOld * 3600}` : undefined,
		};

		const filteredParams = Object.fromEntries(
			Object.entries(params).filter(
				([_, v]) => v !== undefined && v !== null && v !== "",
			),
		);

		const searchUrl = session.getUri({
			url: "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
			params: filteredParams,
		});
		if (showFetchUrl) {
			logger.info(`[search][linkedin] Fetching: ${searchUrl}`);
		}

		let response: AxiosResponse<string>;
		try {
			response = await session.get<string>(
				"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
				{
					params: filteredParams,
					headers: customHeaders,
					timeout: 15_000,
					signal: options.signal,
				},
			);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				`LinkedIn search request failed on page ${pageNum}: ${message}`,
				{
					page: pageNum,
					error: message,
				},
			);
			if (jobs.length === 0) throw error;
			break;
		}

		if (response.status < 200 || response.status >= 400) {
			const errorMsg = `LinkedIn responded with HTTP ${response.status}`;
			logger.warn(errorMsg, { status: response.status, page: pageNum });
			if (jobs.length === 0) throw new Error(errorMsg);
			break;
		}

		const $ = cheerio.load(response.data);
		const jobCards = $("div.base-search-card, li.base-search-card").toArray();

		if (jobCards.length === 0) {
			logger.debug(
				`[search][linkedin] No job cards found on page ${pageNum}, ending search.`,
			);
			break;
		}

		let pageFetched = 0;
		let newCardsOnPage = 0;
		for (const cardElement of jobCards) {
			const card = $(cardElement);
			const linkTag = card.find("a.base-card__full-link").first();
			const href = linkTag.attr("href") ?? "";
			const jobId = extractJobIdFromUrl(href);

			if (!jobId || seenIds.has(jobId)) {
				continue;
			}
			seenIds.add(jobId);
			newCardsOnPage += 1;

			const titleTag = card
				.find("span.sr-only, h3.base-search-card__title")
				.first();
			const title = titleTag.text().trim() || "Untitled";

			const subtitleTag = card.find("h4.base-search-card__subtitle").first();
			const companyATag = subtitleTag.find("a").first();
			let companyUrl: string | undefined;
			const companyHref = companyATag.attr("href");
			if (companyHref) {
				try {
					const urlObj = new URL(companyHref);
					urlObj.search = "";
					companyUrl = urlObj.href;
				} catch {
					companyUrl = undefined;
				}
			}
			const company =
				(companyATag.length ? companyATag.text() : subtitleTag.text()).trim() ||
				"Unknown";

			const locationTag = card.find("span.job-search-card__location").first();
			const location = locationTag.text().trim() || undefined;

			let datePosted: Date | null = null;
			let datetimeTag = card.find("time.job-search-card__listdate").first();
			if (!datetimeTag.length) {
				datetimeTag = card.find("time.job-search-card__listdate--new").first();
			}
			const datetimeAttr = datetimeTag.attr("datetime");
			if (datetimeAttr) {
				const parsedDate = new Date(datetimeAttr);
				if (!Number.isNaN(parsedDate.getTime())) {
					datePosted = parsedDate;
				}
			}

			const salaryTag = card.find("span.job-search-card__salary-info").first();
			const compensation = salaryTag.length
				? parseSalaryInfo(salaryTag.text().trim())
				: undefined;

			const logoImg = card.find("img.artdeco-entity-image").first();
			const companyLogo =
				logoImg.attr("data-delayed-url") ||
				logoImg.attr("data-ghost-url") ||
				logoImg.attr("src") ||
				undefined;

			let isRemote = false;
			if (options.isRemote) {
				// Query was requested with f_WT=2 (remote filter on LinkedIn).
				// Defense-in-depth: skip if the title or location explicitly indicates on-site work.
				if (isExplicitlyNonRemote(title, location)) {
					continue;
				}
				isRemote = true;
			} else {
				isRemote = isLinkedInRemote(title, undefined, location);
			}

			jobs.push({
				id: `linkedin:${jobId}`,
				source: "linkedin",
				sourceJobId: jobId,
				canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
				title,
				company,
				companyUrl,
				location,
				postedAt: datePosted ? datePosted.toISOString() : undefined,
				description: undefined,
				descriptionRepresentation: "unknown",
				isRemote,
				compensation,
				companyLogo,
				acquiredAt: new Date().toISOString(),
			});
			pageFetched += 1;

			if (!continueSearch()) {
				break;
			}
		}

		logger.info(
			showFetchUrl
				? `[search][linkedin] page=${pageNum} fetched=${pageFetched} cumulative=${jobs.length} url=${searchUrl}`
				: `[search][linkedin] page=${pageNum} fetched=${pageFetched} cumulative=${jobs.length}`,
			showFetchUrl
				? {
						page: pageNum,
						fetched: pageFetched,
						cumulative: jobs.length,
						url: searchUrl,
					}
				: {
						page: pageNum,
						fetched: pageFetched,
						cumulative: jobs.length,
					},
		);

		if (options.onProgress) {
			options.onProgress({
				page: pageNum,
				fetched: pageFetched,
				cumulative: jobs.length,
			});
		}

		if (newCardsOnPage === 0 && jobCards.length > 0) {
			logger.debug(
				`[search][linkedin] All cards on page ${pageNum} were already seen; ending search.`,
			);
			break;
		}

		if (continueSearch()) {
			start += jobCards.length;
			if (delayMs > 0) {
				const jitter = Math.floor(Math.random() * 500);
				await abortableDelay(delayMs + jitter, options.signal);
			}
		}
	}

	return jobs.slice(skip, skip + resultsWanted);
}
