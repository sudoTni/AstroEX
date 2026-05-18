import * as fs from "node:fs";
import * as path from "node:path";
import type * as puppeteer from "puppeteer";
import { type LLMRequest, llmService } from "../llmService";
import type { GlobalArgs } from "../types";
import {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
import {
	AstroEXError,
	CircuitBreaker,
	createError,
	ErrorType,
	withErrorHandling,
	withRetry,
} from "./errors";
import { validateFilePath as validateSecureFilePath } from "./securityUtils";

/**
 * Standardized command execution wrapper with logging and error handling
 */
export async function executeCommandSafely<T>(
	commandName: string,
	fn: () => Promise<T>,
	options: {
		maxRetries?: number;
		timeoutMs?: number;
		circuitBreaker?: boolean;
	} = {},
): Promise<T> {
	const { maxRetries = 3, timeoutMs = 30000, circuitBreaker = true } = options;

	const startTime = performance.now();
	let circuit: CircuitBreaker | undefined;

	if (circuitBreaker) {
		circuit = new CircuitBreaker(5, timeoutMs, 3);
	}

	try {
		const result = await withRetry(
			() =>
				withErrorHandling(
					async () => {
						if (circuit) {
							return await circuit.execute(fn, commandName);
						}
						return await fn();
					},
					ErrorType.PROCESSING_ERROR,
					commandName,
				),
			maxRetries,
			1000,
			ErrorType.PROCESSING_ERROR,
			commandName,
		);

		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		log(commandName, `Command completed successfully in ${duration}`, "info", {
			duration,
		});

		return result;
	} catch (error) {
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);

		if (error instanceof AstroEXError) {
			log(
				commandName,
				`Command failed after ${duration}: ${error.message}`,
				"error",
				{
					duration,
					errorCode: error.code,
					errorDetails: error.details,
				},
			);
		} else {
			log(
				commandName,
				`Command failed after ${duration}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
				{
					duration,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}

		throw error;
	}
}

/**
 * Standardized file reading with enhanced security and error handling
 */
export async function readFileSafely(
	filePath: string,
	context: string = "File reading",
	maxFileSize: number = 100 * 1024 * 1024, // 100MB default limit
): Promise<string> {
	return withErrorHandling(
		async () => {
			// Enhanced path validation
			const sanitizedPath = validateSecureFilePath(filePath);
			if (!sanitizedPath) {
				throw createError(
					ErrorType.SECURITY_VIOLATION,
					`Invalid file path: ${filePath}`,
				);
			}

			// Check if file exists and is accessible
			try {
				await fs.promises.access(sanitizedPath, fs.constants.R_OK);
			} catch (accessError: any) {
				if (accessError.code === "ENOENT") {
					throw createError(
						ErrorType.FILE_NOT_FOUND,
						`File not found: ${sanitizedPath}`,
					);
				} else if (accessError.code === "EACCES") {
					throw createError(
						ErrorType.FILE_ACCESS_ERROR,
						`Access denied for file: ${sanitizedPath}`,
					);
				}
				throw createError(
					ErrorType.FILE_ACCESS_ERROR,
					`File access error: ${accessError.message}`,
					{ originalError: accessError },
				);
			}

			// Check file size before reading
			try {
				const stats = await fs.promises.stat(sanitizedPath);
				if (stats.size > maxFileSize) {
					throw createError(
						ErrorType.PROCESSING_ERROR,
						`File too large: ${sanitizedPath} (${stats.size} bytes exceeds ${maxFileSize} byte limit)`,
					);
				}
				if (!stats.isFile()) {
					throw createError(
						ErrorType.VALIDATION_ERROR,
						`Path is not a file: ${sanitizedPath}`,
					);
				}
			} catch (statError: any) {
				throw createError(
					ErrorType.FILE_ACCESS_ERROR,
					`Failed to get file stats: ${statError.message}`,
					{ originalError: statError },
				);
			}

			// Read file with error handling
			try {
				const content = await fs.promises.readFile(sanitizedPath, "utf-8");
				return content;
			} catch (readError: any) {
				throw createError(
					ErrorType.FILE_ACCESS_ERROR,
					`Failed to read file: ${readError.message}`,
					{ originalError: readError, filePath: sanitizedPath },
				);
			}
		},
		ErrorType.FILE_ACCESS_ERROR,
		context,
	);
}

/**
 * Standardized file writing with error handling
 */
export async function writeFileSafely(
	filePath: string,
	content: string,
	context: string = "File writing",
): Promise<void> {
	return withErrorHandling(
		async () => {
			const dir = path.dirname(filePath);
			await fs.promises.mkdir(dir, { recursive: true });
			await fs.promises.writeFile(filePath, content, "utf-8");
		},
		ErrorType.FILE_WRITE_ERROR,
		context,
	);
}

/**
 * Standardized directory creation with error handling
 */
export async function ensureDirectoryExists(
	dirPath: string,
	context: string = "Directory creation",
): Promise<void> {
	return withErrorHandling(
		async () => {
			await fs.promises.mkdir(dirPath, { recursive: true });
		},
		ErrorType.FILE_WRITE_ERROR,
		context,
	);
}

/**
 * Standardized JSON parsing with error handling
 */
export function parseJsonSafely<T>(
	jsonString: string,
	_context: string = "JSON parsing",
	schema?: Zod.ZodType<T>,
): T {
	try {
		const parsed = JSON.parse(jsonString);
		if (schema) {
			return schema.parse(parsed);
		}
		return parsed as T;
	} catch (parseError) {
		if (parseError instanceof SyntaxError) {
			throw createError(
				ErrorType.SCHEMA_VALIDATION_FAILED,
				`Invalid JSON format: ${parseError.message}`,
				undefined,
				parseError,
			);
		}
		throw parseError;
	}
}

/**
 * Standardized validation function
 */
export function validateInput<T>(
	input: unknown,
	schema: Zod.ZodType<T>,
	_context: string = "Input validation",
): T {
	return schema.parse(input);
}

/**
 * Standardized API key validation
 */
export function validateApiKey(
	apiKey: string,
	_context: string = "API key validation",
): void {
	if (!apiKey || typeof apiKey !== "string") {
		throw createError(
			ErrorType.API_KEY_INVALID,
			"API key is required and must be a string",
			undefined,
			undefined,
		);
	}

	if (apiKey.length < 10 || apiKey.length > 100) {
		throw createError(
			ErrorType.API_KEY_INVALID,
			"API key length must be between 10 and 100 characters",
			undefined,
			undefined,
		);
	}

	// Check for common test patterns
	const testPatterns = [/sk-test/i, /test_/i, /demo/i, /example/i];
	if (testPatterns.some((pattern) => pattern.test(apiKey))) {
		throw createError(
			ErrorType.API_KEY_INVALID,
			"API key appears to be a test key",
			undefined,
			undefined,
		);
	}
}

/**
 * Standardized URL validation
 */
export function validateUrl(
	url: string,
	_context: string = "URL validation",
): void {
	if (!url || typeof url !== "string") {
		throw createError(
			ErrorType.INVALID_INPUT,
			"URL is required and must be a string",
			undefined,
			undefined,
		);
	}

	try {
		new URL(url);
	} catch (error) {
		throw createError(
			ErrorType.INVALID_INPUT,
			`Invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
			undefined,
			error,
		);
	}
}

/**
 * Standardized file path validation
 */
export function validateFilePath(
	filePath: string,
	_context: string = "File path validation",
): string {
	if (!filePath || typeof filePath !== "string") {
		throw createError(
			ErrorType.INVALID_INPUT,
			"File path is required and must be a string",
			undefined,
			undefined,
		);
	}

	// Remove any path traversal attempts
	const sanitized = filePath
		.replace(/\.\.\//g, "") // Remove parent directory references
		.replace(/\/+/g, path.sep) // Normalize separators
		.replace(/^\/+/, "") // Remove leading separators
		.replace(/\/+$/, ""); // Remove trailing separators

	// Resolve to absolute path and check if it's within the project directory
	const absolutePath = path.resolve(sanitized);
	const rootDirectory = path.resolve(__dirname, "..", "..");

	if (!absolutePath.startsWith(rootDirectory)) {
		throw createError(
			ErrorType.SECURITY_VIOLATION,
			"Access to file outside project directory is not allowed",
			undefined,
			undefined,
		);
	}

	return absolutePath;
}

/**
 * Common browser launch configuration used across all scraping commands
 */
export const BROWSER_LAUNCH_OPTIONS = {
	headless: true,
	args: [
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--disable-setuid-sandbox",
		"--no-first-run",
		"--no-sandbox",
		"--no-zygote",
		"--single-process",
	],
} as const;

/**
 * Common directory paths used across commands
 */
export class DirectoryPaths {
	static readonly root = path.resolve(__dirname, "..", "..");
	static readonly data = path.join(this.root, "data");
	static readonly logs = path.join(this.root, "logs");
	static readonly userData = path.join(this.root, "user_data");
}

/**
 * Extract job ID from LinkedIn URL with multiple supported patterns
 */
export function extractJobId(url: string): string | undefined {
	// Extract the numeric ID from various LinkedIn URL patterns
	const patterns = [
		/\/jobs\/view\/[^/]+-(\d+)/, // /jobs/view/job-title-12345
		/\/jobs\/view\/\?[^=]*=(\d+)/, // /jobs/view/?position=12345
		/\/jobs\/view\/(\d+)/, // /jobs/view/12345
		/\/jobs\/c\/view\/(\d+)/, // /jobs/c/view/12345
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}

	// Fallback: try to find any sequence of digits in the URL
	const digitMatch = url.match(/\d+/);
	return digitMatch ? digitMatch[0] : undefined;
}

/**
 * Standard logging initialization for commands
 */
export function initializeCommandLogging(
	componentName: string,
	argv: GlobalArgs,
	defaultLogDir?: string,
): void {
	if (!argv.disableFileLogging) {
		const logDirVal =
			typeof argv.logDir === "string"
				? argv.logDir
				: defaultLogDir || DirectoryPaths.logs;
		const logFileVal =
			typeof argv.logFile === "string" ? argv.logFile : "astroex.log";
		initializeFileLogging(
			logDirVal,
			`${formatDate(new Date(), "yyyyMMdd_HHmmss")}_${componentName}_${logFileVal}`,
			componentName,
		);
	}
}

/**
 * Standard command cleanup with timing
 */
export async function executeCommandWithTiming<T>(
	commandName: string,
	handler: () => Promise<T>,
	_argv: GlobalArgs,
): Promise<T> {
	const startTime = performance.now();
	let result: T;
	let error: unknown;

	try {
		result = await handler();
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);
		log(commandName, `Command completed in ${duration}.`, "log", { duration });
		return result;
	} catch (err) {
		error = err;
		const endTime = performance.now();
		const duration = formatDuration(endTime - startTime);
		const errorMessage = error instanceof Error ? error.message : String(error);
		log(
			commandName,
			`Command failed after ${duration}: ${errorMessage}`,
			"error",
			{ duration, error: errorMessage },
		);
		throw error;
	} finally {
		await closeFileLogging();
		// Small delay to ensure logs are written before exit
		setTimeout(() => process.exit(error ? 1 : 0), 1000);
	}
}

/**
 * Load external application data files with error handling
 */
export async function loadApplicationData() {
	const files = [
		"my_resume.txt",
		"my_professional_title.txt",
		"my_professional_summary.txt",
		"my_key_skills.txt",
		"my_testimonials.txt",
	] as const;

	try {
		const [
			resume,
			professionalTitle,
			professionalSummary,
			keySkills,
			testimonials,
		] = await Promise.all(
			files.map((file) =>
				fs.promises
					.readFile(path.join(DirectoryPaths.userData, file), "utf-8")
					.catch(() => {
						log(
							"ApplicationData",
							`Failed to load ${file}, using fallback`,
							"warn",
						);
						return `[${file
							.replace(/_/g, " ")
							.replace(/\.\w+$/, "")
							.toUpperCase()} content]`;
					}),
			),
		);

		return {
			resume,
			professionalTitle,
			professionalSummary,
			keySkills,
			testimonials,
		};
	} catch (error) {
		log("ApplicationData", `Error loading application data: ${error}`, "error");
		throw new Error(`Failed to load application data files: ${error}`);
	}
}

/**
 * Create LLM request with common configuration
 */
export function createLLMRequest(
	preset: any, // Preset type
	systemPrompt: string,
	userMessage: string,
	options: {
		temperature?: number;
		topP?: number;
		maxTokens?: number;
		timeout?: number;
		responseSchema?: any;
	} = {},
): LLMRequest {
	const request: LLMRequest = {
		provider: preset.provider as any,
		model: preset.modelId,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userMessage },
		],
		temperature: options.temperature ?? preset.temperature,
		topP: options.topP ?? preset.topP,
		maxTokens: options.maxTokens ?? (preset.maxTokens || 16000),
		timeout: options.timeout ?? 30000,
		responseSchema: options.responseSchema,
	};

	// Add JSON Mode for OpenAI provider
	if (preset.provider === "openai") {
		(request as any).response_format = { type: "json_object" };
	}

	return request;
}

/**
 * Initialize LLM service with provider configuration
 */
export function initializeLLMService(preset: any, apiKey: string): void {
	llmService.initialize(
		[
			{
				name: preset.provider,
				baseUrl: preset.base_url,
				apiKey: apiKey,
				model: preset.modelId,
			},
		],
		preset.provider,
	);
}

/**
 * Common file operations for job processing
 */
export class JobFileOperations {
	/**
	 * Ensure data directory exists
	 */
	static async ensureDataDirectory(): Promise<void> {
		try {
			await fs.promises.mkdir(DirectoryPaths.data, { recursive: true });
		} catch (error) {
			log("FileOperations", `Error creating data directory: ${error}`, "error");
			throw error;
		}
	}

	/**
	 * Read and parse job files with multiple format support
	 */
	static async readJobFiles(filePaths: string[]): Promise<any[]> {
		const allJobs: any[] = [];

		for (const filePath of filePaths) {
			try {
				const fileContent = await fs.promises.readFile(filePath, "utf-8");
				const jobs = JobFileOperations.parseJobContent(fileContent, filePath);
				allJobs.push(...jobs);
				log(
					"FileOperations",
					`Loaded ${jobs.length} jobs from ${path.basename(filePath)}`,
				);
			} catch (error) {
				log(
					"FileOperations",
					`Error reading file ${filePath}: ${error}`,
					"error",
				);
			}
		}

		return allJobs;
	}

	/**
	 * Parse job content supporting both JSON arrays and newline-separated JSON
	 */
	private static parseJobContent(content: string, filePath: string): any[] {
		const jobs: any[] = [];

		try {
			// First try to parse as JSON array
			const jobData = JSON.parse(content);
			if (Array.isArray(jobData)) {
				return jobData;
			} else if (jobData && typeof jobData === "object") {
				const jobWithId = { ...jobData };
				if (!jobWithId.id) {
					const filenameMatch = path
						.basename(filePath)
						.match(/^job_(\d+)\.json$/);
					if (filenameMatch) {
						jobWithId.id = filenameMatch[1];
					}
				}
				return [jobWithId];
			} else {
				throw new Error(
					`File ${filePath} does not contain a valid job object or array.`,
				);
			}
		} catch (_parseError) {
			// If JSON array parsing fails, try newline-separated JSON objects
			log(
				"FileOperations",
				`Failed to parse as JSON array, trying newline-separated format...`,
				"warn",
			);
			const lines = content.split("\n").filter((line) => line.trim());
			let currentJobJson = "";

			for (const line of lines) {
				currentJobJson += `${line}\n`;

				// Try to parse as complete JSON object
				try {
					const jobData = JSON.parse(currentJobJson);
					if (jobData && typeof jobData === "object") {
						const jobWithId = { ...jobData };

						// Extract job ID from URL if not present
						if (!jobWithId.id && jobWithId.url) {
							jobWithId.id = extractJobId(jobWithId.url);
						}

						jobs.push(jobWithId);
						currentJobJson = ""; // Reset for next job
					}
				} catch (_lineError) {
					// Continue building JSON
				}
			}
		}

		return jobs;
	}

	/**
	 * Write job data to file with error handling
	 */
	static async writeJobData(filePath: string, data: any): Promise<void> {
		try {
			await fs.promises.writeFile(
				filePath,
				JSON.stringify(data, null, 2),
				"utf-8",
			);
			log("FileOperations", `Job data written to ${filePath}`);
		} catch (error) {
			log(
				"FileOperations",
				`Error writing job data to ${filePath}: ${error}`,
				"error",
			);
			throw error;
		}
	}

	/**
	 * Move file to destination directory
	 */
	static async moveFile(
		filePath: string,
		destDir: string,
		fileName?: string,
	): Promise<string> {
		const targetFileName = fileName || path.basename(filePath);
		const destPath = path.join(destDir, targetFileName);

		try {
			await fs.promises.rename(filePath, destPath);
			log("FileOperations", `Moved ${filePath} to ${destPath}`);
			return destPath;
		} catch (error) {
			log(
				"FileOperations",
				`Error moving file ${filePath} to ${destPath}: ${error}`,
				"error",
			);
			throw error;
		}
	}
}

/**
 * Common validation utilities for command arguments
 */
export class CommandValidation {
	/**
	 * Validate required arguments
	 */
	static validateRequiredArgs(
		argv: Record<string, unknown>,
		requiredArgs: string[],
	): void {
		for (const arg of requiredArgs) {
			if (!(argv as any)[arg]) {
				throw new Error(`Required argument '${arg}' is missing`);
			}
		}
	}

	/**
	 * Validate numeric arguments with min/max constraints
	 */
	static validateNumericArg(
		argv: Record<string, unknown>,
		argName: string,
		min?: number,
		max?: number,
	): number {
		const value = (argv as any)[argName];
		if (typeof value !== "number" || Number.isNaN(value)) {
			throw new Error(`Argument '${argName}' must be a valid number`);
		}

		if (min !== undefined && value < min) {
			throw new Error(`Argument '${argName}' must be at least ${min}`);
		}

		if (max !== undefined && value > max) {
			throw new Error(`Argument '${argName}' must be at most ${max}`);
		}

		return value;
	}

	/**
	 * Validate file existence
	 */
	static async validateFileExists(filePath: string): Promise<void> {
		try {
			await fs.promises.access(filePath, fs.constants.F_OK);
		} catch (_error) {
			throw new Error(`File does not exist: ${filePath}`);
		}
	}

	/**
	 * Validate directory exists or create it
	 */
	static async ensureDirectoryExists(dirPath: string): Promise<void> {
		try {
			await fs.promises.access(dirPath);
		} catch (_error) {
			try {
				await fs.promises.mkdir(dirPath, { recursive: true });
			} catch (mkdirError) {
				throw new Error(`Failed to create directory ${dirPath}: ${mkdirError}`);
			}
		}
	}
}

/**
 * Sleep utility for rate limiting
 */
export function sleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Retry utility with exponential backoff
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries: number = 3,
	baseDelay: number = 1000,
): Promise<T> {
	let retryCount = 0;

	while (retryCount < maxRetries) {
		try {
			return await fn();
		} catch (error) {
			retryCount++;
			if (retryCount >= maxRetries) {
				throw error;
			}

			const delay = baseDelay * 2 ** (retryCount - 1);
			log(
				"Retry",
				`Attempt ${retryCount} failed, retrying in ${delay}ms...`,
				"warn",
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error("Max retries exceeded");
}

/**
 * Common cleanup utility for command execution
 */
export async function performCommandCleanup(
	browser: puppeteer.Browser | undefined,
	tempDir: string | undefined,
): Promise<void> {
	if (browser) {
		log("Cleanup", "Closing Chrome browser... Shutting down.", "info");
		await browser.close();
	}

	if (tempDir) {
		try {
			log("Cleanup", `Cleaning up temporary directory: ${tempDir}`, "info");
			await fs.promises.rm(tempDir, { recursive: true, force: true });
			log("Cleanup", "Temporary directory cleaned up.", "info");
		} catch (error: unknown) {
			log(
				"Cleanup",
				`Error cleaning up temporary directory ${tempDir}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}
}

// Re-export utilities from main utils module
export {
	closeFileLogging,
	formatDate,
	formatDuration,
	initializeFileLogging,
	log,
} from "../utils";
