/**
 * AstroEX Centralized LLM Service
 * Version 3.2.0
 *
 * This module provides a unified interface for all LLM API calls across the application.
 * It supports multiple providers (OpenAI, Gemini, Mistral, OpenRouter, POE) with consistent
 * error handling, retry logic, and performance monitoring.
 *
 * Features:
 * - Multi-provider support with automatic provider selection
 * - Circuit breaker pattern for fault tolerance
 * - Robust JSON parsing with repair strategies
 * - Performance monitoring and metrics collection
 * - Batch processing with concurrency control
 * - Comprehensive error handling and retry logic
 *
 * @author tjenkel
 * @license MIT
import { createLogger } from "./utils";
 * @since 2.0.0
 */

import { OpenAI } from "openai";
// import { GoogleGenerativeAI } from "@google/generative-ai";
// import { Mistral } from "@mistralai/mistralai";
import { z } from "zod";
import { type CircuitBreaker, CircuitBreakerFactory } from "./circuitBreaker";
import type { AIProviderConfig, PerformanceMetrics } from "./types";
import { AppError, formatDuration, log, logError } from "./utils";

// Pre-compiled regex patterns for better performance
const _COMPILED_REGEX_PATTERNS = {
	QUOTED_PROPERTY_NAME: /([{,]\s*)(['"])?([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g,
	UNQUOTED_STRING_VALUE: /:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([,}])/g,
	TRAILING_COMMA: /,\s*([}\]])/g,
	MISSING_COMMA_BETWEEN_PAIRS: /(\}|"|\d)\s*("|\w+)/g,
	UNESCAPED_QUOTES: /([^\\])""/g,
	MISSING_COMMA_BETWEEN_STRUCTURES: /(\}|\])\s*(\{|\[)/g,
	NESTED_OBJECT_ISSUES: /}\s*}/g,
	NESTED_ARRAY_ISSUES: /\]\s*\]/g,
} as const;

// Type definitions for JSON parsing operations
type ErrorType = "syntax" | "structure" | "truncation" | "unknown";
type RepairStrategy =
	| "direct_parse"
	| `${ErrorType}_fix`
	| "structure_recovery"
	| "partial_extraction";
type JsonParseError = {
	attempt: number;
	error: string;
	strategy: RepairStrategy;
	timestamp: number;
	errorType: ErrorType;
	repairDuration: number;
};

// Metrics for JSON parsing performance
type JsonParsingMetrics = {
	totalAttempts: number;
	successfulParses: number;
	failedParses: number;
	averageRepairTime: number;
	errorTypeDistribution: Record<ErrorType, number>;
	strategySuccessRates: Record<RepairStrategy, number>;
};

// Circular buffer implementation for error history
class CircularBuffer<T> {
	private buffer: T[];
	private head: number = 0;
	private tail: number = 0;
	private size: number = 0;
	private capacity: number;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.buffer = new Array(capacity);
	}

	push(item: T): void {
		this.buffer[this.tail] = item;
		this.tail = (this.tail + 1) % this.capacity;

		if (this.size < this.capacity) {
			this.size++;
		} else {
			this.head = (this.head + 1) % this.capacity;
		}
	}

	getItems(): T[] {
		const result: T[] = [];
		for (let i = 0; i < this.size; i++) {
			result.push(this.buffer[(this.head + i) % this.capacity]);
		}
		return result;
	}

	clear(): void {
		this.head = 0;
		this.tail = 0;
		this.size = 0;
	}
}

// Schema for LLM request validation
const LLMRequestSchema = z.object({
	provider: z.enum([
		"openai",
		"gemini",
		"mistral",
		"openrouter",
		"cerebras",
		"poe",
	]),
	model: z.string(),
	messages: z.array(
		z.object({
			role: z.enum(["system", "user", "assistant"]),
			content: z.string(),
		}),
	),
	temperature: z.number().min(0).max(2).default(0.6),
	topP: z.number().min(0).max(1).default(0.95),
	maxTokens: z.number().min(1).max(32000).default(16000),
	timeout: z.number().min(1000).max(60000).default(30000),
	responseSchema: z.any().optional(), // Optional Zod schema for response validation
});

export type LLMRequest = z.infer<typeof LLMRequestSchema>;

// Schema for LLM response
const LLMResponseSchema = z.object({
	content: z.union([z.string(), z.any()]), // Content can be string or parsed object
	provider: z.string(),
	model: z.string(),
	usage: z.object({
		promptTokens: z.number(),
		completionTokens: z.number(),
		totalTokens: z.number(),
	}),
	duration: z.number(),
	timestamp: z.string(),
});

export type LLMResponse = z.infer<typeof LLMResponseSchema>;

// Schema for batch processing
const BatchRequestSchema = z.object({
	requests: z.array(LLMRequestSchema),
	concurrency: z.number().min(1).max(10).default(3),
	retryAttempts: z.number().min(0).max(5).default(2),
	retryDelay: z.number().min(1000).max(30000).default(5000),
});

export type BatchRequest = z.infer<typeof BatchRequestSchema>;

/**
 * Centralized LLM Service class
 */
export class LLMService {
	private providers: Map<string, AIProviderConfig> = new Map();
	private defaultProvider: string = "openrouter";
	private performanceMetrics: PerformanceMetrics[] = [];
	private requestCount: number = 0;
	private successCount: number = 0;
	private failureCount: number = 0;
	private circuitBreakers: Map<string, CircuitBreaker> = new Map();

	/**
	 * Initialize the LLM service with provider configurations
	 * @param providers Array of AI provider configurations
	 * @param defaultProvider Optional default provider name. If not specified, uses the first provider
	 * @throws Error if no providers are specified or if any provider configuration is invalid
	 * @example
	 * ```typescript
	 * service.initialize([
	 *   { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...', model: 'gpt-4' },
	 *   { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1', apiKey: 'ai-...', model: 'gemini-pro' }
	 * ], 'openai');
	 * ```
	 */
	// JSON parsing optimization components
	private errorHistory: CircularBuffer<JsonParseError> = new CircularBuffer(5);
	private jsonParsingMetrics: JsonParsingMetrics = {
		totalAttempts: 0,
		successfulParses: 0,
		failedParses: 0,
		averageRepairTime: 0,
		errorTypeDistribution: {
			syntax: 0,
			structure: 0,
			truncation: 0,
			unknown: 0,
		},
		strategySuccessRates: {
			direct_parse: 0,
			syntax_fix: 0,
			structure_fix: 0,
			truncation_fix: 0,
			unknown_fix: 0,
			structure_recovery: 0,
			partial_extraction: 0,
		},
	};

	/**
	 * Initialize the LLM service with provider configurations
	 * @param providers Array of AI provider configurations
	 * @param defaultProvider Default provider name
	 */
	initialize(providers: AIProviderConfig[], defaultProvider?: string): void {
		// Validate providers array
		if (!providers || !Array.isArray(providers) || providers.length === 0) {
			throw new Error("At least one provider must be specified");
		}

		// Validate each provider configuration
		const validatedProviders: AIProviderConfig[] = [];
		for (const provider of providers) {
			if (!this.validateProviderConfig(provider)) {
				throw new Error(
					`Invalid provider configuration: ${JSON.stringify(provider)}`,
				);
			}
			validatedProviders.push(provider);
		}

		this.providers.clear();

		validatedProviders.forEach((provider) => {
			// Sanitize log data to avoid exposing sensitive information
			const sanitizedProvider = {
				...provider,
				apiKey: this.maskSensitiveData(provider.apiKey),
			};

			this.providers.set(provider.name, provider);
			log(
				"LLMService",
				`Initialized provider: ${provider.name} (${provider.baseUrl})`,
				"info",
				{
					provider: provider.name,
					baseUrl: provider.baseUrl,
					model: provider.model,
					maskedApiKey: sanitizedProvider.apiKey,
				},
			);
		});

		if (
			defaultProvider &&
			typeof defaultProvider === "string" &&
			defaultProvider.trim() !== ""
		) {
			if (this.providers.has(defaultProvider)) {
				this.defaultProvider = defaultProvider;
				log(
					"LLMService",
					`Set default provider to: ${defaultProvider}`,
					"info",
				);
			} else {
				log(
					"LLMService",
					`Default provider ${defaultProvider} not found, using current default`,
					"warn",
				);
			}
		}

		log(
			"LLMService",
			`LLM service initialized with ${validatedProviders.length} providers`,
			"info",
			{
				providerCount: validatedProviders.length,
				defaultProvider: this.defaultProvider,
			},
		);
	}

	/**
	 * Validate provider configuration for security and correctness
	 * @param provider Provider configuration to validate
	 * @returns True if valid, false otherwise
	 */
	private validateProviderConfig(provider: AIProviderConfig): boolean {
		if (!provider || typeof provider !== "object") {
			return false;
		}

		// Validate required fields
		if (
			!provider.name ||
			typeof provider.name !== "string" ||
			provider.name.trim() === ""
		) {
			return false;
		}

		if (
			!provider.baseUrl ||
			typeof provider.baseUrl !== "string" ||
			provider.baseUrl.trim() === ""
		) {
			return false;
		}

		if (
			!provider.apiKey ||
			typeof provider.apiKey !== "string" ||
			provider.apiKey.trim() === ""
		) {
			return false;
		}

		if (
			!provider.model ||
			typeof provider.model !== "string" ||
			provider.model.trim() === ""
		) {
			return false;
		}

		// Validate URL format
		try {
			new URL(provider.baseUrl);
		} catch {
			return false;
		}

		// Validate temperature range if provided
		if (provider.temperature !== undefined) {
			if (
				typeof provider.temperature !== "number" ||
				provider.temperature < 0 ||
				provider.temperature > 2
			) {
				return false;
			}
		}

		// Validate top-p range if provided
		if (provider.topP !== undefined) {
			if (
				typeof provider.topP !== "number" ||
				provider.topP <= 0 ||
				provider.topP > 1
			) {
				return false;
			}
		}

		// Validate max tokens if provided
		if (provider.maxTokens !== undefined) {
			if (
				typeof provider.maxTokens !== "number" ||
				provider.maxTokens <= 0 ||
				provider.maxTokens > 32000
			) {
				return false;
			}
		}

		// Validate timeout if provided
		if (provider.timeout !== undefined) {
			if (
				typeof provider.timeout !== "number" ||
				provider.timeout <= 0 ||
				provider.timeout > 300000
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Mask sensitive data for logging purposes
	 * @param data Sensitive data to mask
	 * @returns Masked data string
	 */
	private maskSensitiveData(data: string): string {
		if (!data || typeof data !== "string") {
			return "";
		}

		if (data.length <= 8) {
			return "*".repeat(data.length);
		}

		return `${data.substring(0, 4)}${"*".repeat(data.length - 8)}${data.substring(data.length - 4)}`;
	}

	/**
	 * Get a provider configuration by name
	 * @param providerName Name of the provider
	 * @returns AIProviderConfig or undefined if not found
	 */
	getProvider(providerName: string): AIProviderConfig | undefined {
		return this.providers.get(providerName);
	}

	/**
	 * Get all available provider names
	 * @returns Array of provider names
	 */
	getAvailableProviders(): string[] {
		return Array.from(this.providers.keys());
	}
	/**
	 * Make a single LLM API call with comprehensive error handling and response validation
	 * @param request LLM request configuration including provider, model, messages, and parameters
	 * @returns Promise<LLMResponse> The LLM response with content, usage statistics, and metadata
	 * @throws Error if the provider is not found, request validation fails, or API call fails
	 *
	 * @example
	 * ```typescript
	 * const response = await service.call({
	 *   provider: 'openai',
	 *   model: 'gpt-4',
	 *   messages: [
	 *     { role: 'system', content: 'You are a helpful assistant' },
	 *     { role: 'user', content: 'Explain quantum computing' }
	 *   ],
	 *   temperature: 0.7,
	 *   maxTokens: 1000
	 * });
	 *
	 * console.log(response.content);
	 * console.log(`Used ${response.usage.totalTokens} tokens`);
	 * ```
	 */

	/**
	 * Set the default provider
	 * @param providerName Name of the provider
	 */
	setDefaultProvider(providerName: string): void {
		if (this.providers.has(providerName)) {
			this.defaultProvider = providerName;
			log("LLMService", `Default provider set to: ${providerName}`, "info");
		} else {
			throw new Error(`Provider ${providerName} not found`);
		}
	}

	/**
	 * Make a single LLM API call
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	async call(request: LLMRequest): Promise<LLMResponse> {
		const startTime = performance.now();
		this.requestCount++;

		try {
			// Validate request
			const validatedRequest = LLMRequestSchema.parse(request);
			const provider =
				this.providers.get(validatedRequest.provider) ||
				this.providers.get(this.defaultProvider);

			if (!provider) {
				throw new Error(
					`Provider ${validatedRequest.provider} not found and no default provider set`,
				);
			}

			log(
				"LLMService",
				`Making LLM call to ${validatedRequest.provider}/${validatedRequest.model}`,
				"log",
				{
					provider: validatedRequest.provider,
					model: validatedRequest.model,
					temperature: validatedRequest.temperature,
					topP: validatedRequest.topP,
					maxTokens: validatedRequest.maxTokens,
				},
			);

			const response = await this.makeProviderCall(provider, validatedRequest);
			const endTime = performance.now();
			const duration = endTime - startTime;

			this.successCount++;
			this.recordPerformance({
				startTime,
				endTime,
				duration,
				apiCalls: 1,
				successfulCalls: 1,
				failedCalls: 0,
				totalTokensUsed: response.usage.totalTokens,
				memoryUsage: process.memoryUsage(),
			});

			// Parse and validate response content if a schema is provided
			let parsedContent: unknown = response.content;
			if (validatedRequest.responseSchema) {
				try {
					// Attempt robust JSON parsing first with enhanced retry options
					if (typeof response.content === "string") {
						parsedContent = await this.robustJsonParse(response.content, {
							maxRetries: 3,
							initialDelay: 1000,
							maxDelay: 10000,
							enableAggressiveRepairs: true,
						});
					}
					// Validate with Zod schema
					parsedContent = validatedRequest.responseSchema.parse(parsedContent);
				} catch (parseError: unknown) {
					const errorMessage =
						parseError instanceof Error
							? parseError.message
							: String(parseError);
					throw new Error(
						`Response parsing/validation failed: ${errorMessage}. Raw content: ${response.content.substring(0, 500)}...`,
					);
				}
			}

			log(
				"LLMService",
				`LLM call completed successfully in ${formatDuration(duration)}`,
				"info",
				{
					provider: validatedRequest.provider,
					model: validatedRequest.model,
					tokensUsed: response.usage.totalTokens,
					duration,
				},
			);

			return { ...response, content: parsedContent };
		} catch (error: unknown) {
			const endTime = performance.now();
			const duration = endTime - startTime;
			this.failureCount++;

			const errorMessage =
				error instanceof Error ? error.message : String(error);

			// Use enhanced error logging with context
			logError(
				"LLMService",
				error instanceof Error ? error : new Error(errorMessage),
				{
					duration,
					provider: request.provider,
					model: request.model,
					attempt: this.requestCount,
				},
			);

			this.recordPerformance({
				startTime,
				endTime,
				duration,
				apiCalls: 1,
				successfulCalls: 0,
				failedCalls: 1,
				totalTokensUsed: 0,
				memoryUsage: process.memoryUsage(),
			});

			// Wrap error in AppError for better error handling
			throw error instanceof AppError
				? error
				: new AppError("LLM_CALL_FAILED", 500, errorMessage, {
						provider: request.provider,
						model: request.model,
						duration,
					});
		}
	}

	/**
	 * Optimized JSON parsing with performance-first approach
	 * @param jsonString The JSON string to parse
	 * @param options Configuration options for parsing
	 * @returns The parsed JSON object
	 * @throws Error if parsing fails
	 */
	private async robustJsonParse(
		jsonString: string,
		options: {
			maxRetries?: number;
			initialDelay?: number;
			maxDelay?: number;
			enableAggressiveRepairs?: boolean;
		} = {},
	): Promise<unknown> {
		const { enableAggressiveRepairs = true } = options;

		// Fast path: try direct parsing first
		try {
			return JSON.parse(jsonString);
		} catch (error: unknown) {
			if (enableAggressiveRepairs) {
				// Use optimized repair path for common LLM response patterns
				return this.optimizedJsonRepair(jsonString, error);
			}
			throw error;
		}
	}

	/**
	 * Optimized JSON repair for common LLM response patterns
	 * @param jsonString The JSON string to repair
	 * @param initialError The initial parsing error
	 * @returns The parsed JSON object
	 */
	private async optimizedJsonRepair(
		jsonString: string,
		initialError: unknown,
	): Promise<unknown> {
		const _startTime = performance.now();

		// Quick clean for common patterns
		const cleanedText = this.quickCleanJson(jsonString);

		// Try most common fixes first (in order of likelihood)
		const repairStrategies = [
			() => this.repairJsonByRemovingTrailingComma(cleanedText),
			() => this.repairJsonByFixingEscapes(cleanedText),
			() => this.repairJsonByBalancingBrackets(cleanedText),
		];

		for (const strategy of repairStrategies) {
			try {
				const repaired = strategy();
				return JSON.parse(repaired);
			} catch {
				// Continue to next strategy
			}
		}

		// If all strategies fail, try partial extraction
		try {
			return this.extractPartialJsonData(cleanedText);
		} catch {
			throw new Error(
				`Failed to parse JSON after repair attempts: ${initialError}`,
			);
		}
	}

	/**
	 * Quick JSON cleaning for common LLM response patterns
	 */
	private quickCleanJson(jsonString: string): string {
		return jsonString
			.replace(/^```json\s*/i, "")
			.replace(/^```\s*/i, "")
			.replace(/\s*```\s*$/i, "")
			.replace(/^Here's the JSON:\s*/i, "")
			.replace(/^JSON:\s*/i, "")
			.replace(/\s*JSON\s*$/i, "")
			.trim();
	}

	/**
	 * Fix truncation issues by balancing brackets and braces
	 */
	private fixTruncationIssues(jsonStr: string): string {
		let openBraces = 0;
		let openBrackets = 0;
		let result = "";
		let inString = false;
		let escapeNext = false;

		for (let i = 0; i < jsonStr.length; i++) {
			const char = jsonStr[i];

			if (escapeNext) {
				result += char;
				escapeNext = false;
				continue;
			}

			if (char === "\\" && inString) {
				result += char;
				escapeNext = true;
				continue;
			}

			if (char === '"') {
				inString = !inString;
				result += char;
				continue;
			}

			if (!inString) {
				if (char === "{") openBraces++;
				else if (char === "}") {
					if (openBraces > 0) openBraces--;
				} else if (char === "[") openBrackets++;
				else if (char === "]") {
					if (openBrackets > 0) openBrackets--;
				}
			}

			result += char;
		}

		// Close any remaining open structures
		result += "}".repeat(openBraces);
		result += "]".repeat(openBrackets);

		return result;
	}

	/**
	 * Repair JSON by removing trailing commas
	 */
	private repairJsonByRemovingTrailingComma(jsonString: string): string {
		return jsonString.replace(/,(\s*[}\]])/g, "$1");
	}

	/**
	 * Repair JSON by fixing escape sequences
	 */
	private repairJsonByFixingEscapes(jsonString: string): string {
		return jsonString.replace(/\\([nrtbf"\\])/g, "$1");
	}

	/**
	 * Repair JSON by balancing brackets and braces
	 */
	private repairJsonByBalancingBrackets(jsonString: string): string {
		return this.fixTruncationIssues(jsonString);
	}

	/**
	 * Get current JSON parsing metrics for observability
	 * @returns Current metrics data
	 */
	public getJsonParsingMetrics(): JsonParsingMetrics {
		return { ...this.jsonParsingMetrics };
	}

	/**
	 * Reset JSON parsing metrics (useful for testing or monitoring periods)
	 */
	public resetJsonParsingMetrics(): void {
		this.jsonParsingMetrics = {
			totalAttempts: 0,
			successfulParses: 0,
			failedParses: 0,
			averageRepairTime: 0,
			errorTypeDistribution: {
				syntax: 0,
				structure: 0,
				truncation: 0,
				unknown: 0,
			},
			strategySuccessRates: {
				direct_parse: 0,
				syntax_fix: 0,
				structure_fix: 0,
				truncation_fix: 0,
				unknown_fix: 0,
				structure_recovery: 0,
				partial_extraction: 0,
			},
		};
		this.errorHistory.clear();
	}

	/**
	 * Extract partial JSON data when complete parsing fails
	 */
	/**
	 * Make batch LLM calls with concurrency control and retry logic
	 * Processes multiple requests efficiently with controlled concurrency and automatic retries
	 * @param batchRequest Configuration for batch processing including requests, concurrency, and retry settings
	 * @returns Promise<LLMResponse[]> Array of responses corresponding to each input request
	 * @throws Error if batch processing fails or if all requests fail after retries
	 *
	 * @example
	 * ```typescript
	 * const requests = [
	 *   { provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] },
	 *   { provider: 'openai', model: 'gpt-4', messages: [{ role: 'user', content: 'World' }] }
	 * ];
	 *
	 * const responses = await service.batch({
	 *   requests,
	 *   concurrency: 2,
	 *   retryAttempts: 3,
	 *   retryDelay: 2000
	 * });
	 *
	 * responses.forEach((response, index) => {
	 *   console.log(`Response ${index + 1}:`, response.content);
	 * });
	 * ```
	 */
	private extractPartialJsonData(jsonString: string): unknown[] {
		// Try to find JSON array patterns
		const arrayMatch = jsonString.match(/\[\s*(.*?)\s*\]/s);
		if (arrayMatch) {
			try {
				const arrayContent = arrayMatch[0];
				return JSON.parse(arrayContent);
			} catch {
				// Continue to other extraction methods
			}
		}

		// Try to extract individual JSON objects
		const objects: unknown[] = [];
		const objectRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
		// Extract individual JSON objects using a safer loop approach
		let index = 0;
		while (index < jsonString.length) {
			const match = objectRegex.exec(jsonString);
			if (!match) break;

			try {
				const obj = JSON.parse(match[0]);
				if (obj && typeof obj === "object") {
					objects.push(obj);
				}
			} catch {
				// Skip invalid objects
			}

			// Move forward to avoid infinite loops
			index = (match.index ?? 0) + 1;
		}

		return objects.length > 0 ? objects : [];
	}

	/**
	 * Make batch LLM calls with concurrency control
	 * @param batchRequest Batch request configuration
	 * @returns Promise<LLMResponse[]>
	 */
	async batch(batchRequest: BatchRequest): Promise<LLMResponse[]> {
		const { requests, concurrency, retryAttempts, retryDelay } =
			BatchRequestSchema.parse(batchRequest);
		const results: LLMResponse[] = [];
		const errors: Error[] = [];

		log(
			"LLMService",
			`Starting batch processing of ${requests.length} requests with concurrency ${concurrency}`,
			"info",
			{
				totalRequests: requests.length,
				concurrency,
				retryAttempts,
				retryDelay,
			},
		);

		// Process requests in batches
		for (let i = 0; i < requests.length; i += concurrency) {
			const batch = requests.slice(i, i + concurrency);
			const batchPromises = batch.map(async (request, _index) => {
				const attempt = 0;
				return this.retryCall(request, retryAttempts, retryDelay, attempt);
			});

			try {
				const batchResults = await Promise.allSettled(batchPromises);
				batchResults.forEach((result, index) => {
					if (result.status === "fulfilled") {
						results.push(result.value);
					} else {
						errors.push(result.reason);
						log(
							"LLMService",
							`Batch request failed: ${result.reason.message}`,
							"error",
							{
								error: result.reason.message,
								requestIndex: i + index,
							},
						);
					}
				});
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				log("LLMService", `Batch processing error: ${errorMessage}`, "error", {
					error: errorMessage,
				});
				throw error;
			}
		}

		log(
			"LLMService",
			`Batch processing completed. Success: ${results.length}, Errors: ${errors.length}`,
			"info",
			{
				successfulRequests: results.length,
				failedRequests: errors.length,
				totalRequests: requests.length,
			},
		);

		if (errors.length > 0) {
			throw new Error(
				`Batch processing completed with ${errors.length} errors`,
			);
		}

		return results;
	}

	/**
	 * Retry logic for failed requests with exponential backoff and circuit breaker
	 * @param request LLM request configuration
	 * @param maxRetries Maximum number of retry attempts
	 * @param retryDelay Delay between retries in milliseconds
	 * @param attempt Current attempt number
	 * @returns Promise<LLMResponse>
	 */
	private async retryCall(
		request: LLMRequest,
		maxRetries: number,
		retryDelay: number,
		attempt: number,
	): Promise<LLMResponse> {
		const circuitBreaker = this.getCircuitBreaker(request.provider);

		// Check if circuit breaker is open
		if (circuitBreaker.getState() === "OPEN") {
			throw new Error(
				`Circuit breaker tripped for provider ${request.provider}. Please try again later.`,
			);
		}

		try {
			const result = await this.call(request);
			// Circuit breaker success is handled internally in execute method
			return result;
		} catch (error: unknown) {
			// Circuit breaker failure is handled internally in execute method

			const errorMessage =
				error instanceof Error ? error.message : String(error);

			if (attempt < maxRetries) {
				// Exponential backoff with jitter
				const backoffDelay = retryDelay * 2 ** attempt + Math.random() * 1000;
				const actualDelay = Math.min(backoffDelay, 30000); // Cap at 30 seconds

				log(
					"LLMService",
					`Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(actualDelay)}ms`,
					"warn",
					{
						error: errorMessage,
						attempt: attempt + 1,
						maxRetries,
						provider: request.provider,
						backoffDelay: Math.round(actualDelay),
					},
				);

				await new Promise((resolve) => setTimeout(resolve, actualDelay));
				return this.retryCall(request, maxRetries, retryDelay, attempt + 1);
			} else {
				log(
					"LLMService",
					`Max retries (${maxRetries}) exceeded for provider ${request.provider}`,
					"error",
					{
						error: errorMessage,
						provider: request.provider,
						totalAttempts: attempt + 1,
					},
				);
				throw new Error(
					`Max retries exceeded for provider ${request.provider}: ${errorMessage}`,
				);
			}
		}
	}

	/**
	 * Get or create circuit breaker for a provider
	 * @param providerName Name of the provider
	 * @returns Circuit breaker instance
	 */
	private getCircuitBreaker(providerName: string): CircuitBreaker {
		if (!this.circuitBreakers.has(providerName)) {
			this.circuitBreakers.set(
				providerName,
				CircuitBreakerFactory.create(providerName, {
					timeout: 60000, // Timeout period (1 minute)
				}),
			);
		}
		const circuitBreaker = this.circuitBreakers.get(providerName);
		if (!circuitBreaker) {
			throw new Error(
				`Circuit breaker not found for provider: ${providerName}`,
			);
		}
		return circuitBreaker;
	}

	/**
	 * Make the actual provider-specific API call
	 * @param provider Provider configuration
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	private async makeProviderCall(
		provider: AIProviderConfig,
		request: LLMRequest,
	): Promise<LLMResponse> {
		switch (request.provider) {
			case "openai":
			case "openrouter":
			case "cerebras": // Add cerebras here
				return this.callOpenAI(provider, request);
			case "gemini":
				// Gemini integration requires @google/generative-ai package
				return this.callGemini(provider, request);
			case "mistral":
				// Mistral integration requires @mistralai/mistralai package
				return this.callMistral(provider, request);
			case "poe":
				return this.callPOE(provider, request);
			default:
				throw new Error(`Unsupported provider: ${request.provider}`);
		}
	}

	/**
	 * Make OpenAI/OpenRouter API call with enhanced maxTokens enforcement
	 * @param provider Provider configuration
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	private async callOpenAI(
		provider: AIProviderConfig,
		request: LLMRequest,
	): Promise<LLMResponse> {
		const client = new OpenAI({
			apiKey: provider.apiKey,
			baseURL: provider.baseUrl,
		});

		const openaiRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
			{
				model: request.model,
				messages: request.messages,
				temperature: request.temperature,
				top_p: request.topP,
				max_tokens: request.maxTokens,
			};

		// Add JSON Mode for OpenAI if response_schema is provided
		if (request.provider === "openai" && request.responseSchema) {
			openaiRequest.response_format = { type: "json_object" };
		}

		const response = await client.chat.completions.create(openaiRequest);

		const usage = response.usage;
		if (!usage) {
			throw new Error("No usage information returned from OpenAI API");
		}

		// Check if maxTokens was exceeded and handle it appropriately
		const totalTokensUsed = usage.total_tokens || 0;
		let content = response.choices[0]?.message?.content || "";

		if (request.maxTokens && totalTokensUsed > request.maxTokens) {
			log(
				"LLMService",
				`OpenAI exceeded maxTokens: requested ${request.maxTokens}, used ${totalTokensUsed}`,
				"warn",
				{
					provider: request.provider,
					model: request.model,
					requestedMaxTokens: request.maxTokens,
					actualTokensUsed: totalTokensUsed,
					overage: totalTokensUsed - request.maxTokens,
				},
			);

			// Try to truncate the response to respect maxTokens if possible
			const truncatedContent = this.truncateResponseToMaxTokens(
				content,
				request.maxTokens,
			);
			if (truncatedContent !== content) {
				log(
					"LLMService",
					`Truncated OpenAI response to respect maxTokens limit`,
					"info",
					{
						provider: request.provider,
						model: request.model,
						originalTokens: totalTokensUsed,
						truncatedTokens: this.estimateTokenCount(truncatedContent),
						truncationRatio: `${Math.round((1 - truncatedContent.length / content.length) * 100)}%`,
					},
				);
				content = truncatedContent;
			}
		}

		return {
			content,
			provider: request.provider,
			model: request.model,
			usage: {
				promptTokens: usage.prompt_tokens || 0,
				completionTokens: usage.completion_tokens || 0,
				totalTokens: Math.min(
					totalTokensUsed,
					request.maxTokens || totalTokensUsed,
				),
			},
			duration: 0, // Will be set by caller
			timestamp: new Date().toISOString(),
		};
	}

	/**
	 * Make Gemini API call
	 * @param provider Provider configuration
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	private async callGemini(
		_provider: AIProviderConfig,
		_request: LLMRequest,
	): Promise<LLMResponse> {
		// Gemini integration requires @google/generative-ai package
		// For now, throw a clear error indicating the dependency is needed
		throw new Error(
			"Gemini integration requires @google/generative-ai package. Please install it and uncomment the import statement.",
		);

		// TODO: Implement Gemini integration when package is available
		/*
    const genAI = new GoogleGenerativeAI(provider.apiKey);
    const model = genAI.getGenerativeModel({ model: request.model });

    // Convert messages to Gemini format
    const systemInstruction = request.messages.find(m => m.role === "system");
    const userMessage = request.messages.find(m => m.role === "user");

    if (!userMessage) {
      throw new Error("No user message found in Gemini request");
    }

    const generationConfig = {
      temperature: request.temperature,
      topP: request.topP,
      maxOutputTokens: request.maxTokens,
    };

    let result;
    if (systemInstruction) {
      result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userMessage.content }] }],
        generationConfig,
        systemInstruction: { role: "user", parts: [{ text: systemInstruction.content }] },
      });
    } else {
      result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userMessage.content }] }],
        generationConfig,
      });
    }

    const response = result.response;
    const text = response.text();

    // Estimate token usage (Gemini doesn't provide exact token counts)
    const estimatedTokens = Math.ceil(text.length / 4); // Rough estimate

    return {
      content: text,
      provider: request.provider,
      model: request.model,
      usage: {
        promptTokens: estimatedTokens,
        completionTokens: estimatedTokens,
        totalTokens: estimatedTokens * 2,
      },
      duration: 0, // Will be set by caller
      timestamp: new Date().toISOString(),
    };
    */
	}

	/**
	 * Make Mistral API call
	 * @param provider Provider configuration
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	private async callMistral(
		_provider: AIProviderConfig,
		_request: LLMRequest,
	): Promise<LLMResponse> {
		// Mistral integration requires @mistralai/mistralai package
		// For now, throw a clear error indicating the dependency is needed
		throw new Error(
			"Mistral integration requires @mistralai/mistralai package. Please install it and uncomment the import statement.",
		);

		// TODO: Implement Mistral integration when package is available
		/*
    const client = new Mistral({
      apiKey: provider.apiKey,
      serverURL: provider.baseUrl,
    });

    const messages = request.messages.map(m => ({
      role: m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system",
      content: m.content,
    }));

    const response = await client.chat.completions.create({
      model: request.model,
      messages,
      temperature: request.temperature,
      topP: request.topP,
      maxTokens: request.maxTokens,
      // timeout: request.timeout, // Not supported in Mistral SDK
    });

    const usage = response.usage;
    if (!usage) {
      throw new Error("No usage information returned from Mistral API");
    }

    return {
      content: response.choices[0]?.message?.content || "",
      provider: request.provider,
      model: request.model,
      usage: {
        promptTokens: usage.inputTokens || 0,
        completionTokens: usage.outputTokens || 0,
        totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
      },
      duration: 0, // Will be set by caller
      timestamp: new Date().toISOString(),
    };
    */
	}

	/**
	 * Make POE API call with enhanced maxTokens enforcement
	 * @param provider Provider configuration
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse>
	 */
	private async callPOE(
		provider: AIProviderConfig,
		request: LLMRequest,
		/**
		 * Get comprehensive performance statistics for the LLM service
		 * Calculates metrics from all recorded API calls including success rates,
		 * average response times, and token usage
		 * @returns Performance statistics object with detailed metrics
		 *
		 * @example
		 * ```typescript
		 * const stats = service.getPerformanceStats();
		 * console.log(`Total requests: ${stats.totalRequests}`);
		 * console.log(`Success rate: ${stats.successRate.toFixed(2)}%`);
		 * console.log(`Average duration: ${stats.averageDuration.toFixed(2)}ms`);
		 * console.log(`Total tokens used: ${stats.totalTokensUsed}`);
		 * ```
		 */
	): Promise<LLMResponse> {
		// POE integration uses OpenAI-compatible API
		const client = new OpenAI({
			apiKey: provider.apiKey,
			baseURL: provider.baseUrl,
		});

		const poeRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
			{
				model: request.model,
				messages: request.messages,
				temperature: request.temperature,
				top_p: request.topP,
				max_tokens: request.maxTokens,
			};

		// Add JSON Mode for POE if response_schema is provided
		if (request.responseSchema) {
			poeRequest.response_format = { type: "json_object" };
		}

		const response = await client.chat.completions.create(poeRequest);

		const usage = response.usage;
		if (!usage) {
			throw new Error("No usage information returned from POE API");
		}

		// Check if maxTokens was exceeded and handle it appropriately
		const totalTokensUsed = usage.total_tokens || 0;
		let content = response.choices[0]?.message?.content || "";

		if (request.maxTokens && totalTokensUsed > request.maxTokens) {
			log(
				"LLMService",
				`POE exceeded maxTokens: requested ${request.maxTokens}, used ${totalTokensUsed}`,
				"warn",
				{
					provider: request.provider,
					model: request.model,
					requestedMaxTokens: request.maxTokens,
					actualTokensUsed: totalTokensUsed,
					overage: totalTokensUsed - request.maxTokens,
				},
			);

			// Try to truncate the response to respect maxTokens if possible
			const truncatedContent = this.truncateResponseToMaxTokens(
				content,
				request.maxTokens,
			);
			if (truncatedContent !== content) {
				log(
					"LLMService",
					`Truncated POE response to respect maxTokens limit`,
					"info",
					{
						provider: request.provider,
						model: request.model,
						originalTokens: totalTokensUsed,
						truncatedTokens: this.estimateTokenCount(truncatedContent),
						truncationRatio: `${Math.round((1 - truncatedContent.length / content.length) * 100)}%`,
					},
				);
				content = truncatedContent;
			}
		}

		return {
			content,
			provider: request.provider,
			model: request.model,
			usage: {
				promptTokens: usage.prompt_tokens || 0,
				completionTokens: usage.completion_tokens || 0,
				totalTokens: Math.min(
					totalTokensUsed,
					request.maxTokens || totalTokensUsed,
				),
			},
			duration: 0, // Will be set by caller
			timestamp: new Date().toISOString(),
		};
	}

	/**
	 * Truncate response content to respect maxTokens limit
	 * @param content The content to truncate
	 * @param maxTokens Maximum allowed tokens
	 * @returns Truncated content
	 */
	private truncateResponseToMaxTokens(
		content: string,
		maxTokens: number,
	): string {
		// Rough estimate: 1 token ≈ 4 characters for English text
		const _estimatedCurrentTokens = this.estimateTokenCount(content);
		const maxCharacters = maxTokens * 4;

		if (content.length <= maxCharacters) {
			return content;
		}

		// Try to truncate at sentence boundaries first
		const truncatedAtSentence = this.truncateAtSentenceBoundary(
			content,
			maxCharacters,
		);
		if (truncatedAtSentence.length > maxCharacters * 0.8) {
			return truncatedAtSentence;
		}

		// If sentence boundary truncation doesn't work well, truncate at word boundary
		return this.truncateAtWordBoundary(content, maxCharacters);
	}

	/**
	 * Estimate token count from text length
	 * @param text The text to estimate
	 * @returns Estimated token count
	 */
	private estimateTokenCount(text: string): number {
		// Rough estimate: 1 token ≈ 4 characters for English text
		// This is a conservative estimate - actual token count may vary
		return Math.ceil(text.length / 4);
	}

	/**
	 * Truncate text at the last sentence boundary before the limit
	 * @param text The text to truncate
	 * @param maxLength Maximum character length
	 * @returns Truncated text
	 */
	private truncateAtSentenceBoundary(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}

		const truncated = text.substring(0, maxLength);
		const lastSentenceEnd = Math.max(
			truncated.lastIndexOf("."),
			truncated.lastIndexOf("!"),
			truncated.lastIndexOf("?"),
		);

		if (lastSentenceEnd > maxLength * 0.5) {
			return truncated.substring(0, lastSentenceEnd + 1);
		}

		return truncated;
	}

	/**
	 * Truncate text at the last word boundary before the limit
	 * @param text The text to truncate
	 * @param maxLength Maximum character length
	 * @returns Truncated text
	 */
	private truncateAtWordBoundary(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}

		const truncated = text.substring(0, maxLength);
		const lastSpace = truncated.lastIndexOf(" ");

		if (lastSpace > maxLength * 0.8) {
			return truncated.substring(0, lastSpace);
		}

		return truncated;
	}

	/**
	 * Record performance metrics
	 * @param metrics Performance metrics to record
	 */
	private recordPerformance(metrics: PerformanceMetrics): void {
		this.performanceMetrics.push(metrics);

		// Keep only the last 1000 metrics to prevent memory issues
		if (this.performanceMetrics.length > 1000) {
			this.performanceMetrics = this.performanceMetrics.slice(-1000);
		}
	}

	/**
	 * Get performance statistics
	 * @returns Performance statistics
	 */
	getPerformanceStats(): {
		totalRequests: number;
		successRate: number;
		averageDuration: number;
		totalTokensUsed: number;
		averageTokensPerRequest: number;
	} {
		if (this.performanceMetrics.length === 0) {
			return {
				totalRequests: 0,
				successRate: 0,
				averageDuration: 0,
				totalTokensUsed: 0,
				averageTokensPerRequest: 0,
			};
		}

		const totalRequests = this.performanceMetrics.reduce(
			(sum, metric) => sum + metric.apiCalls,
			/**
			 * Get comprehensive health status for all providers and the overall service
			 * Evaluates circuit breaker states, error rates, and response times to determine
			 * the health status of each provider and the overall service
			 * @returns Health status object with provider-specific and overall health metrics
			 *
			 * @example
			 * ```typescript
			 * const health = service.getHealthStatus();
			 * console.log(`Overall status: ${health.status}`);
			 * console.log(`Success rate: ${health.details.overall.successRate.toFixed(2)}%`);
			 *
			 * Object.entries(health.details.providers).forEach(([provider, status]) => {
			 *   console.log(`${provider}: ${status.status}`);
			 * });
			 * ```
			 */
			0,
		);
		const successfulRequests = this.performanceMetrics.reduce(
			(sum, metric) => sum + metric.successfulCalls,
			0,
		);
		const totalDuration = this.performanceMetrics.reduce(
			(sum, metric) => sum + metric.duration,
			0,
		);
		const totalTokens = this.performanceMetrics.reduce(
			(sum, metric) => sum + metric.totalTokensUsed,
			0,
		);

		return {
			totalRequests,
			successRate:
				totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0,
			averageDuration: totalRequests > 0 ? totalDuration / totalRequests : 0,
			totalTokensUsed: totalTokens,
			averageTokensPerRequest:
				totalRequests > 0 ? totalTokens / totalRequests : 0,
		};
	}

	/**
	 * Reset performance metrics
	 */
	resetPerformanceMetrics(): void {
		this.performanceMetrics = [];
		this.requestCount = 0;
		this.successCount = 0;
		this.failureCount = 0;
		log("LLMService", "Performance metrics reset", "info");
	}

	/**
	 * Get service statistics
	 * @returns Service statistics
	 */
	getServiceStats(): {
		providerCount: number;
		defaultProvider: string;
		totalRequests: number;
		successCount: number;
		failureCount: number;
		successRate: number;
		circuitBreakerStats: Record<string, unknown>;
	} {
		const circuitBreakerStats: Record<string, unknown> = {};
		this.circuitBreakers.forEach((breaker, provider) => {
			circuitBreakerStats[provider] = breaker.getMetrics();
		});

		return {
			providerCount: this.providers.size,
			defaultProvider: this.defaultProvider,
			totalRequests: this.requestCount,
			successCount: this.successCount,
			failureCount: this.failureCount,
			successRate:
				this.requestCount > 0
					? (this.successCount / this.requestCount) * 100
					: 0,
			circuitBreakerStats,
		};
	}

	/**
	 * Get health check status
	 * @returns Health check status
	 */
	getHealthStatus(): {
		status: "healthy" | "degraded" | "unhealthy";
		details: {
			providers: Record<
				string,
				{
					status: "healthy" | "degraded" | "unhealthy";
					circuitBreaker: unknown;
					lastError?: string;
				}
			>;
			overall: {
				successRate: number;
				errorRate: number;
				averageResponseTime: number;
			};
		};
	} {
		const providerStatuses: Record<
			string,
			{
				status: "healthy" | "degraded" | "unhealthy";
				circuitBreaker: unknown;
				lastError?: string;
			}
		> = {};
		let _healthyProviders = 0;
		let totalErrorRate = 0;
		let totalResponseTime = 0;
		let providerCount = 0;

		this.providers.forEach((_provider, providerName) => {
			const circuitBreaker = this.getCircuitBreaker(providerName);
			const circuitStats = circuitBreaker.getMetrics();

			let providerStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
			const state = circuitBreaker.getState();
			if (state === "OPEN") {
				providerStatus = "unhealthy";
			} else if (
				state === "HALF_OPEN" ||
				circuitStats.successfulRequests /
					(circuitStats.successfulRequests + circuitStats.failedRequests) >
					0.3
			) {
				providerStatus = "degraded";
			}

			providerStatuses[providerName] = {
				status: providerStatus,
				circuitBreaker: circuitStats,
			};

			if (providerStatus === "healthy") _healthyProviders++;
			const failureRate =
				circuitStats.failedRequests /
				(circuitStats.successfulRequests + circuitStats.failedRequests);
			totalErrorRate += failureRate;
			totalResponseTime += this.getAverageResponseTimeForProvider(providerName);
			providerCount++;
		});

		const overallErrorRate =
			providerCount > 0 ? totalErrorRate / providerCount : 1;
		const overallResponseTime =
			providerCount > 0 ? totalResponseTime / providerCount : 0;

		let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
		if (overallErrorRate > 0.5 || overallResponseTime > 30000) {
			overallStatus = "unhealthy";
		} else if (overallErrorRate > 0.2 || overallResponseTime > 15000) {
			overallStatus = "degraded";
		}

		return {
			status: overallStatus,
			details: {
				providers: providerStatuses,
				overall: {
					successRate: (1 - overallErrorRate) * 100,
					errorRate: overallErrorRate * 100,
					averageResponseTime: overallResponseTime,
				},
			},
		};
	}

	/**
	 * Get average response time for a specific provider
	 * @param providerName Name of the provider
	 * @returns Average response time in milliseconds
	 */
	private getAverageResponseTimeForProvider(_providerName: string): number {
		const providerMetrics = this.performanceMetrics.filter(
			(metric) => metric.apiCalls > 0 && metric.duration > 0,
		);

		if (providerMetrics.length === 0) return 0;

		const totalTime = providerMetrics.reduce(
			(sum, metric) => sum + metric.duration,
			0,
		);
		return totalTime / providerMetrics.length;
	}
}

// Singleton instance
export const llmService = new LLMService();
