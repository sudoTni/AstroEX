import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Argv } from "yargs";
import { JOB_DB_RETENTION_MS } from "../constants";
import { JobRepository } from "../jobRepository";
import { loadPresets } from "../presets";
import {
	getDataDirectory,
	getLogsDirectory,
	getMaterialsDirectory,
	getProfileDirectory,
} from "../runtimePaths";
import type { GlobalArgs } from "../types";

export interface PreflightOptions {
	nodeVersionRequired?: string;
	requireApiKey?: boolean;
	apiKey?: string;
	requireIndeedApiKey?: boolean;
	indeedApiKey?: string;
	checkDeployment?: boolean;
	deploymentDestination?: string;
	selectedPresets?: string[];
	requiredProfileFiles?: string[];
	checkWritableDirectories?: boolean;
}

export interface PreflightResult {
	node: string;
	nodeValid: boolean;
	profileDirectory: string;
	missingProfileFiles: string[];
	writableDirectories: Record<string, boolean>;
	presets: string[];
	selectedPresetsValid: boolean;
	missingSelectedPresets: string[];
	apiKeyPresent: boolean;
	indeedApiKeyPresent: boolean;
	deployment: {
		enabled: boolean;
		destinationSet: boolean;
		rcloneAvailable: boolean;
		valid: boolean;
	};
	repository: ReturnType<JobRepository["verifyIntegrity"]>;
	valid: boolean;
	errors: string[];
}

export function isNodeVersionAtLeast(
	current: string,
	required = "22.13.0",
): boolean {
	const currentParts = current
		.replace(/^v/, "")
		.split(".")
		.map((n) => Number.parseInt(n, 10) || 0);
	const requiredParts = required
		.replace(/^v/, "")
		.split(".")
		.map((n) => Number.parseInt(n, 10) || 0);

	for (let i = 0; i < 3; i++) {
		const cur = currentParts[i] ?? 0;
		const req = requiredParts[i] ?? 0;
		if (cur > req) return true;
		if (cur < req) return false;
	}
	return true;
}

async function verifyDirectoryWritable(dir: string): Promise<boolean> {
	try {
		await fs.mkdir(dir, { recursive: true });
		const probeFile = path.join(
			dir,
			`.probe_preflight_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`,
		);
		await fs.writeFile(probeFile, "probe", { mode: 0o600 });
		await fs.unlink(probeFile);
		return true;
	} catch {
		return false;
	}
}

function checkRcloneAvailable(): boolean {
	try {
		execFileSync("rclone", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export async function runPreflight(
	options: PreflightOptions = {},
): Promise<PreflightResult> {
	const errors: string[] = [];

	// 1. Node version
	const requiredNodeVersion = options.nodeVersionRequired ?? "22.13.0";
	const currentNodeVersion = process.versions.node;
	const nodeValid = isNodeVersionAtLeast(
		currentNodeVersion,
		requiredNodeVersion,
	);
	if (!nodeValid) {
		errors.push(
			`Node.js version ${currentNodeVersion} is below required minimum ${requiredNodeVersion}`,
		);
	}

	// 2. Profile files
	const requiredProfileFiles = options.requiredProfileFiles ?? [
		"search_terms.txt",
		"my_resume.txt",
	];
	const missingProfileFiles = (
		await Promise.all(
			requiredProfileFiles.map(async (file) => {
				try {
					const filePath = path.join(getProfileDirectory(), file);
					const stat = await fs.stat(filePath);
					if (stat.size === 0) return file;
					return undefined;
				} catch {
					return file;
				}
			}),
		)
	).filter((file): file is string => !!file);

	if (missingProfileFiles.length > 0) {
		errors.push(
			`Missing or empty required profile files: ${missingProfileFiles.join(", ")} in ${getProfileDirectory()}`,
		);
	}

	// 3. Writable runtime directories
	const dirsToCheck = [
		{ name: "data", path: getDataDirectory() },
		{ name: "logs", path: getLogsDirectory() },
		{ name: "materials", path: getMaterialsDirectory() },
	];
	const writableDirectories: Record<string, boolean> = {};

	await Promise.all(
		dirsToCheck.map(async ({ name, path: dirPath }) => {
			const isWritable = await verifyDirectoryWritable(dirPath);
			writableDirectories[name] = isWritable;
			if (!isWritable) {
				errors.push(`Directory is not writable: ${dirPath} (${name})`);
			}
		}),
	);

	// 4. Presets validation
	const presetsData = await loadPresets();
	const topLevelPresetCategories = Object.keys(presetsData);
	const allAvailablePresetNames = new Set<string>();
	for (const category of Object.values(presetsData)) {
		for (const presetName of Object.keys(category)) {
			allAvailablePresetNames.add(presetName);
		}
	}

	const missingSelectedPresets: string[] = [];
	if (options.selectedPresets && options.selectedPresets.length > 0) {
		for (const presetName of options.selectedPresets) {
			if (!allAvailablePresetNames.has(presetName)) {
				missingSelectedPresets.push(presetName);
			}
		}
		if (missingSelectedPresets.length > 0) {
			errors.push(
				`Selected presets not found in config/presets.json: ${missingSelectedPresets.join(", ")}`,
			);
		}
	}

	// 5. API Key validation
	const apiKey =
		options.apiKey || process.env.AEX_OR_API_KEY || process.env.OPENAI_API_KEY;
	const apiKeyPresent = Boolean(apiKey && apiKey.trim().length > 0);
	if (options.requireApiKey && !apiKeyPresent) {
		errors.push(
			"Missing required API key. Set AEX_OR_API_KEY or OPENAI_API_KEY in the environment or provide --api-key.",
		);
	}
	const indeedApiKey =
		options.indeedApiKey || process.env.ASTROEX_INDEED_API_KEY;
	const indeedApiKeyPresent = Boolean(
		indeedApiKey && indeedApiKey.trim().length > 0,
	);
	if (options.requireIndeedApiKey && !indeedApiKeyPresent) {
		errors.push(
			"Missing required Indeed client key. Set ASTROEX_INDEED_API_KEY in the environment.",
		);
	}

	// 6. Deployment prerequisites
	const checkDeployment =
		options.checkDeployment ?? process.env.AEX_DEPLOY === "1";
	const destination =
		options.deploymentDestination || process.env.AEX_DEPLOY_DESTINATION;
	const destinationSet = Boolean(destination && destination.trim().length > 0);
	let rcloneAvailable = false;

	if (checkDeployment) {
		rcloneAvailable = checkRcloneAvailable();
		if (!destinationSet) {
			errors.push(
				"Deployment is enabled (AEX_DEPLOY=1) but AEX_DEPLOY_DESTINATION is not set.",
			);
		}
		if (!rcloneAvailable) {
			errors.push(
				"Deployment is enabled (AEX_DEPLOY=1) but 'rclone' executable was not found in PATH.",
			);
		}
	}

	// 7. SQLite integrity
	const repository = new JobRepository({
		dbFilePath: path.join(getDataDirectory(), "jobDB.sqlite"),
		defaultExpirationMs: JOB_DB_RETENTION_MS,
		enableJobDB: true,
	});
	await repository.initialize();
	let repoIntegrity: ReturnType<JobRepository["verifyIntegrity"]>;
	try {
		repoIntegrity = repository.verifyIntegrity();
		if (repoIntegrity.integrity !== "ok") {
			errors.push(
				`SQLite database integrity check failed: ${repoIntegrity.details}`,
			);
		}
	} finally {
		await repository.close();
	}

	const valid = errors.length === 0;

	return {
		node: currentNodeVersion,
		nodeValid,
		profileDirectory: getProfileDirectory(),
		missingProfileFiles,
		writableDirectories,
		presets: topLevelPresetCategories,
		selectedPresetsValid: missingSelectedPresets.length === 0,
		missingSelectedPresets,
		apiKeyPresent,
		indeedApiKeyPresent,
		deployment: {
			enabled: checkDeployment,
			destinationSet,
			rcloneAvailable,
			valid: !checkDeployment || (destinationSet && rcloneAvailable),
		},
		repository: repoIntegrity,
		valid,
		errors,
	};
}

export async function assertPreflight(
	options: PreflightOptions = {},
): Promise<PreflightResult> {
	const result = await runPreflight(options);
	if (!result.valid) {
		throw new Error(
			`Pipeline preflight failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}
	return result;
}

export function addPreflightCommand(yargs: Argv<GlobalArgs>): Argv<GlobalArgs> {
	return yargs.command(
		"preflight",
		"Validate pipeline prerequisites without network calls.",
		(cmd) =>
			cmd
				.option("presets", {
					type: "string",
					description: "Comma-separated list of presets to validate.",
				})
				.option("require-api-key", {
					type: "boolean",
					description: "Enforce API key presence check.",
					default: false,
				})
				.option("require-indeed-api-key", {
					type: "boolean",
					description: "Enforce Indeed client-key presence check.",
					default: false,
				})
				.option("check-deployment", {
					type: "boolean",
					description: "Enforce deployment prerequisites check.",
					default: false,
				}),
		async (argv) => {
			const selectedPresets = argv.presets
				? String(argv.presets)
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;

			const result = await runPreflight({
				selectedPresets,
				requireApiKey: Boolean(argv["require-api-key"]),
				requireIndeedApiKey: Boolean(argv["require-indeed-api-key"]),
				checkDeployment:
					Boolean(argv["check-deployment"]) || process.env.AEX_DEPLOY === "1",
			});

			console.log(JSON.stringify(result, null, 2));
			if (!result.valid) {
				process.exitCode = 1;
			}
		},
	);
}
