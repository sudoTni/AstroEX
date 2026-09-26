/**
 * AstroEX - Production-ready Indeed job acquisition, filtering, and evaluation tool
 * Version 0.1326.0
 *
 * This is the main entry point for the AstroEX application.
 * It sets up the CLI interface using yargs and registers all commands.
 *
 * Features:
 * - Indeed job acquisition with source-aware normalization
 * - AI-powered job evaluation using multiple providers (OpenAI, Gemini, Mistral)
 * - Resume optimization processes (ROP) with multiple modes
 * - Job description distillation and compatibility analysis (JDD)
 * - Comprehensive error handling and logging
 * - Batch processing for API efficiency
 * - Externalized configuration and prompts
 * - Security-focused input validation and sanitization
 * - Performance monitoring and optimization
 * - Centralized LLM service with circuit breaker patterns
 * - Enterprise-grade security and observability
 * - Production deployment ready with comprehensive documentation
 *
 * @author tjenkel
 * @contributors llpujol
 * @license MIT
 */

import * as fs from "node:fs";
import yargs, { type Argv } from "yargs";
import {
	addAcquireJobsCommand,
	addArtifactCommand,
	addEnrichJobsCommand,
	addJobClothCommand,
	addJobDbCommand,
	addJobJudgeCommand,
	addMakeMaterialsCommands,
	addPreflightCommand,
	addProcessDataCommand,
	addRunPipelineCommand,
} from "./commands";
import { getAvailablePresets, loadPresets } from "./presets";
import { getDataDirectory, getLogsDirectory } from "./runtimePaths";
import type { GlobalArgs } from "./types";
import {
	closeExecutionLog,
	configureLogging,
	initializeExecutionLog,
	isColorSupported,
	printBanner,
} from "./utils";

// Global --no-color CLI option for all commands
// Global --verbose CLI option (default: false)
let ASTROEX_VERBOSE = false;
if (process.argv.includes("--verbose") || process.argv.includes("-v")) {
	ASTROEX_VERBOSE = true;
} else if (
	process.argv.includes("--no-verbose") ||
	process.argv.includes("--quiet")
) {
	ASTROEX_VERBOSE = false;
}
process.env.ASTROEX_VERBOSE = ASTROEX_VERBOSE ? "1" : "0";
if (
	process.argv.includes("--hide-reasoning") ||
	process.argv.includes("--hide-reasoning-tokens") ||
	process.argv.includes("--hr") ||
	process.argv.includes("--no-show-reasoning")
) {
	process.env.ASTROEX_HIDE_REASONING = "1";
}
if (
	process.argv.includes("--no-color") ||
	process.argv.includes("--no-colors") ||
	process.argv.includes("--color=false") ||
	process.argv.includes("--color=0")
) {
	process.env.ASTROEX_NO_COLOR = "1";
} else if (
	process.argv.includes("--color") ||
	process.argv.includes("--color=true") ||
	process.argv.includes("--color=1")
) {
	process.env.ASTROEX_NO_COLOR = "0";
}
if (process.argv.includes("--show-fetch-url")) {
	process.env.ASTROEX_SHOW_FETCH_URL = "1";
}
const logLevelIndex = process.argv.indexOf("--log-level");
const requestedLogLevel =
	process.argv
		.find((argument) => argument.startsWith("--log-level="))
		?.split("=", 2)[1] ??
	(logLevelIndex >= 0 ? process.argv[logLevelIndex + 1] : undefined);
if (
	["trace", "debug", "info", "success", "warn", "error", "fatal"].includes(
		requestedLogLevel ?? "",
	)
) {
	process.env.ASTROEX_LOG_LEVEL = requestedLogLevel;
}
const logFormatIndex = process.argv.indexOf("--log-format");
const requestedLogFormat =
	process.argv
		.find((argument) => argument.startsWith("--log-format="))
		?.split("=", 2)[1] ??
	(logFormatIndex >= 0 ? process.argv[logFormatIndex + 1] : undefined);
if (requestedLogFormat === "json" || requestedLogFormat === "pretty") {
	process.env.ASTROEX_LOG_FORMAT = requestedLogFormat;
}
if (process.argv.includes("--json")) {
	process.env.ASTROEX_VERBOSE = "0";
	process.env.ASTROEX_LOG_LEVEL = "error";
}

configureLogging({
	format:
		process.argv.includes("--json") || process.env.ASTROEX_LOG_FORMAT === "json"
			? "json"
			: "pretty",
	useColor: isColorSupported(),
});

initializeExecutionLog(getLogsDirectory(), process.argv.slice(2));
process.once("exit", closeExecutionLog);

// Operational commands may request machine-readable output without decoration.
const suppressBanner =
	process.argv.includes("--no-banner") || process.argv.includes("--json");
if (!suppressBanner) {
	printBanner(isColorSupported());
}

const dataDirectory = getDataDirectory();

// Ensure data directory exists
fs.mkdirSync(dataDirectory, { recursive: true });

(async () => {
	const allPresets = await loadPresets();
	const jobClothPresets = getAvailablePresets("jobCloth", allPresets);
	const jobJudgePresets = getAvailablePresets("jobJudge", allPresets); // Pre-load jobJudge presets
	const makeMaterialsPresets = getAvailablePresets("makeMaterials", allPresets);

	let yargsInstance = yargs(process.argv.slice(2)) as Argv<GlobalArgs>;

	yargsInstance = yargsInstance
		.option("no-banner", {
			type: "boolean",
			description: "Suppress the startup banner.",
			default: false,
		})
		.option("color", {
			type: "boolean",
			description:
				"Enable or disable ANSI colors and gradient formatting (negate with --no-color).",
		})
		.option("json", {
			type: "boolean",
			description: "Request machine-oriented command output when supported.",
			default: false,
		})
		.option("log-level", {
			type: "string",
			choices: [
				"trace",
				"debug",
				"info",
				"success",
				"warn",
				"error",
				"fatal",
			] as const,
			description:
				"Minimum event severity to emit. Defaults to debug unless --no-verbose is supplied.",
		})
		.option("log-format", {
			type: "string",
			choices: ["pretty", "json"] as const,
			description: "Format for terminal log output (pretty or json).",
			default: "pretty",
		})
		.option("show-fetch-url", {
			type: "boolean",
			description: "Display Indeed and LinkedIn fetch URLs in console output.",
			default: false,
		});

	// Add commands using the functions
	yargsInstance = addAcquireJobsCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addArtifactCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addProcessDataCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addPreflightCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addJobClothCommand(
		yargsInstance as Argv<GlobalArgs>,
		jobClothPresets,
	);
	yargsInstance = addJobJudgeCommand(
		yargsInstance as Argv<GlobalArgs>,
		jobJudgePresets,
	); // Pass jobJudge presets
	yargsInstance = addJobDbCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addMakeMaterialsCommands(
		yargsInstance as Argv<GlobalArgs>,
		makeMaterialsPresets,
	);
	yargsInstance = addEnrichJobsCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addRunPipelineCommand(yargsInstance as Argv<GlobalArgs>);

	const parser = yargsInstance
		.demandCommand(1, "You need at least one command before moving on")
		.epilogue(
			"Exit Codes:\n  0  Success / Completed stage\n  1  Operational error (configuration, missing file, LLM API error)\n  2  Invalid CLI arguments or unknown subcommand",
		)
		.help() as unknown as { parseAsync(): Promise<unknown> };
	await parser.parseAsync();
})();

// If no command is provided, yargs will show the help message due to .demandCommand(1)
