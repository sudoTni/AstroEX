/**
 * AstroEX Template Engine
 * Version 2.8.1
 *
 * This module provides the template engine for processing prompt templates
 * with placeholders and combining them with system prompts.
 *
 * @author tjenkel
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readVeritasSystemPrompt } from "./openai";
import type { TemplateVariables } from "./types";

/**
 * Read a prompt template file
 * @param templateName Name of the template file (without extension)
 * @returns Promise of template content as string
 */
export async function readPromptTemplate(
	templateName: string,
): Promise<string> {
	const rootDirectory = process.cwd();
	const filePath = path.join(rootDirectory, "prompts", `${templateName}.txt`);
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`Failed to read prompt template ${templateName}.txt: ${error}`,
		);
	}
}

/**
 * Process template placeholders with provided variables
 * @param template Template content with placeholders
 * @param variables Template variables object
 * @returns Processed template with placeholders replaced
 */
export function processTemplatePlaceholders(
	template: string,
	variables: TemplateVariables,
): string {
	let processedTemplate = template;

	// Process JEP variables
	const jepVars = variables.jep_vars || {};
	Object.entries(jepVars).forEach(([key, value]) => {
		const placeholder = `{{${key}}}`;
		// Sanitize value to prevent injection attacks
		const sanitizedValue = String(value ?? "").replace(/[{}]/g, "");
		processedTemplate = processedTemplate.replace(
			new RegExp(escapeRegExp(placeholder), "g"),
			sanitizedValue,
		);
	});

	// Process ROP variables
	const ropVars = variables.rop_vars || {};
	Object.entries(ropVars).forEach(([key, value]) => {
		const placeholder = `{{${key}}}`;
		// Sanitize value to prevent injection attacks
		const sanitizedValue = String(value ?? "").replace(/[{}]/g, "");
		processedTemplate = processedTemplate.replace(
			new RegExp(escapeRegExp(placeholder), "g"),
			sanitizedValue,
		);
	});

	return processedTemplate;
}

/**
 * Escape special characters in regex pattern
 * @param string String to escape
 * @returns Escaped string safe for regex
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Combine veritas system prompt with template content
 * @param templateContent Processed template content
 * @returns Combined system and user message content
 */
export async function combineWithSystemPrompt(
	templateContent: string,
): Promise<{
	systemMessage: string;
	userMessage: string;
}> {
	const veritasSystemPrompt = await readVeritasSystemPrompt();

	// The veritas_sys_prompt.txt should ALWAYS be the system message
	// All other template content should go to the user message
	return {
		systemMessage: veritasSystemPrompt.trim(),
		userMessage: templateContent.trim(),
	};
}

/**
 * Process a complete template with variables and system prompt
 * @param templateName Name of the template file
 * @param variables Template variables
 * @returns Promise of combined system and user messages
 */
export async function processTemplate(
	templateName: string,
	variables: TemplateVariables,
): Promise<{
	systemMessage: string;
	userMessage: string;
}> {
	// Read the template file
	const templateContent = await readPromptTemplate(templateName);

	// Process placeholders
	const processedTemplate = processTemplatePlaceholders(
		templateContent,
		variables,
	);

	// Combine with system prompt
	return await combineWithSystemPrompt(processedTemplate);
}

/**
 * Validate template variables for a specific template type
 * @param templateType Type of template (jep or rop)
 * @param variables Template variables to validate
 * @returns True if variables are valid, false otherwise
 */
export function validateTemplateVariables(
	templateType: "jep" | "rop",
	variables: TemplateVariables,
): boolean {
	if (templateType === "jep") {
		const jepVars = variables.jep_vars || {};
		return (
			jepVars.targJD !== undefined &&
			jepVars.myResume !== undefined &&
			jepVars.myTestimonials !== undefined
		);
	} else if (templateType === "rop") {
		const ropVars = variables.rop_vars || {};
		return (
			ropVars.myProfessionalTitle !== undefined &&
			ropVars.myProfessionalSummary !== undefined &&
			ropVars.myKeySkills !== undefined &&
			ropVars.targJD !== undefined &&
			ropVars.myResume !== undefined &&
			ropVars.myTestimonials !== undefined &&
			typeof ropVars.cover_length === "number"
		);
	}

	return false;
}

/**
 * Get required variables for a template type
 * @param templateType Type of template (jep or rop)
 * @returns Array of required variable names
 */
export function getRequiredVariables(templateType: "jep" | "rop"): string[] {
	if (templateType === "jep") {
		return ["targJD", "myResume", "myTestimonials"];
	} else if (templateType === "rop") {
		return [
			"myProfessionalTitle",
			"myProfessionalSummary",
			"myKeySkills",
			"targJD",
			"myResume",
			"myTestimonials",
			"cover_length",
		];
	}

	return [];
}
