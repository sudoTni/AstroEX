import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAvailablePresets, getPreset, type PresetConfig } from "./types";
import { log } from "./utils";

const PRESETS_FILE_PATH = path.join(__dirname, "..", "config", "presets.json");

const VERITAS_SYSTEM_PROMPT_PATH = path.join(
	__dirname,
	"..",
	"sysprompts",
	"veritas_sys_prompt.txt",
);

/**
 * Loads the preset configuration from presets.json.
 * @returns A Promise that resolves to the PresetConfig object.
 */
export async function loadPresets(): Promise<PresetConfig> {
	try {
		const fileContent = await fs.readFile(PRESETS_FILE_PATH, "utf-8");
		const presets: PresetConfig = JSON.parse(fileContent);
		log(
			"Presets",
			`Successfully loaded presets from ${PRESETS_FILE_PATH}`,
			"info",
			{ presets: Object.keys(presets) },
		);
		return presets;
	} catch (error: unknown) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(
			"Presets",
			`Error loading presets from ${PRESETS_FILE_PATH}: ${errMsg}`,
			"error",
			{ error: errMsg },
		);
		throw new Error(`Failed to load presets: ${errMsg}`);
	}
}

// Re-export getPreset and getAvailablePresets from types.ts for convenience
// These functions are defined in types.ts and are re-exported here for convenience
// so that other modules can import them from presets.ts
export { getPreset, getAvailablePresets };

/**
 * Loads the Veritas system prompt from veritas_sys_prompt.txt.
 * @returns A Promise that resolves to the content of the system prompt.
 */
export async function loadVeritasSystemPrompt(): Promise<string> {
	try {
		const promptContent = await fs.readFile(
			VERITAS_SYSTEM_PROMPT_PATH,
			"utf-8",
		);
		log(
			"Presets",
			`Successfully loaded Veritas system prompt from ${VERITAS_SYSTEM_PROMPT_PATH}`,
			"info",
		);
		return promptContent.trim();
	} catch (error: unknown) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(
			"Presets",
			`Error loading Veritas system prompt from ${VERITAS_SYSTEM_PROMPT_PATH}: ${errMsg}`,
			"error",
			{ error: errMsg },
		);
		throw new Error(`Failed to load Veritas system prompt: ${errMsg}`);
	}
}

/**
 * Loads a prompt template and replaces placeholders with provided data.
 * @param templatePath Relative path to the prompt template file (e.g., "./prompts/jc_prompt.txt")
 * @param placeholderData A map where keys are placeholder names (e.g., "myKeySkills") and values are their content.
 * @returns A Promise that resolves to the processed prompt string.
 */
export async function loadAndReplacePromptTemplate(
	templatePath: string,
	placeholderData: Record<string, string> = {},
): Promise<string> {
	const fullTemplatePath = path.join(__dirname, "..", templatePath);
	try {
		let promptContent = await fs.readFile(fullTemplatePath, "utf-8");

		for (const key in placeholderData) {
			if (key in placeholderData) {
				const placeholder = `{${key}}`;
				const value = placeholderData[key];
				promptContent = promptContent.replace(
					new RegExp(placeholder, "g"),
					value,
				);
			}
		}

		log(
			"Presets",
			`Successfully loaded and processed prompt template: ${templatePath}`,
			"info",
		);
		return promptContent.trim();
	} catch (error: unknown) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(
			"Presets",
			`Error loading or processing prompt template ${templatePath}: ${errMsg}`,
			"error",
			{ error: errMsg },
		);
		throw new Error(`Failed to load or process prompt template: ${errMsg}`);
	}
}
