/**
 * OpenAI Provider Implementation
 *
 * Handles OpenAI API calls with optimized performance and error handling.
 * Extends the BaseProvider class to provide OpenAI-specific functionality.
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import { OpenAI } from "openai";
import type { LLMRequest, LLMResponse } from "../types";
import { BaseProvider } from "./baseProvider";

/**
 * OpenAI-specific provider implementation
 */
export class OpenAIProvider extends BaseProvider {
	private client: OpenAI;

	constructor(config: any) {
		super(config);
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
		});
	}

	/**
	 * Make an API call to OpenAI
	 * @param request LLM request configuration
	 * @returns Promise<LLMResponse> The OpenAI response
	 * @throws AppError if the API call fails
	 */
	async call(request: LLMRequest): Promise<LLMResponse> {
		const startTime = performance.now();

		try {
			this.logApiCall(request);

			const openaiRequest = this.buildOpenAIRequest(request);
			const response = await this.client.chat.completions.create(openaiRequest);

			const endTime = performance.now();
			const duration = endTime - startTime;

			const llmResponse: LLMResponse = {
				content: response.choices[0]?.message?.content || "",
				provider: "openai",
				model: request.model,
				usage: {
					promptTokens: response.usage?.prompt_tokens || 0,
					completionTokens: response.usage?.completion_tokens || 0,
					totalTokens: response.usage?.total_tokens || 0,
				},
				duration,
				timestamp: new Date().toISOString(),
			};

			this.logResponse(llmResponse, duration);
			return llmResponse;
		} catch (error) {
			const endTime = performance.now();
			const duration = endTime - startTime;

			this.logError(
				error instanceof Error ? error : new Error(String(error)),
				request,
				duration,
			);

			throw this.createError(
				`OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`,
				500,
				{ duration, request: this.sanitizeRequest(request) },
			);
		}
	}

	/**
	 * Build OpenAI-specific request parameters
	 * @param request LLM request configuration
	 * @returns OpenAI chat completion request
	 */
	private buildOpenAIRequest(request: LLMRequest) {
		const openaiRequest: any = {
			model: request.model,
			messages: request.messages,
			temperature: request.temperature ?? 0.6,
			top_p: request.topP ?? 0.95,
			max_tokens: request.maxTokens ?? 16000,
		};

		// Add timeout if specified
		if (request.timeout) {
			openaiRequest.timeout = request.timeout;
		}

		return openaiRequest;
	}

	/**
	 * Sanitize request for error logging
	 * @param request LLM request configuration
	 * @returns Sanitized request object
	 */
	private sanitizeRequest(request: LLMRequest): Partial<LLMRequest> {
		return {
			provider: request.provider,
			model: request.model,
			temperature: request.temperature,
			topP: request.topP,
			maxTokens: request.maxTokens,
			timeout: request.timeout,
			// Remove sensitive content from messages
			messages: request.messages.map((msg) => ({
				role: msg.role,
				content:
					msg.content.length > 100
						? `${msg.content.substring(0, 100)}...`
						: msg.content,
			})),
		};
	}

	/**
	 * Validate OpenAI-specific configuration
	 * @returns boolean True if configuration is valid
	 */
	validateConfig(): boolean {
		if (!super.validateConfig()) {
			return false;
		}

		// OpenAI-specific validation
		if (
			!this.config.baseUrl?.includes("openai.com") &&
			!this.config.baseUrl?.includes("openrouter.ai")
		) {
			return false;
		}

		return true;
	}
}
