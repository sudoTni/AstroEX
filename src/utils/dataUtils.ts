/**
 * Data Processing Utilities
 * 
 * Provides utility functions for data transformation, validation,
 and processing operations used across the application.
 * 
 * Features:
 * - Data normalization and cleaning
 * - Duplicate detection and removal
 * - Data validation and filtering
 * - Performance-optimized data operations
 * 
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import { AppError } from "../utils";

/**
 * Normalize job data to ensure consistent structure
 */
export function normalizeJobData(jobData: any): any {
	if (!jobData) {
		throw new AppError("INVALID_JOB_DATA", 400, "Job data is required");
	}

	return {
		id: String(jobData.id || jobData.jobId || generateJobId()),
		title: String(jobData.title || jobData.jobTitle || "").trim(),
		company: String(jobData.company || jobData.companyName || "").trim(),
		location: String(jobData.location || jobData.jobLocation || "").trim(),
		descriptionText: String(
			jobData.descriptionText ||
				jobData.description ||
				jobData.jobDescription ||
				"",
		).trim(),
		descriptionHtml: String(
			jobData.descriptionHtml || jobData.htmlDescription || "",
		).trim(),
		url: String(jobData.url || jobData.jobUrl || jobData.applyUrl || "").trim(),
		postedDate: String(
			jobData.postedDate || jobData.datePosted || new Date().toISOString(),
		),
		salary: jobData.salary ? String(jobData.salary) : undefined,
		salaryCurrency: jobData.salaryCurrency
			? String(jobData.salaryCurrency)
			: undefined,
		jobType: jobData.jobType ? String(jobData.jobType) : undefined,
		experienceLevel: jobData.experienceLevel
			? String(jobData.experienceLevel)
			: undefined,
		estimatedSalary: jobData.estimatedSalary
			? {
					min: Number(jobData.estimatedSalary.min),
					max: Number(jobData.estimatedSalary.max),
					currency: String(jobData.estimatedSalary.currency || "USD"),
				}
			: undefined,
		metadata: {
			source: String(jobData.metadata?.source || "unknown"),
			scrapedAt: String(
				jobData.metadata?.scrapedAt || new Date().toISOString(),
			),
			confidence: Number(jobData.metadata?.confidence || 1.0),
			...jobData.metadata,
		},
		confidence: jobData.confidence ? Number(jobData.confidence) : undefined,
		isVeryHighlyAligned: jobData.isVeryHighlyAligned
			? Boolean(jobData.isVeryHighlyAligned)
			: undefined,
		rationale: jobData.rationale ? String(jobData.rationale) : undefined,
	};
}

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
	return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Remove duplicate jobs based on multiple strategies
 */
export function removeDuplicates(
	jobs: any[],
	strategy: "exact" | "fuzzy" | "url" = "url",
): any[] {
	if (!Array.isArray(jobs)) {
		throw new AppError("INVALID_INPUT", 400, "Jobs must be an array");
	}

	const seen = new Set();
	const uniqueJobs: any[] = [];

	for (const job of jobs) {
		try {
			const normalizedJob = normalizeJobData(job);
			const duplicateKey = getDuplicateKey(normalizedJob, strategy);

			if (!seen.has(duplicateKey)) {
				seen.add(duplicateKey);
				uniqueJobs.push(normalizedJob);
			}
		} catch (error) {
			// Skip invalid job entries but log the error
			console.warn("Skipping invalid job entry:", error);
		}
	}

	return uniqueJobs;
}

/**
 * Get duplicate key based on strategy
 */
function getDuplicateKey(job: any, strategy: string): string {
	switch (strategy) {
		case "exact":
			return `${job.title}|${job.company}|${job.location}|${job.url}`;
		case "fuzzy":
			return `${job.title.toLowerCase().replace(/\s+/g, "_")}_${job.company.toLowerCase().replace(/\s+/g, "_")}`;
		default:
			return job.url || `${job.title}_${job.company}`;
	}
}

/**
 * Filter jobs by company and title
 */
export function filterJobs(
	jobs: any[],
	companyFilters?: string[],
	titleFilters?: string[],
	excludeCompanies?: string[],
	excludeTitles?: string[],
): any[] {
	if (!Array.isArray(jobs)) {
		throw new AppError("INVALID_INPUT", 400, "Jobs must be an array");
	}

	return jobs.filter((job) => {
		try {
			const normalizedJob = normalizeJobData(job);

			// Check exclusion filters first
			if (
				excludeCompanies?.some((company) =>
					normalizedJob.company.toLowerCase().includes(company.toLowerCase()),
				)
			) {
				return false;
			}

			if (
				excludeTitles?.some((title) =>
					normalizedJob.title.toLowerCase().includes(title.toLowerCase()),
				)
			) {
				return false;
			}

			// Check inclusion filters
			if (companyFilters && companyFilters.length > 0) {
				const companyMatch = companyFilters.some((company) =>
					normalizedJob.company.toLowerCase().includes(company.toLowerCase()),
				);
				if (!companyMatch) {
					return false;
				}
			}

			if (titleFilters && titleFilters.length > 0) {
				const titleMatch = titleFilters.some((title) =>
					normalizedJob.title.toLowerCase().includes(title.toLowerCase()),
				);
				if (!titleMatch) {
					return false;
				}
			}

			return true;
		} catch (error) {
			console.warn("Skipping invalid job during filtering:", error);
			return false;
		}
	});
}

/**
 * Validate job data structure
 */
export function validateJobData(jobData: any): {
	isValid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!jobData) {
		errors.push("Job data is required");
		return { isValid: false, errors };
	}

	const requiredFields = ["title", "company", "descriptionText", "url"];

	for (const field of requiredFields) {
		if (!jobData[field] || String(jobData[field]).trim() === "") {
			errors.push(`${field} is required`);
		}
	}

	// Validate URL format
	if (jobData.url) {
		try {
			new URL(jobData.url);
		} catch {
			errors.push("Invalid URL format");
		}
	}

	// Validate date format
	if (jobData.postedDate) {
		const date = new Date(jobData.postedDate);
		if (Number.isNaN(date.getTime())) {
			errors.push("Invalid date format");
		}
	}

	return {
		isValid: errors.length === 0,
		errors,
	};
}

/**
 * Clean and sanitize job descriptions
 */
export function cleanJobDescription(description: string): string {
	if (!description || typeof description !== "string") {
		return "";
	}

	return description
		.replace(/\s+/g, " ") // Replace multiple spaces with single space
		.replace(/\n\s*\n/g, "\n\n") // Preserve paragraph breaks
		.replace(/[^\w\s\-.,;:!?()"'[\]{}]/g, "") // Remove special characters but keep basic punctuation
		.trim();
}

/**
 * Extract salary information from text
 */
export function extractSalaryFromText(text: string): {
	min?: number;
	max?: number;
	currency?: string;
} {
	const salaryPattern =
		/(\d+(?:,\d+)?)(?:\s*-\s*(\d+(?:,\d+)?))?\s*(?:k|K|k\$|K\$|\$|USD|EUR|GBP|CAD|AUD)?/gi;
	const matches = [...text.matchAll(salaryPattern)];

	if (matches.length === 0) {
		return {};
	}

	const salaries = matches.map((match) => {
		const min = parseInt(match[1].replace(",", ""), 10);
		const max = match[2] ? parseInt(match[2].replace(",", ""), 10) : min;
		return { min, max };
	});

	// Calculate average min and max
	const avgMin = Math.round(
		salaries.reduce((sum, s) => sum + s.min, 0) / salaries.length,
	);
	const avgMax = Math.round(
		salaries.reduce((sum, s) => sum + s.max, 0) / salaries.length,
	);

	return {
		min: avgMin,
		max: avgMax,
		currency: "USD", // Default currency
	};
}

/**
 * Calculate job similarity score
 */
export function calculateJobSimilarity(job1: any, job2: any): number {
	const normalized1 = normalizeJobData(job1);
	const normalized2 = normalizeJobData(job2);

	let score = 0;

	// Title similarity (40% weight)
	const titleSimilarity = calculateStringSimilarity(
		normalized1.title,
		normalized2.title,
	);
	score += titleSimilarity * 0.4;

	// Company similarity (30% weight)
	const companySimilarity = calculateStringSimilarity(
		normalized1.company,
		normalized2.company,
	);
	score += companySimilarity * 0.3;

	// Location similarity (20% weight)
	const locationSimilarity = calculateStringSimilarity(
		normalized1.location,
		normalized2.location,
	);
	score += locationSimilarity * 0.2;

	// URL similarity (10% weight)
	const urlSimilarity = normalized1.url === normalized2.url ? 1 : 0;
	score += urlSimilarity * 0.1;

	return Math.round(score * 100) / 100;
}

/**
 * Calculate string similarity using simple algorithm
 */
function calculateStringSimilarity(str1: string, str2: string): number {
	if (!str1 || !str2) return 0;

	const longer = str1.length > str2.length ? str1 : str2;
	const shorter = str1.length > str2.length ? str2 : str1;

	if (longer.length === 0) return 1;

	const editDistance = levenshteinDistance(longer, shorter);
	return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance
 */
function levenshteinDistance(str1: string, str2: string): number {
	const matrix = Array(str2.length + 1)
		.fill(null)
		.map(() => Array(str1.length + 1).fill(null));

	for (let i = 0; i <= str1.length; i += 1) matrix[0][i] = i;
	for (let j = 0; j <= str2.length; j += 1) matrix[j][0] = j;

	for (let j = 1; j <= str2.length; j += 1) {
		for (let i = 1; i <= str1.length; i += 1) {
			const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1, // deletion
				matrix[j - 1][i] + 1, // insertion
				matrix[j - 1][i - 1] + indicator, // substitution
			);
		}
	}

	return matrix[str2.length][str1.length];
}

/**
 * Batch process jobs with error handling
 */
export async function batchProcessJobs(
	jobs: any[],
	processor: (job: any) => Promise<any>,
	batchSize: number = 10,
	delay: number = 100,
): Promise<any[]> {
	if (!Array.isArray(jobs)) {
		throw new AppError("INVALID_INPUT", 400, "Jobs must be an array");
	}

	const results: any[] = [];

	for (let i = 0; i < jobs.length; i += batchSize) {
		const batch = jobs.slice(i, i + batchSize);

		try {
			const batchResults = await Promise.all(
				batch.map((job) =>
					processor(job).catch((error) => {
						console.warn("Error processing job:", error);
						return null;
					}),
				),
			);

			results.push(...batchResults.filter((result) => result !== null));

			// Add delay between batches to avoid rate limiting
			if (i + batchSize < jobs.length) {
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		} catch (error) {
			console.error("Error processing batch:", error);
			throw new AppError(
				"BATCH_PROCESSING_ERROR",
				500,
				"Failed to process job batch",
				{ error },
			);
		}
	}

	return results;
}
