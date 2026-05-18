/**
 * AstroEX - Production-ready LinkedIn job scraping, filtering, and evaluation tool
 * Version 3.1.3
 *
 * This is the main entry point for the AstroEX application.
 * It sets up the CLI interface using yargs and registers all commands.
 *
 * Features:
 * - LinkedIn job scraping with enhanced JSON-LD extraction
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

// Global --no-color CLI option for all commands
// Global --verbose CLI option (default: true)
let ASTROEX_VERBOSE = true;
if (process.argv.includes("--no-verbose") || process.argv.includes("--quiet")) {
	ASTROEX_VERBOSE = false;
} else if (process.argv.includes("--verbose") || process.argv.includes("-v")) {
	ASTROEX_VERBOSE = true;
}
process.env.ASTROEX_VERBOSE = ASTROEX_VERBOSE ? "1" : "0";
if (process.argv.includes("--no-color")) {
	process.env.ASTROEX_NO_COLOR = "1";
}

import { printBanner } from "./utils";

// Print vivid banner at startup
printBanner(!process.env.NO_COLOR && !process.env.ASTROEX_NO_COLOR);

// console.log('AstroEX application started.');

import * as fs from "node:fs";
import * as path from "node:path";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import {
	addEr44zzModesCommands,
	addJobClothCommand,
	addJobJudgeCommand,
	addMakeMaterialsCommands,
	addProcessDataCommand,
	addScrapeJobCommand,
	addScrapeJobsCommand,
	addScrapeSearchCommand,
} from "./commands"; // Import command functions from barrel file
import { getAvailablePresets, loadPresets } from "./presets"; // Import preset functions
import type { GlobalArgs } from "./types"; // Import GlobalArgs

const jobsDataFolder: string = `data`;
const rootDirectory = path.resolve(__dirname, "..");
const dataDirectory = path.join(rootDirectory, jobsDataFolder);
const defaultLogDirectory = path.join(rootDirectory, "logs"); // Default log directory

// Ensure data directory exists
fs.mkdirSync(dataDirectory, { recursive: true });

(async () => {
	const allPresets = await loadPresets();
	const jobClothPresets = getAvailablePresets("jobCloth", allPresets);
	const jobJudgePresets = getAvailablePresets("jobJudge", allPresets); // Pre-load jobJudge presets

	let yargsInstance = yargs(hideBin(process.argv));

	yargsInstance = yargsInstance
		.option("log-dir", {
			type: "string",
			description: "Directory to save log files.",
			default: defaultLogDirectory,
		})
		.option("log-file", {
			type: "string",
			description: "Name of the log file. A timestamp will be prepended.",
			default: "astroex.log",
		})
		.option("disable-file-logging", {
			type: "boolean",
			description: "Disable logging to a file.",
			default: false,
		});

	// Add commands using the functions
	yargsInstance = addScrapeSearchCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addScrapeJobCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addScrapeJobsCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addProcessDataCommand(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addJobClothCommand(
		yargsInstance as Argv<GlobalArgs>,
		jobClothPresets,
	);
	yargsInstance = addJobJudgeCommand(
		yargsInstance as Argv<GlobalArgs>,
		jobJudgePresets,
	); // Pass jobJudge presets
	yargsInstance = addEr44zzModesCommands(yargsInstance as Argv<GlobalArgs>);
	yargsInstance = addMakeMaterialsCommands(yargsInstance as Argv<GlobalArgs>);

	yargsInstance
		.demandCommand(1, "You need at least one command before moving on")
		.help()
		.parse();
})();

// If no command is provided, yargs will show the help message due to .demandCommand(1)
