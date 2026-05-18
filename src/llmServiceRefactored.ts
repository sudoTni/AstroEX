/**
 * Refactored LLM Service
 * Version 3.2.1
 *
 * This module provides a unified interface for all LLM API calls across the application.
 * It uses the modular architecture with provider implementations, JSON parsing, and circuit breaker.
 *
 * Features:
 * - Multi-provider support with automatic provider selection
 * - Circuit breaker pattern for fault tolerance
 * - Optimized JSON parsing with repair strategies
 * - Performance monitoring and metrics collection
 * - Batch processing with concurrency control
 * - Comprehensive error handling and retry logic
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.1
 */

import { type CircuitBreaker, CircuitBreakerFactory } from "./circuitBreaker";
import { jsonParser } from "./jsonParser";
import { OpenAIProvider } from "./providers/openaiProvider";
import type {
	AIProviderConfig,
	LLMRequest,
	LLMResponse,
	PerformanceMetrics,
} from "./types";
import { AppError, log, logError } from "./utils";

// Provider registry for easy instantiation
const PROVIDER_REGISTRY = {
	openai: OpenAIProvider,
	// Additional providers can be added here
};

/**
 * Refactored LLM Service with modular architecture
 */
export class LLMService {
	private providers: Map<string, unknown> = new Map();
	private circuitBreakers: Map<string, unknown> = new Map();
	private metrics: PerformanceMetrics;

	constructor() {
		this.metrics = {
			startTime: Date.now(),
			endTime: 0,
			duration: 0,
			apiCalls: 0,
			successfulCalls: 0,
			failedCalls: 0,
			totalTokensUsed: 0,
			memoryUsage: {
				rss: 0,
				heapTotal: 0,
				heapUsed: 0,
				external: 0,
			},
		};
	}

	/**
	 * Initialize providers with configurations
	 * @param providerConfigs Array of provider configurations
	 */
	initializeProviders(providerConfigs: AIProviderConfig[]): void {
		for (const config of providerConfigs) {
			try {
				const ProviderClass = PROVIDER_REGISTRY[config.name];
				if (!ProviderClass) {
					throw new AppError(
						"PROVIDER_NOT_FOUND",
						400,
						`Provider '${config.name}' is not supported`,
						{ provider: config.name },
					);
				}

				const provider = new ProviderClass(config);
				if (!provider.validateConfig()) {
					throw new AppError(
						"INVALID_PROVIDER_CONFIG",
						400,
						`Invalid configuration for provider '${config.name}'`,
						{ provider: config.name, config },
					);
				}

				this.providers.set(config.name, provider);
				this.circuitBreakers.set(
					config.name,
					CircuitBreakerFactory.createForService(
						config.name as "openai" | "gemini" | "mistral" | "openrouter",
					),
				);

				log(
					"LLMService",
					`Provider '${config.name}' initialized successfully`,
					"info",
				);
			} catch (error) {
				logError(
					"LLMService",
					error instanceof Error ? error : new Error(String(error)),
					{
						provider: config.name,
						action: "initialization",
					},
				);
			}
		}
	}

	/**
	 * Make an API call to the specified provider
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse> The provider response
	 * @throws AppError if the API call fails
	 */
	async call(request: LLMRequest): Promise<LLMResponse> {
		const startTime = performance.now();
		this.metrics.apiCalls++;

		try {
			const provider = this.getProvider(request.provider);
			const circuitBreaker = this.circuitBreakers.get(request.provider);

			// Execute with circuit breaker protection
			const response = await (circuitBreaker as CircuitBreaker).execute(
				`llm_call_${request.provider}`,
				async () => {
					const llmResponse = await (provider as any).call(request);
					this.metrics.totalTokensUsed += llmResponse.usage.totalTokens;
					this.metrics.successfulCalls++;
					return llmResponse;
				},
				{ model: request.model, provider: request.provider },
			);

			const endTime = performance.now();
			this.updateMetrics(endTime - startTime);

			return response;
		} catch (error) {
			this.metrics.failedCalls++;
			const endTime = performance.now();
			this.updateMetrics(endTime - startTime);

			if (error instanceof AppError) {
				throw error;
			}

			throw new AppError(
				"LLM_SERVICE_ERROR",
				500,
				`Failed to call LLM provider: ${error instanceof Error ? error.message : String(error)}`,
				{
					provider: request.provider,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	/**
	 * Parse JSON with optimized repair strategies
	 * @param jsonString The JSON string to parse
	 * @param options Configuration options for parsing
	 * @returns The parsed JSON object
	 * @throws AppError if parsing fails
	 */
	async parseJson(
		jsonString: string,
		options: {
			maxRetries?: number;
			initialDelay?: number;
			maxDelay?: number;
			enableAggressiveRepairs?: boolean;
		} = {},
	): Promise<unknown> {
		try {
			return await jsonParser.parse(jsonString, options);
		} catch (error) {
			if (error instanceof AppError) {
				throw error;
			}

			throw new AppError(
				"JSON_PARSE_FAILED",
				400,
				`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ error: error instanceof Error ? error.message : String(error) },
			);
		}
	}

	/**
	 * Get provider instance
	 * @param providerName Name of the provider
	 * @returns Provider instance
	 * @throws AppError if provider not found
	 */
	private getProvider(providerName: string): unknown {
		const provider = this.providers.get(providerName);
		if (!provider) {
			throw new AppError(
				"PROVIDER_NOT_FOUND",
				400,
				`Provider '${providerName}' is not initialized`,
				{ provider: providerName },
			);
		}
		return provider;
	}

	/**
	 * Update performance metrics
	 * @param duration Request duration in milliseconds
	 */
	private updateMetrics(_duration: number): void {
		this.metrics.endTime = Date.now();
		this.metrics.duration = this.metrics.endTime - this.metrics.startTime;

		// Update memory usage
		const memoryUsage = process.memoryUsage();
		this.metrics.memoryUsage = {
			rss: memoryUsage.rss,
			heapTotal: memoryUsage.heapTotal,
			heapUsed: memoryUsage.heapUsed,
			external: memoryUsage.external,
		};
	}

	/**
	 * Get performance metrics
	 * @returns Current performance metrics
	 */
	getMetrics(): PerformanceMetrics {
		return { ...this.metrics };
	}

	/**
	 * Get JSON parsing metrics
	 * @returns JSON parsing performance metrics
	 */
	getJsonParsingMetrics(): unknown {
		return jsonParser.getMetrics();
	}

	/**
	 * Get circuit breaker metrics
	 * @param providerName Name of the provider
	 * @returns Circuit breaker metrics
	 */
	getCircuitBreakerMetrics(providerName: string): unknown {
		const circuitBreaker = this.circuitBreakers.get(providerName);
		if (!circuitBreaker) {
			throw new AppError(
				"PROVIDER_NOT_FOUND",
				400,
				`Provider '${providerName}' is not initialized`,
				{ provider: providerName },
			);
		}
		return (circuitBreaker as CircuitBreaker).getMetrics();
	}

	/**
	 * Reset all metrics
	 */
	resetMetrics(): void {
		this.metrics = {
			startTime: Date.now(),
			endTime: 0,
			duration: 0,
			apiCalls: 0,
			successfulCalls: 0,
			failedCalls: 0,
			totalTokensUsed: 0,
			memoryUsage: {
				rss: 0,
				heapTotal: 0,
				heapUsed: 0,
				external: 0,
			},
		};
		jsonParser.reset();
	}

	/**
	 * Check if a provider is available
	 * @param providerName Name of the provider
	 * @returns True if provider is available
	 */
	isProviderAvailable(providerName: string): boolean {
		const provider = this.providers.get(providerName);
		const circuitBreaker = this.circuitBreakers.get(providerName);

		return (
			!!provider &&
			!!circuitBreaker &&
			(circuitBreaker as CircuitBreaker).getState() !== "OPEN"
		);
	}

	/**
	 * Get available providers
	 * @returns Array of available provider names
	 */
	getAvailableProviders(): string[] {
		const available: string[] = [];

		for (const [providerName] of this.providers) {
			if (this.isProviderAvailable(providerName)) {
				available.push(providerName);
			}
		}

		return available;
	}

	/**
	 * Force reset circuit breaker for a provider
	 * @param providerName Name of the provider
	 */
	resetCircuitBreaker(providerName: string): void {
		const circuitBreaker = this.circuitBreakers.get(providerName);
		if (circuitBreaker) {
			(circuitBreaker as CircuitBreaker).reset();
			log(
				"LLMService",
				`Circuit breaker reset for provider '${providerName}'`,
				"info",
			);
		}
	}
}

// Export singleton instance for better performance
export const llmService = new LLMService();
