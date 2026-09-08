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
