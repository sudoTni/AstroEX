/**
 * Adapted from ts-jobspy (Copyright 2025-2026 Alpha Romer Coma) and
 * JobSpy (Copyright 2023 Cullen Watson, Zachary Hampton), licensed under MIT.
 * See THIRD_PARTY_NOTICES.md for complete license texts.
 */
import type { CanonicalCompensation } from "../types";

export const LINKEDIN_HEADERS: Record<string, string> = {
	authority: "www.linkedin.com",
	accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"accept-language": "en-US,en;q=0.9",
	"cache-control": "max-age=0",
	"upgrade-insecure-requests": "1",
	"user-agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/**
 * Maps common job type names to LinkedIn API search filter codes (f_JT).
 */
export function jobTypeCode(jobType?: string): string {
	if (!jobType) return "";
	const normalized = jobType.toLowerCase().replace(/[-_\s]/g, "");
	const mapping: Record<string, string> = {
		fulltime: "F",
		parttime: "P",
		internship: "I",
		contract: "C",
		temporary: "T",
	};
	return mapping[normalized] ?? "";
}

/**
 * Defense-in-depth remote check for LinkedIn postings based on title, description, and location.
 */
export function isLinkedInRemote(
	title?: string,
	description?: string | null,
	location?: string | null,
): boolean {
	const remoteKeywords = [
		/\bremote\b/i,
		/\bwork\s*from\s*home\b/i,
		/\bwfh\b/i,
		/\bvirtual\b/i,
		/\btelecommute\b/i,
	];
	const fullText = [title ?? "", description ?? "", location ?? ""].join(" ");
	return remoteKeywords.some((regex) => regex.test(fullText));
}

/**
 * Checks if a title or location explicitly indicates non-remote (on-site or in-office) work.
 */
export function isExplicitlyNonRemote(
	title?: string,
	location?: string | null,
): boolean {
	const text = `${title ?? ""} ${location ?? ""}`.toLowerCase();
	const nonRemoteKeywords = /\b(onsite|on-site|in-office|office based)\b/i;
	const remoteKeywords = /\b(remote|wfh|work from home)\b/i;
	return nonRemoteKeywords.test(text) && !remoteKeywords.test(text);
}

/**
 * Extract numeric job ID from a LinkedIn URL.
 * Matches patterns like /jobs/view/title-1234567890, /jobs/view/1234567890, or currentJobId=1234567890.
 */
export function extractJobIdFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const currentJobId = parsed.searchParams.get("currentJobId");
		if (currentJobId && /^\d+$/.test(currentJobId)) {
			return currentJobId;
		}
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		const viewIndex = pathParts.indexOf("view");
		if (viewIndex !== -1 && pathParts[viewIndex + 1]) {
			const segment = pathParts[viewIndex + 1];
			const match = segment.match(/(\d{6,})/);
			if (match) return match[1];
		}
		// Fallback match anywhere in pathname
		const anyMatch = parsed.pathname.match(/(\d{8,})/);
		if (anyMatch) return anyMatch[1];
	} catch {
		const match = url.match(/(\d{8,})/);
		if (match) return match[1];
	}
	return undefined;
}

export function parseSalaryInterval(
	text: string,
): CanonicalCompensation["interval"] {
	const lower = text.toLowerCase();
	if (/\b(?:yr|year|annually|annual|yearly)\b/.test(lower)) return "yearly";
	if (/\b(?:mo|month|monthly)\b/.test(lower)) return "monthly";
	if (/\b(?:wk|week|weekly)\b/.test(lower)) return "weekly";
	if (/\b(?:day|daily)\b/.test(lower)) return "daily";
	if (/\b(?:hr|hour|hourly)\b/.test(lower)) return "hourly";
	return undefined;
}

export function parseCurrencySymbol(text: string): string {
	if (text.includes("$")) return "USD";
	if (text.includes("€")) return "EUR";
	if (text.includes("£")) return "GBP";
	if (text.includes("₹")) return "INR";
	if (text.includes("C$")) return "CAD";
	if (text.includes("A$")) return "AUD";
	return "USD";
}

export function parseSalaryInfo(
	salaryText: string,
): CanonicalCompensation | undefined {
	if (!salaryText || typeof salaryText !== "string") return undefined;
	const parts = salaryText.split("-").map((part) => {
		const numStr = part.replace(/[^0-9.]/g, "");
		return Number.parseFloat(numStr);
	});

	if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
		return {
			minAmount: Math.floor(parts[0]),
			maxAmount: Math.floor(parts[1]),
			currency: parseCurrencySymbol(salaryText),
			interval: parseSalaryInterval(salaryText),
			source: "direct_data",
		};
	}
	if (parts.length === 1 && !Number.isNaN(parts[0])) {
		return {
			minAmount: Math.floor(parts[0]),
			maxAmount: Math.floor(parts[0]),
			currency: parseCurrencySymbol(salaryText),
			interval: parseSalaryInterval(salaryText),
			source: "direct_data",
		};
	}
	return undefined;
}
