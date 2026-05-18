/**
 * Centralized error handling utilities for AstroEX
 */

// Import logging utility
import { log } from "./sharedCommandUtils";

/**
 * Base error class for AstroEX application errors
 */
export class AstroEXError extends Error {
	constructor(
		message: string,
		public code: string,
		public statusCode: number = 500,
		public details?: unknown,
	) {
		super(message);
		this.name = "AstroEXError";
		Error.captureStackTrace(this, AstroEXError);
	}
}

/**
 * Error types for different failure scenarios
 */
export enum ErrorType {
	// Configuration errors
	CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
	PRESET_NOT_FOUND = "PRESET_NOT_FOUND",
	API_KEY_INVALID = "API_KEY_INVALID",

	// File system errors
	FILE_NOT_FOUND = "FILE_NOT_FOUND",
	FILE_ACCESS_ERROR = "FILE_ACCESS_ERROR",
	FILE_WRITE_ERROR = "FILE_WRITE_ERROR",

	// API/Network errors
	API_REQUEST_FAILED = "API_REQUEST_FAILED",
	RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
	TIMEOUT_ERROR = "TIMEOUT_ERROR",

	// Validation errors
	VALIDATION_ERROR = "VALIDATION_ERROR",
	INVALID_INPUT = "INVALID_INPUT",
	SCHEMA_VALIDATION_FAILED = "SCHEMA_VALIDATION_FAILED",

	// Business logic errors
	BUSINESS_RULE_VIOLATION = "BUSINESS_RULE_VIOLATION",
	PROCESSING_ERROR = "PROCESSING_ERROR",

	// Security errors
	SECURITY_VIOLATION = "SECURITY_VIOLATION",
	UNAUTHORIZED_ACCESS = "UNAUTHORIZED_ACCESS",

	// System errors
	SYSTEM_ERROR = "SYSTEM_ERROR",
	UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Create a standardized error with consistent properties
 */
export function createError(
	type: ErrorType,
	message: string,
	details?: unknown,
	originalError?: unknown,
): AstroEXError {
	const error = new AstroEXError(
		message,
		type,
		getStatusCodeForErrorType(type),
		details,
	);

	// Preserve original error stack if available
	if (originalError instanceof Error) {
		error.stack = `${error.stack}\n\nOriginal Error:\n${originalError.stack}`;
	}

	return error;
}

/**
 * Get HTTP status code for error type
 */
function getStatusCodeForErrorType(type: ErrorType): number {
	const statusMap: Record<ErrorType, number> = {
		[ErrorType.CONFIGURATION_ERROR]: 500,
		[ErrorType.PRESET_NOT_FOUND]: 400,
		[ErrorType.API_KEY_INVALID]: 401,
		[ErrorType.FILE_NOT_FOUND]: 404,
		[ErrorType.FILE_ACCESS_ERROR]: 403,
		[ErrorType.FILE_WRITE_ERROR]: 500,
		[ErrorType.API_REQUEST_FAILED]: 502,
		[ErrorType.RATE_LIMIT_EXCEEDED]: 429,
		[ErrorType.TIMEOUT_ERROR]: 504,
		[ErrorType.VALIDATION_ERROR]: 400,
		[ErrorType.INVALID_INPUT]: 400,
		[ErrorType.SCHEMA_VALIDATION_FAILED]: 400,
		[ErrorType.BUSINESS_RULE_VIOLATION]: 422,
		[ErrorType.PROCESSING_ERROR]: 500,
		[ErrorType.SECURITY_VIOLATION]: 403,
		[ErrorType.UNAUTHORIZED_ACCESS]: 401,
		[ErrorType.SYSTEM_ERROR]: 500,
		[ErrorType.UNKNOWN_ERROR]: 500,
	};

	return statusMap[type] || 500;
}

/**
 * Wrap async function with standardized error handling
 */
export async function withErrorHandling<T>(
	fn: () => Promise<T>,
	errorType: ErrorType,
	context: string,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof AstroEXError) {
			throw error; // Re-throw AstroEX errors as-is
		}

		throw createError(
			errorType,
			`${context}: ${error instanceof Error ? error.message : String(error)}`,
			undefined,
			error,
		);
	}
}

/**
 * Wrap sync function with standardized error handling
 */
export function withErrorHandlingSync<T>(
	fn: () => T,
	errorType: ErrorType,
	context: string,
): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof AstroEXError) {
			throw error; // Re-throw AstroEX errors as-is
		}

		throw createError(
			errorType,
			`${context}: ${error instanceof Error ? error.message : String(error)}`,
			undefined,
			error,
		);
	}
}

/**
 * Retry wrapper with exponential backoff
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	maxRetries: number = 3,
	baseDelayMs: number = 1000,
	errorType: ErrorType = ErrorType.PROCESSING_ERROR,
	context: string = "Operation",
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			if (attempt === maxRetries) {
				break; // Don't wait after the last attempt
			}

			const delay = baseDelayMs * 2 ** (attempt - 1);
			log(
				"Retry",
				`Attempt ${attempt}/${maxRetries} failed for ${context}, retrying in ${delay}ms...`,
				"warn",
				{
					attempt,
					maxRetries,
					delay,
					error: error instanceof Error ? error.message : String(error),
				},
			);

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw createError(
		errorType,
		`${context} failed after ${maxRetries} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		undefined,
		lastError,
	);
}

/**
 * Circuit breaker implementation
 */
export interface CircuitBreakerState {
	isOpen: boolean;
	failureCount: number;
	successCount: number;
	lastFailureTime: number;
}

export class CircuitBreaker {
	private state: CircuitBreakerState = {
		isOpen: false,
		failureCount: 0,
		successCount: 0,
		lastFailureTime: 0,
	};

	private readonly failureThreshold: number;
	private readonly timeoutMs: number;
	private readonly halfOpenSuccessThreshold: number;

	constructor(
		failureThreshold: number = 5,
		timeoutMs: number = 60000,
		halfOpenSuccessThreshold: number = 3,
	) {
		this.failureThreshold = failureThreshold;
		this.timeoutMs = timeoutMs;
		this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;
	}

	/**
	 * Execute function with circuit breaker protection
	 */
	async execute<T>(
		fn: () => Promise<T>,
		context: string = "Operation",
	): Promise<T> {
		if (this.state.isOpen) {
			if (this.shouldReset()) {
				this.state.isOpen = false;
				this.state.failureCount = 0;
				this.state.successCount = 0;
				log("CircuitBreaker", `Circuit reset for ${context}`, "info");
			} else {
				throw createError(
					ErrorType.API_REQUEST_FAILED,
					`Circuit breaker is open for ${context}. Please try again later.`,
				);
			}
		}

		try {
			const result = await fn();
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordFailure(error);
			throw error;
		}
	}

	private shouldReset(): boolean {
		const now = Date.now();
		return now - this.state.lastFailureTime > this.timeoutMs;
	}

	private recordSuccess(): void {
		this.state.successCount++;
		this.state.failureCount = 0;

		if (this.state.successCount >= this.halfOpenSuccessThreshold) {
			this.state.isOpen = false;
			this.state.successCount = 0;
			log(
				"CircuitBreaker",
				"Circuit recovered after consecutive successes",
				"info",
			);
		}
	}

	private recordFailure(error: unknown): void {
		this.state.failureCount++;
		this.state.lastFailureTime = Date.now();

		if (this.state.failureCount >= this.failureThreshold) {
			this.state.isOpen = true;
			log(
				"CircuitBreaker",
				`Circuit tripped after ${this.state.failureCount} failures`,
				"error",
				{
					failureCount: this.state.failureCount,
					threshold: this.failureThreshold,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	getState(): CircuitBreakerState {
		return { ...this.state };
	}
}
