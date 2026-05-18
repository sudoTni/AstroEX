import { createStatisticsCollector } from "../statistics";
import { formatDuration } from "../utils";
// src/commands/er44zzModes.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type { Argv } from "yargs";
import { type LLMRequest, llmService } from "../llmService";
import { readPromptFile } from "../openai";
import { loadPresets } from "../presets";
import {
	combineWithSystemPrompt,
	processTemplatePlaceholders,
} from "../templateEngine";
import { getPreset } from "../types";

// External prompt templates are now loaded from files in data/user_data/
// This allows for easier maintenance and updates without modifying the code

/**
 * Shared input structure for all modes.
 */
export interface Er44zzModeArgs {
	mode: 1 | 2 | 3 | 4;
	provider: string;
	model: string;
	useSysPrompt: boolean;
	testMode: 0 | 1 | 2;
	thoughts: boolean;
	maxTokens?: number;
	// Add additional fields as needed for resume, JD, etc.
}

// Function to read external files
async function readExternalFile(fileName: string): Promise<string> {
	const rootDirectory = path.resolve(__dirname, "..", "..");
	const filePath = path.join(rootDirectory, "user_data", fileName);
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read external file ${fileName}: ${error}`);
	}
}

// Function to load all external application data
export async function loadApplicationData(): Promise<{
	resume: string;
	professionalTitle: string;
	professionalSummary: string;
	keySkills: string;
	testimonials: string;
}> {
	const [
		resume,
		professionalTitle,
		professionalSummary,
		keySkills,
		testimonials,
	] = await Promise.all([
		readExternalFile("my_resume.txt"),
		readExternalFile("my_professional_title.txt"),
		readExternalFile("my_professional_summary.txt"),
		readExternalFile("my_key_skills.txt"),
		readExternalFile("my_testimonials.txt"),
	]);

	return {
		resume,
		professionalTitle,
		professionalSummary,
		keySkills,
		testimonials,
	};
}

/**
 * Mode 1: Resume Optimization Process (ROP - 01 - C3.7S)
 */
export async function runMode1(
	args: Er44zzModeArgs & {
		myProfessionalTitle?: string;
		myProfessionalSummary?: string;
		myKeySkills?: string;
		targJD?: string;
		resume?: string;
		testimonials?: string;
		coverLength?: number;
	},
) {
	console.log("Running ROP - 01 - C3.7S (Mode 1)");

	// Initialize statistics collection
	const stats = createStatisticsCollector("er44zz-mode1");
	stats.startCollection();

	const startTime = performance.now();

	try {
		// Load external application data
		const appDataLoadTimer = stats.startTimer("appData.load");
		const appData = await loadApplicationData();
		stats.endTimer(appDataLoadTimer);
		stats.incrementCounter("appData.loaded", 1);

		// Load external prompt
		const promptLoadTimer = stats.startTimer("prompt.load");
		const promptTemplate = await readPromptFile("rop_c3.7s");
		stats.endTimer(promptLoadTimer);
		stats.incrementCounter("prompts.loaded", 1);

		// Gather dynamic inputs
		const myProfessionalTitle =
			args.myProfessionalTitle ??
			appData.professionalTitle ??
			"[Professional Title]";
		const myProfessionalSummary =
			args.myProfessionalSummary ??
			appData.professionalSummary ??
			"[Professional Summary]";
		const myKeySkills = args.myKeySkills ?? appData.keySkills ?? "[Key Skills]";
		const targJD = args.targJD ?? "[Job Description goes here]";
		const resume =
			args.resume ??
			appData.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData.testimonials ?? "[Testimonials go here]";
		const coverLength = args.coverLength ?? 275; // Default per er44zz.py

		stats.incrementCounter("inputs.gathered", 1);

		// Process template with variables using standardized approach
		const templateVariables = {
			jep_vars: {
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
			},
			rop_vars: {
				myProfessionalTitle,
				myProfessionalSummary,
				myKeySkills,
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
				cover_length: coverLength,
			},
		};

		// Process template placeholders with variables
		const templateProcessTimer = stats.startTimer("template.process");
		const processedTemplate = processTemplatePlaceholders(
			promptTemplate,
			templateVariables,
		);
		const { systemMessage, userMessage } =
			await combineWithSystemPrompt(processedTemplate);
		stats.endTimer(templateProcessTimer);

		const _jobDescriptions = [targJD];

		// Initialize LLM service
		const llmInitTimer = stats.startTimer("llm.initialize");
		const providerName =
			(args.provider as string) === "openrouter"
				? "openrouter"
				: (args.provider as string) === "gemini"
					? "gemini"
					: (args.provider as string) === "mistral"
						? "mistral"
						: "openrouter";

		llmService.initialize(
			[
				{
					name: providerName,
					baseUrl: "https://openrouter.ai/api/v1",
					apiKey: process.env.OPENAI_API_KEY || "",
					model: args.model,
				},
			],
			providerName,
		);
		stats.endTimer(llmInitTimer);
		stats.incrementCounter("llm.initialized", 1);

		// Load presets for proper maxTokens handling
		const presetsLoadTimer = stats.startTimer("presets.load");
		const allPresets = await loadPresets();
		const effectivePreset = getPreset(
			"makeMaterials",
			"rop_g5m_poe",
			allPresets,
		) || {
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 16000, // Fallback to LLM service default
		};
		stats.endTimer(presetsLoadTimer);
		stats.incrementCounter("presets.loaded", 1);

		// Create LLM request using centralized service
		const llmRequestTimer = stats.startTimer("llm.request.create");
		const llmRequest: LLMRequest = {
			provider: providerName,
			model: args.model,
			messages: [
				{ role: "system", content: systemMessage },
				{ role: "user", content: userMessage },
			],
			temperature: 0.7,
			topP: 0.95,
			maxTokens: args.maxTokens ?? effectivePreset.maxTokens ?? 16000,
			timeout: 30000,
		};
		stats.endTimer(llmRequestTimer);

		// Process using centralized LLM service
		const llmCallTimer = stats.startTimer("llm.call");
		const result = await llmService.call(llmRequest);
		stats.endTimer(llmCallTimer);
		stats.incrementCounter("llm.calls", 1);
		stats.incrementCounter("llm.successfulCalls", 1);

		// TODO: Parse and return result (pass/fail, rationale, etc.)

		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Generate and display statistics
		const summary = stats.endCollection();

		console.log(`Mode 1 completed in ${duration}.`);
		console.log("Statistics:", summary);

		return result;
	} catch (error) {
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		console.error(`Mode 1 failed after ${duration}:`, error);

		const summary = stats.endCollection();
		console.log("Final statistics:", summary);

		throw error;
	}
}

/**
 * Mode 2: Resume Optimization Process (ROP - 02 - G41)
 */
export async function runMode2(
	args: Er44zzModeArgs & {
		myProfessionalTitle?: string;
		myProfessionalSummary?: string;
		myKeySkills?: string;
		targJD?: string;
		resume?: string;
		testimonials?: string;
		coverLength?: number;
	},
) {
	console.log("Running ROP - 02 - G41 (Mode 2)");

	// Initialize statistics collection
	const stats = createStatisticsCollector("er44zz-mode2");
	stats.startCollection();

	const startTime = performance.now();

	try {
		// Load external application data
		const appDataLoadTimer = stats.startTimer("appData.load");
		const appData = await loadApplicationData();
		stats.endTimer(appDataLoadTimer);
		stats.incrementCounter("appData.loaded", 1);

		// Load external prompt
		const promptLoadTimer = stats.startTimer("prompt.load");
		const promptTemplate = await readPromptFile("rop_g41");
		stats.endTimer(promptLoadTimer);
		stats.incrementCounter("prompts.loaded", 1);

		// Gather dynamic inputs
		const myProfessionalTitle =
			args.myProfessionalTitle ??
			appData.professionalTitle ??
			"[Professional Title]";
		const myProfessionalSummary =
			args.myProfessionalSummary ??
			appData.professionalSummary ??
			"[Professional Summary]";
		const myKeySkills = args.myKeySkills ?? appData.keySkills ?? "[Key Skills]";
		const targJD = args.targJD ?? "[Job Description goes here]";
		const resume =
			args.resume ??
			appData.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData.testimonials ?? "[Testimonials go here]";
		const coverLength = args.coverLength ?? 275;

		stats.incrementCounter("inputs.gathered", 1);

		// Process template with variables using standardized approach
		const templateVariables = {
			jep_vars: {
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
			},
			rop_vars: {
				myProfessionalTitle,
				myProfessionalSummary,
				myKeySkills,
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
				cover_length: coverLength,
			},
		};

		// Process template placeholders with variables
		const templateProcessTimer = stats.startTimer("template.process");
		const processedTemplate = processTemplatePlaceholders(
			promptTemplate,
			templateVariables,
		);
		const { systemMessage, userMessage } =
			await combineWithSystemPrompt(processedTemplate);
		stats.endTimer(templateProcessTimer);

		const _jobDescriptions = [targJD];

		// Initialize LLM service
		const llmInitTimer = stats.startTimer("llm.initialize");
		const providerName =
			(args.provider as string) === "openrouter"
				? "openrouter"
				: (args.provider as string) === "gemini"
					? "gemini"
					: (args.provider as string) === "mistral"
						? "mistral"
						: "openrouter";

		llmService.initialize(
			[
				{
					name: providerName,
					baseUrl: "https://openrouter.ai/api/v1",
					apiKey: process.env.OPENAI_API_KEY || "",
					model: args.model,
				},
			],
			providerName,
		);
		stats.endTimer(llmInitTimer);
		stats.incrementCounter("llm.initialized", 1);

		// Load presets for proper maxTokens handling
		const presetsLoadTimer = stats.startTimer("presets.load");
		const allPresets = await loadPresets();
		const effectivePreset = getPreset(
			"makeMaterials",
			"rop_g5m_poe",
			allPresets,
		) || {
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 16000, // Fallback to LLM service default
		};
		stats.endTimer(presetsLoadTimer);
		stats.incrementCounter("presets.loaded", 1);

		// Create LLM request using centralized service
		const llmRequestTimer = stats.startTimer("llm.request.create");
		const llmRequest: LLMRequest = {
			provider: providerName,
			model: args.model,
			messages: [
				{ role: "system", content: systemMessage },
				{ role: "user", content: userMessage },
			],
			temperature: 0.7,
			topP: 0.95,
			maxTokens: args.maxTokens ?? effectivePreset.maxTokens ?? 16000,
			timeout: 30000,
		};
		stats.endTimer(llmRequestTimer);

		// Process using centralized LLM service
		const llmCallTimer = stats.startTimer("llm.call");
		const result = await llmService.call(llmRequest);
		stats.endTimer(llmCallTimer);
		stats.incrementCounter("llm.calls", 1);
		stats.incrementCounter("llm.successfulCalls", 1);

		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Generate and display statistics
		const summary = stats.endCollection();

		console.log(`Mode 2 completed in ${duration}.`);
		console.log("Statistics:", summary);

		return result;
	} catch (error) {
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		console.error(`Mode 2 failed after ${duration}:`, error);

		const summary = stats.endCollection();
		console.log("Final statistics:", summary);

		throw error;
	}
}

/**
 * Mode 3: Job Description Distill & Compatibility (JDD - 01 - G41m)
 */
export async function runMode3(
	args: Er44zzModeArgs & {
		targJD?: string;
		resume?: string;
		testimonials?: string;
		temperature?: number;
		topP?: number;
		maxTokens?: number;
		baseUrl?: string;
		api_key?: string;
	},
) {
	console.log("Running JDD - 01 - G41m (Mode 3)");

	// Initialize statistics collection
	const stats = createStatisticsCollector("er44zz-mode3");
	stats.startCollection();

	const startTime = performance.now();

	try {
		// Load external application data
		const appDataLoadTimer = stats.startTimer("appData.load");
		const appData = await loadApplicationData();
		stats.endTimer(appDataLoadTimer);
		stats.incrementCounter("appData.loaded", 1);

		// Load external prompt
		const promptLoadTimer = stats.startTimer("prompt.load");
		const promptTemplate = await readPromptFile("jdd_g41m");
		stats.endTimer(promptLoadTimer);
		stats.incrementCounter("prompts.loaded", 1);

		// Gather dynamic inputs
		const targJD = args.targJD ?? "[Job Description goes here]";
		const resume =
			args.resume ??
			appData.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData.testimonials ?? "[Testimonials go here]";

		stats.incrementCounter("inputs.gathered", 1);

		// Process template with variables using standardized approach
		const templateVariables = {
			jep_vars: {
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
			},
			rop_vars: {
				myProfessionalTitle: "[Professional Title]",
				myProfessionalSummary: "[Professional Summary]",
				myKeySkills: "[Key Skills]",
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
				cover_length: 275,
			},
		};

		// Process template placeholders with variables
		const templateProcessTimer = stats.startTimer("template.process");
		const processedTemplate = processTemplatePlaceholders(
			promptTemplate,
			templateVariables,
		);
		const { systemMessage, userMessage } =
			await combineWithSystemPrompt(processedTemplate);
		stats.endTimer(templateProcessTimer);

		// The OpenAI utility expects a list of job descriptions; here we use one.
		const _jobDescriptions = [targJD];

		// Use provided parameters or defaults
		const temperature = args.temperature ?? 0.7;
		// Load presets for proper maxTokens handling
		const presetsLoadTimer = stats.startTimer("presets.load");
		const allPresets = await loadPresets();
		const effectivePreset = getPreset(
			"makeMaterials",
			"rop_g5m_poe",
			allPresets,
		) || {
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 16000, // Fallback to LLM service default
		};
		stats.endTimer(presetsLoadTimer);
		stats.incrementCounter("presets.loaded", 1);

		const topP = args.topP ?? 0.95;
		const maxTokens = args.maxTokens ?? effectivePreset.maxTokens ?? 16000;
		const baseUrl = args.baseUrl;
		const apiKey = args.api_key;

		// Initialize LLM service
		const llmInitTimer = stats.startTimer("llm.initialize");
		const providerName =
			(args.provider as string) === "openrouter"
				? "openrouter"
				: (args.provider as string) === "gemini"
					? "gemini"
					: (args.provider as string) === "mistral"
						? "mistral"
						: "openrouter";

		llmService.initialize(
			[
				{
					name: providerName,
					baseUrl: baseUrl || "https://openrouter.ai/api/v1",
					apiKey: apiKey || "",
					model: args.model,
				},
			],
			providerName,
		);
		stats.endTimer(llmInitTimer);
		stats.incrementCounter("llm.initialized", 1);

		// Create LLM request using centralized service
		const llmRequestTimer = stats.startTimer("llm.request.create");
		const llmRequest: LLMRequest = {
			provider: providerName,
			model: args.model,
			messages: [
				{ role: "system", content: systemMessage },
				{ role: "user", content: userMessage },
			],
			temperature: temperature,
			topP: topP,
			maxTokens: maxTokens ?? effectivePreset.maxTokens ?? 16000,
			timeout: 30000,
		};
		stats.endTimer(llmRequestTimer);

		// Process using centralized LLM service
		const llmCallTimer = stats.startTimer("llm.call");
		const result = await llmService.call(llmRequest);
		stats.endTimer(llmCallTimer);
		stats.incrementCounter("llm.calls", 1);
		stats.incrementCounter("llm.successfulCalls", 1);

		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Generate and display statistics
		const summary = stats.endCollection();

		console.log(`Mode 3 completed in ${duration}.`);
		console.log("Statistics:", summary);

		return result;
	} catch (error) {
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		console.error(`Mode 3 failed after ${duration}:`, error);

		const summary = stats.endCollection();
		console.log("Final statistics:", summary);

		throw error;
	}
}

/**
 * Mode 4: Job Description Distill & Compatibility (JDD - 02 - GF2.0T_0121)
 */
export async function runMode4(
	args: Er44zzModeArgs & {
		targJD?: string;
		resume?: string;
		testimonials?: string;
		temperature?: number;
		topP?: number;
		maxTokens?: number;
		baseUrl?: string;
		api_key?: string;
	},
) {
	console.log("Running JDD - 02 - GF2.0T_0121 (Mode 4)");

	// Initialize statistics collection
	const stats = createStatisticsCollector("er44zz-mode4");
	stats.startCollection();

	const startTime = performance.now();

	try {
		// Load external application data
		const appDataLoadTimer = stats.startTimer("appData.load");
		const appData = await loadApplicationData();
		stats.endTimer(appDataLoadTimer);
		stats.incrementCounter("appData.loaded", 1);

		// Load external prompt
		const promptLoadTimer = stats.startTimer("prompt.load");
		const promptTemplate = await readPromptFile("jdd_gf2.0t");
		stats.endTimer(promptLoadTimer);
		stats.incrementCounter("prompts.loaded", 1);

		// Gather dynamic inputs
		const targJD = args.targJD ?? "[Job Description goes here]";
		const resume =
			args.resume ??
			appData.resume ??
			"[Resume content will be loaded from external file]";
		const testimonials =
			args.testimonials ?? appData.testimonials ?? "[Testimonials go here]";

		stats.incrementCounter("inputs.gathered", 1);

		// Process template with variables using standardized approach
		const templateVariables = {
			jep_vars: {
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
			},
			rop_vars: {
				myProfessionalTitle: "[Professional Title]",
				myProfessionalSummary: "[Professional Summary]",
				myKeySkills: "[Key Skills]",
				targJD,
				myResume: resume,
				myTestimonials: testimonials,
				cover_length: 275,
			},
		};

		// Process template placeholders with variables
		const templateProcessTimer = stats.startTimer("template.process");
		const processedTemplate = processTemplatePlaceholders(
			promptTemplate,
			templateVariables,
		);
		const { systemMessage, userMessage } =
			await combineWithSystemPrompt(processedTemplate);
		stats.endTimer(templateProcessTimer);

		// The OpenAI utility expects a list of job descriptions; here we use one.
		const _jobDescriptions = [targJD];

		// Use provided parameters or defaults
		const temperature = args.temperature ?? 0.7;
		// Load presets for proper maxTokens handling
		const presetsLoadTimer = stats.startTimer("presets.load");
		const allPresets = await loadPresets();
		const effectivePreset = getPreset(
			"makeMaterials",
			"rop_g5m_poe",
			allPresets,
		) || {
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 16000, // Fallback to LLM service default
		};
		stats.endTimer(presetsLoadTimer);
		stats.incrementCounter("presets.loaded", 1);

		const topP = args.topP ?? 0.95;
		const maxTokens = args.maxTokens ?? effectivePreset.maxTokens ?? 16000;
		const baseUrl = args.baseUrl;
		const apiKey = args.api_key;

		// Initialize LLM service
		const llmInitTimer = stats.startTimer("llm.initialize");
		const providerName =
			(args.provider as string) === "openrouter"
				? "openrouter"
				: (args.provider as string) === "gemini"
					? "gemini"
					: (args.provider as string) === "mistral"
						? "mistral"
						: "openrouter";

		llmService.initialize(
			[
				{
					name: providerName,
					baseUrl: baseUrl || "https://openrouter.ai/api/v1",
					apiKey: apiKey || "",
					model: args.model,
				},
			],
			providerName,
		);
		stats.endTimer(llmInitTimer);
		stats.incrementCounter("llm.initialized", 1);

		// Create LLM request using centralized service
		const llmRequestTimer = stats.startTimer("llm.request.create");
		const llmRequest: LLMRequest = {
			provider: providerName,
			model: args.model,
			messages: [
				{ role: "system", content: systemMessage },
				{ role: "user", content: userMessage },
			],
			temperature: temperature,
			topP: topP,
			maxTokens: maxTokens ?? effectivePreset.maxTokens ?? 16000,
			timeout: 30000,
		};
		stats.endTimer(llmRequestTimer);

		// Process using centralized LLM service
		const llmCallTimer = stats.startTimer("llm.call");
		const result = await llmService.call(llmRequest);
		stats.endTimer(llmCallTimer);
		stats.incrementCounter("llm.calls", 1);
		stats.incrementCounter("llm.successfulCalls", 1);

		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Generate and display statistics
		const summary = stats.endCollection();

		console.log(`Mode 4 completed in ${duration}.`);
		console.log("Statistics:", summary);

		return result;
	} catch (error) {
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		// Record error in statistics
		stats.recordError(
			error instanceof Error ? error : new Error(String(error)),
		);

		console.error(`Mode 4 failed after ${duration}:`, error);

		const summary = stats.endCollection();
		console.log("Final statistics:", summary);

		throw error;
	}
}

/**
 * Register CLI commands for all four modes.
 */
export function addEr44zzModesCommands(yargs: Argv) {
	return yargs
		.command(
			"rop-c3.7s",
			"ROP - 01 - C3.7S: Resume Optimization Process",
			(yargs) =>
				yargs
					.option("provider", { type: "string", demandOption: true })
					.option("model", { type: "string", demandOption: true })
					.option("use-sys-prompt", { type: "boolean", default: true })
					.option("test-mode", { type: "number", default: 0 })
					.option("thoughts", { type: "boolean", default: false })
					.option("max-tokens", { type: "number" }),
			async (argv) => {
				await runMode1({
					mode: 1,
					provider: argv.provider as string,
					model: argv.model as string,
					useSysPrompt: argv["use-sys-prompt"] as boolean,
					testMode: argv["test-mode"] as 0 | 1 | 2,
					thoughts: argv.thoughts as boolean,
					maxTokens: argv["max-tokens"] as number,
				});
			},
		)
		.command(
			"rop-g41",
			"ROP - 02 - G41: Resume Optimization Process",
			(yargs) =>
				yargs
					.option("provider", { type: "string", demandOption: true })
					.option("model", { type: "string", demandOption: true })
					.option("use-sys-prompt", { type: "boolean", default: true })
					.option("test-mode", { type: "number", default: 0 })
					.option("thoughts", { type: "boolean", default: false })
					.option("max-tokens", { type: "number" }),
			async (argv) => {
				await runMode2({
					mode: 2,
					provider: argv.provider as string,
					model: argv.model as string,
					useSysPrompt: argv["use-sys-prompt"] as boolean,
					testMode: argv["test-mode"] as 0 | 1 | 2,
					thoughts: argv.thoughts as boolean,
					maxTokens: argv["max-tokens"] as number,
				});
			},
		)
		.command(
			"jdd-g41m",
			"JDD - 01 - G41m: Job Description Distill & Compatibility",
			(yargs) =>
				yargs
					.option("provider", { type: "string", demandOption: true })
					.option("model", { type: "string", demandOption: true })
					.option("use-sys-prompt", { type: "boolean", default: true })
					.option("test-mode", { type: "number", default: 0 })
					.option("thoughts", { type: "boolean", default: false })
					.option("max-tokens", { type: "number" }),
			async (argv) => {
				await runMode3({
					mode: 3,
					provider: argv.provider as string,
					model: argv.model as string,
					useSysPrompt: argv["use-sys-prompt"] as boolean,
					testMode: argv["test-mode"] as 0 | 1 | 2,
					thoughts: argv.thoughts as boolean,
					maxTokens: argv["max-tokens"] as number,
				});
			},
		)
		.command(
			"jdd-gf2.0t",
			"JDD - 02 - GF2.0T_0121: Job Description Distill & Compatibility",
			(yargs) =>
				yargs
					.option("provider", { type: "string", demandOption: true })
					.option("model", { type: "string", demandOption: true })
					.option("use-sys-prompt", { type: "boolean", default: true })
					.option("test-mode", { type: "number", default: 0 })
					.option("thoughts", { type: "boolean", default: false })
					.option("max-tokens", { type: "number" }),
			async (argv) => {
				await runMode4({
					mode: 4,
					provider: argv.provider as string,
					model: argv.model as string,
					useSysPrompt: argv["use-sys-prompt"] as boolean,
					testMode: argv["test-mode"] as 0 | 1 | 2,
					thoughts: argv.thoughts as boolean,
					maxTokens: argv["max-tokens"] as number,
				});
			},
		);
}
