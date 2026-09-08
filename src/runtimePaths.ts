import * as path from "node:path";

/**
 * Resolves filesystem locations once for every command-line workflow.
 * Environment overrides are intentionally resolved from the invoking shell so
 * that private profiles and mutable job data can live outside the package.
 */
function configuredDirectory(variable: string, fallback: string): string {
	const configured = process.env[variable]?.trim();
	return configured
		? path.resolve(process.cwd(), configured)
		: path.resolve(__dirname, "..", fallback);
}

export function getProjectDirectory(): string {
	return path.resolve(__dirname, "..");
}

export function getDataDirectory(): string {
	return configuredDirectory("ASTROEX_DATA_DIR", "data");
}

export function getProfileDirectory(): string {
	return configuredDirectory("ASTROEX_PROFILE_DIR", "profile");
}

export function getLogsDirectory(): string {
	return configuredDirectory("ASTROEX_LOG_DIR", "logs");
}

export function getMaterialsDirectory(): string {
	return configuredDirectory("ASTROEX_MATERIALS_DIR", "materials");
}

export function getProfileFile(fileName: string): string {
	if (
		!/^[a-zA-Z0-9_.-]+\.(?:txt|json)$/.test(fileName) ||
		fileName.includes("..")
	) {
		throw new Error(`Invalid profile file name: ${fileName}`);
	}
	return path.join(getProfileDirectory(), fileName);
}
