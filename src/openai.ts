import * as fs from "node:fs";
import * as path from "node:path";
import type OpenAI from "openai";
import { z } from "zod";
import { processTemplate } from "./templateEngine";
import type { Preset, TemplateVariables } from "./types";
import { log } from "./utils";

// Define Zod schema for the expected job analysis result structure
const JobAnalysisResultSchema = z.object({
	jobTitle: z.string(),
	isVeryHighlyAligned: z.boolean(),
	rationale: z.string(),
	confidence: z.number(), // Added confidence score field
});

// Define Zod schema for the expected array of job analysis results wrapped in an object
const JobAnalysisResultsWrapperSchema = z.object({
	results: z.array(JobAnalysisResultSchema),
});

// Function to read external files with security validation
export async function readExternalFile(fileName: string): Promise<string> {
	// Validate filename to prevent path traversal attacks
	if (!/^[a-zA-Z0-9_-]+\.(txt|json)$/.test(fileName)) {
		throw new Error(`Invalid filename: ${fileName}`);
	}

	const rootDirectory = path.resolve(__dirname, "..", "..");
	const safeFilePath = path.join(
		rootDirectory,
		"user_data",
		fileName,
	);

	// Verify the resolved path is within the allowed directory
	const resolvedPath = path.resolve(safeFilePath);
	const allowedDir = path.resolve(rootDirectory, "user_data");

	if (!resolvedPath.startsWith(allowedDir)) {
		throw new Error(`Access denied: ${fileName}`);
	}

	try {
		return await fs.promises.readFile(resolvedPath, "utf-8");
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

// Function to read specific prompt files
export async function readPromptFile(promptName: string): Promise<string> {
	// Use process.cwd() to ensure we're looking in the correct directory
	const rootDirectory = process.cwd();
	const filePath = path.join(
		rootDirectory,
		"user_data",
		`${promptName}_prompt.txt`,
	);
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`Failed to read prompt file ${promptName}_prompt.txt: ${error}`,
		);
	}
}

// Function to read the veritas system prompt
export async function readVeritasSystemPrompt(): Promise<string> {
	// Use process.cwd() to ensure we're looking in the correct directory
	const rootDirectory = process.cwd();
	const filePath = path.join(
		rootDirectory,
		"sysprompts",
		"veritas_sys_prompt.txt",
	);
	try {
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`Failed to read veritas system prompt file sysprompts/veritas_sys_prompt.txt: ${error}`,
		);
	}
}

// Function to get specific system prompt by name (deprecated - use readVeritasSystemPrompt instead)
export async function getSystemPrompt(promptName: string): Promise<string> {
	// For backward compatibility, read from the new veritas system prompt
	const veritasPrompt = await readVeritasSystemPrompt();
	return `${veritasPrompt}\n\n${promptName}: Additional context for this specific prompt.`;
}

// Helper function to process a single batch and return parsed JSON content or error
export async function processBatch(
	openai: OpenAI,
	titles: string[],
	preset: Preset,
	templateVariables: TemplateVariables,
	logPayload?: boolean,
): Promise<{
	content: z.infer<typeof JobAnalysisResultSchema>[];
	error?: unknown;
}> {
	// Only log batch processing in verbose mode
	if (process.env.VERBOSE || process.env.NODE_ENV === "development") {
		console.log(
			"OpenAI",
			`Processing batch with ${titles.length} titles using preset ${preset.name}...`,
			{
				batchSize: titles.length,
				preset: preset.name,
			},
		);
	}

	try {
		// Process template with variables
		const { systemMessage, userMessage } = await processTemplate(
			preset.promptTemplate,
			templateVariables,
		);

		// Add job titles to user message
		const enhancedUserMessage = `${userMessage}

Job Titles to Analyze:
${titles.map((title, index) => `${index + 1}. ${title}`).join("\n")}`;

		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemMessage },
			{ role: "user", content: enhancedUserMessage },
		];

		// Extract parameters from preset
		const temperature = preset.temperature;
		const topP = preset.topP;
		const maxTokens = preset.maxTokens || 16000; // Default max tokens

		if (logPayload) {
			log("OpenAI", "Sending payload to OpenAI API:", "info", {
				model: preset.provider,
				messages,
				temperature,
				top_p: topP,
				max_tokens: maxTokens,
			});
		}

		// Call OpenAI API
		const response = await openai.chat.completions.create({
			model: preset.provider,
			messages,
			temperature,
			top_p: topP,
			max_tokens: maxTokens,
			response_format: { type: "json_object" },
		});

		// Extract and clean the content
		let content = response.choices[0]?.message?.content;
		if (!content) {
			throw new Error("No content received from OpenAI API");
		}

		// Remove <thought> tags from the response content (no verbose logging)
		content = content?.replace(/<thought>.*?<\/thought>/gs, "") ?? content;
		content = content?.replace(/\n/g, " ") ?? content;

		// Parse and validate the structured JSON response
		if (!content) {
			throw new Error("No content received from OpenAI API");
		}

		const parsedContent = JSON.parse(content);
		const validatedContent =
			JobAnalysisResultsWrapperSchema.parse(parsedContent);

		return {
			content: validatedContent.results,
			error: undefined,
		};
	} catch (error: unknown) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log("OpenAI", `Error processing batch: ${errMsg}`, "error", {
			error,
			batchSize: titles.length,
			preset: preset.name,
		});

		return {
			content: [],
			error,
		};
	}
}

// Helper function to process a single job and return raw text content or an error
export async function processAndGetRawText(
	openai: OpenAI,
	preset: Preset,
	templateVariables: TemplateVariables,
	logPayload?: boolean,
): Promise<{ content: string; error?: unknown }> {
	try {
		// Process template with variables
		const { systemMessage, userMessage } = await processTemplate(
			preset.promptTemplate,
			templateVariables,
		);

		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemMessage },
			{ role: "user", content: userMessage },
		];

		// Extract parameters from preset
		const temperature = preset.temperature;
		const topP = preset.topP;
		const maxTokens = preset.maxTokens || 8000; // Default max tokens

		if (logPayload) {
			log("OpenAI", "Sending payload to OpenAI API:", "info", {
				model: preset.provider,
				messages,
				temperature,
				top_p: topP,
				max_tokens: maxTokens,
			});
		}

		// Call OpenAI API
		const response = await openai.chat.completions.create({
			model: preset.provider,
			messages,
			temperature,
			top_p: topP,
			max_tokens: maxTokens,
		});

		// Extract and clean the content
		let content = response.choices[0]?.message?.content;
		if (!content) {
			throw new Error("No content received from OpenAI API");
		}

		// Remove <thought> tags from the response content (no verbose logging)
		content = content?.replace(/<thought>.*?<\/thought>/gs, "") ?? content;
		content = content?.replace(/\n/g, " ") ?? content;

		return {
			content,
			error: undefined,
		};
	} catch (error: unknown) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log("OpenAI", `Error processing text: ${errMsg}`, "error", {
			error: error,
			preset: preset.name,
		});

		return {
			content: "",
			error: error,
		};
	}
}
