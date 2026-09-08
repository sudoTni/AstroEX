import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type PresetConfig, getAvailablePresets, getPreset } from "./types";
import { log } from "./utils";

const PRESETS_FILE_PATH = path.join(__dirname, "..", "config", "presets.json");

const VERITAS_SYSTEM_PROMPT_PATH = path.join(
	__dirname,
	"..",
	"sysprompts",
	"veritas_sys_prompt.txt",
);

let presetsCache: PresetConfig | null = null;
let veritasPromptCache: string | null = null;
const templateCache = new Map<string, string>();

/**
 * Resets all in-memory preset and template caches (useful for testing).
 */
export function clearPresetsCache(): void {
	presetsCache = null;
	veritasPromptCache = null;
	templateCache.clear();
}

/**
 * Loads the preset configuration from presets.json (cached in memory).
 * @returns A Promise that resolves to the PresetConfig object.
 */
export async function loadPresets(): Promise<PresetConfig> {
	if (presetsCache) {
		return presetsCache;
	}
	try {
		const fileContent = await fs.readFile(PRESETS_FILE_PATH, "utf-8");
		const presets: PresetConfig = JSON.parse(fileContent);
		presetsCache = presets;
		log(
			"Presets",
			`Successfully loaded presets from ${PRESETS_FILE_PATH}`,
			"debug",
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
 * Loads the Veritas system prompt from veritas_sys_prompt.txt (cached in memory).
 * @returns A Promise that resolves to the content of the system prompt.
 */
export async function loadVeritasSystemPrompt(): Promise<string> {
	if (veritasPromptCache !== null) {
		return veritasPromptCache;
	}
	try {
		const promptContent = await fs.readFile(
			VERITAS_SYSTEM_PROMPT_PATH,
			"utf-8",
		);
		veritasPromptCache = promptContent.trim();
		log(
			"Presets",
			`Successfully loaded Veritas system prompt from ${VERITAS_SYSTEM_PROMPT_PATH}`,
			"debug",
		);
		return veritasPromptCache;
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
 * The raw template string is cached in memory to avoid redundant disk I/O.
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
		let rawTemplate = templateCache.get(fullTemplatePath);
		if (rawTemplate === undefined) {
			rawTemplate = await fs.readFile(fullTemplatePath, "utf-8");
			templateCache.set(fullTemplatePath, rawTemplate);
			log(
				"Presets",
				`Successfully loaded and processed prompt template: ${templatePath}`,
				"debug",
			);
		}

		let promptContent = rawTemplate;
		for (const [key, value] of Object.entries(placeholderData)) {
			promptContent = promptContent.replaceAll(`{${key}}`, () => value);
		}

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
