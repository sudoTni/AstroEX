/**
 * Delay utilities for rate limiting and anti-detection
 */

/**
 * Generate random jitter delay within a range
 * @param minDelay Minimum delay in seconds
 * @param maxDelay Maximum delay in seconds
 * @returns Random delay between minDelay and maxDelay
 */
export function getRandomJitterDelay(
	minDelay: number,
	maxDelay: number,
): number {
	if (minDelay < 0 || maxDelay < 0) {
		throw new Error("Delay values must be positive");
	}
	if (minDelay > maxDelay) {
		throw new Error("minDelay cannot be greater than maxDelay");
	}

	const minMs = minDelay * 1000;
	const maxMs = maxDelay * 1000;
	return Math.random() * (maxMs - minMs) + minMs;
}

/**
 * Sleep with random jitter
 * @param minDelay Minimum delay in seconds
 * @param maxDelay Maximum delay in seconds
 */
export async function sleepWithJitter(
	minDelay: number,
	maxDelay: number,
): Promise<void> {
	const delayMs = getRandomJitterDelay(minDelay, maxDelay);
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Exponential backoff retry configuration
 */
export interface RetryConfig {
	maxRetries: number;
	baseDelay: number;
	maxDelay: number;
	backoffFactor: number;
	jitter: boolean;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelay: 1000, // 1 second
	maxDelay: 30000, // 30 seconds
	backoffFactor: 2,
	jitter: true,
};

/**
 * Retry function with exponential backoff and jitter
 * @param fn Function to retry
 * @param config Retry configuration
 * @param onRetry Callback function called on each retry
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
	onRetry?: (attempt: number, error: Error, delay: number) => void,
): Promise<T> {
	const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
	let lastError: Error;

	for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt === finalConfig.maxRetries) {
				throw lastError;
			}

			const delay = Math.min(
				finalConfig.baseDelay * finalConfig.backoffFactor ** attempt,
				finalConfig.maxDelay,
			);

			// Add jitter to delay
			const jitteredDelay = finalConfig.jitter
				? delay + Math.random() * delay * 0.1
				: delay;

			if (onRetry) {
				onRetry(attempt + 1, lastError, jitteredDelay);
			}

			await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
		}
	}

	throw lastError!;
}

/**
 * Check if an HTTP status code indicates a retryable error
 * @param statusCode HTTP status code
 * @returns True if the error is retryable
 */
export function isRetryableError(statusCode: number): boolean {
	// Retry on server errors (5xx) and some client errors
	return (
		statusCode >= 500 ||
		statusCode === 408 || // Request Timeout
		statusCode === 429 || // Too Many Requests
		statusCode === 502 || // Bad Gateway
		statusCode === 503 || // Service Unavailable
		statusCode === 504
	); // Gateway Timeout
}

/**
 * Check if an error message indicates a network-related issue
 * @param error Error object or message
 * @returns True if the error appears to be network-related
 */
export function isNetworkError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message.toLowerCase()
			: String(error).toLowerCase();

	return (
		message.includes("network") ||
		message.includes("timeout") ||
		message.includes("connection") ||
		message.includes("fetch") ||
		message.includes("request") ||
		message.includes("errno") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("enotfound")
	);
}
