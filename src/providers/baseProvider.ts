/**
 * Base Provider Interface
 *
 * Defines the common interface and base functionality for all AI providers.
 * Each provider implementation should extend this base class.
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import type { AIProviderConfig, LLMRequest, LLMResponse } from "../types";
import { AppError, log, logError } from "../utils";

/**
 * Abstract base class for AI providers
 */
export abstract class BaseProvider {
	protected config: AIProviderConfig;
	protected name: string;

	constructor(config: AIProviderConfig) {
		this.config = config;
		this.name = config.name;
	}

	/**
	 * Make an API call to the provider
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse> The provider response
	 * @throws AppError if the API call fails
	 */
	abstract call(request: LLMRequest): Promise<LLMResponse>;

	/**
	 * Validate the provider configuration
	 * @returns boolean True if configuration is valid
	 */
	validateConfig(): boolean {
		if (!this.config) {
			return false;
		}

		const requiredFields = ["name", "baseUrl", "apiKey", "model"];
		for (const field of requiredFields) {
			if (!this.config[field as keyof AIProviderConfig]) {
				return false;
			}
		}

		// Validate URL format
		try {
			new URL(this.config.baseUrl);
		} catch {
			return false;
		}

		return true;
	}

	/**
	 * Log API call with sanitized information
	 * @param request LLM request configuration
	 */
	protected logApiCall(request: LLMRequest): void {
		const sanitizedConfig = {
			...this.config,
			apiKey: this.maskSensitiveData(this.config.apiKey),
		};

		log("Provider", `Making API call to ${this.name}/${request.model}`, "log", {
			provider: this.name,
			model: request.model,
			baseUrl: this.config.baseUrl,
			maskedApiKey: sanitizedConfig.apiKey,
			temperature: request.temperature,
			topP: request.topP,
			maxTokens: request.maxTokens,
		});
	}

	/**
	 * Log API response
	 * @param response LLM response
	 * @param duration Request duration in milliseconds
	 */
	protected logResponse(response: LLMResponse, duration: number): void {
		log("Provider", `API call completed in ${duration}ms`, "info", {
			provider: this.name,
			model: response.model,
			tokensUsed: response.usage.totalTokens,
			duration,
		});
	}

	/**
	 * Log API error
	 * @param error Error object
	 * @param request LLM request configuration
	 * @param duration Request duration in milliseconds
	 */
	protected logError(
		error: Error,
		request: LLMRequest,
		duration: number,
	): void {
		logError("Provider", error, {
			provider: this.name,
			model: request.model,
			duration,
			error: error.message,
		});
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
	 * Create standardized error response
	 * @param message Error message
	 * @param statusCode HTTP status code
	 * @param context Additional context
	 * @returns AppError
	 */
	protected createError(
		message: string,
		statusCode: number = 500,
		context?: Record<string, unknown>,
	): AppError {
		return new AppError(
			`PROVIDER_ERROR_${this.name.toUpperCase()}`,
			statusCode,
			message,
			{
				provider: this.name,
				model: this.config.model,
				...context,
			},
		);
	}
}
