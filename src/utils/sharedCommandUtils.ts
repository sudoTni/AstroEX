import * as fs from "node:fs";
import * as path from "node:path";
import { getProfileDirectory } from "../runtimePaths";
import { log } from "../utils";

/**
 * Load the applicant data needed by the job-evaluation pipeline. Missing
 * optional profile files retain the historical placeholder behavior so a
 * partial profile produces an explicit model-visible value rather than a
 * low-level filesystem failure.
 */
export async function loadApplicationData(): Promise<{
	resume: string;
	professionalTitle: string;
	professionalSummary: string;
	keySkills: string;
	testimonials: string;
}> {
	const files = [
		"my_resume.txt",
		"my_professional_title.txt",
		"my_professional_summary.txt",
		"my_key_skills.txt",
		"my_testimonials.txt",
	] as const;
	const profileDirectory = getProfileDirectory();
	const contents = await Promise.all(
		files.map(async (file) => {
			try {
				return await fs.promises.readFile(
					path.join(profileDirectory, file),
					"utf-8",
				);
			} catch {
				log(
					"ApplicationData",
					`Failed to load ${file}, using fallback`,
					"warn",
				);
				return `[${file
					.replace(/_/g, " ")
					.replace(/\.\w+$/, "")
					.toUpperCase()} content]`;
			}
		}),
	);
	const [
		resume,
		professionalTitle,
		professionalSummary,
		keySkills,
		testimonials,
	] = contents;
	return {
		resume,
		professionalTitle,
		professionalSummary,
		keySkills,
		testimonials,
	};
}

/**
 * Normalizes job evaluation object keys to handle model casing variations,
 * common key typos (such as jobTtitle), and common alias property names.
 */
export function normalizeJobAnalysisRecord(val: unknown): unknown {
	if (!val || typeof val !== "object" || Array.isArray(val)) return val;
	const obj = val as Record<string, unknown>;
	const normalized: Record<string, unknown> = { ...obj };

	// 1. Resolve jobTitle if missing or empty
	if (typeof normalized.jobTitle !== "string" || !normalized.jobTitle.trim()) {
		if (
			typeof normalized.job_title === "string" &&
			normalized.job_title.trim()
		) {
			normalized.jobTitle = normalized.job_title.trim();
		} else if (
			typeof normalized.title === "string" &&
			normalized.title.trim()
		) {
			normalized.jobTitle = normalized.title.trim();
		} else {
			for (const [key, value] of Object.entries(obj)) {
				if (typeof value !== "string" || !value.trim()) continue;
				const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
				if (
					normKey === "jobtitle" ||
					normKey === "jobttitle" ||
					normKey === "title" ||
					normKey === "jobname" ||
					normKey === "jobrole" ||
					normKey === "role" ||
					normKey === "position" ||
					normKey.endsWith("title")
				) {
					normalized.jobTitle = value.trim();
					break;
				}
			}
		}
	}

	// 2. Resolve alignment boolean if missing
	if (
		normalized.isWorthInvestigating === undefined &&
		normalized.isVeryHighlyAligned === undefined &&
		normalized.isHighlyAligned === undefined
	) {
		for (const [key, value] of Object.entries(obj)) {
			const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
			if (
				normKey === "isworthinvestigating" ||
				normKey === "worthinvestigating" ||
				normKey === "isveryhighlyaligned" ||
				normKey === "veryhighlyaligned" ||
				normKey === "ishighlyaligned" ||
				normKey === "highlyaligned" ||
				normKey === "isaligned" ||
				normKey === "aligned"
			) {
				normalized.isWorthInvestigating = value;
				break;
			}
		}
	}

	// 3. Resolve rationale if missing
	if (normalized.rationale === undefined) {
		for (const [key, value] of Object.entries(obj)) {
			const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
			if (
				normKey === "rationale" ||
				normKey === "reasoning" ||
				normKey === "reason" ||
				normKey === "explanation"
			) {
				normalized.rationale = value;
				break;
			}
		}
	}

	return normalized;
}
