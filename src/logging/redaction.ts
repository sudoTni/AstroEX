/**
 * AstroEX Logging System - Redaction & Sanitization
 *
 * Protects secrets, API keys, credentials, and sensitive data from log exposure.
 */

export const TOKEN_METRIC_KEY_PATTERN =
	/^(?:(?:max|prompt|completion|total|cached|reasoning)[_-]?tokens?|tokens|tokens?[_-](?:used|count)|token[_-]count|tokensUsed|tokenCount)$/i;

export const SENSITIVE_KEY_PATTERN =
	/(?:api[_-]?key|auth|authorization|cookie|password|secret|(?:^|[_-]|auth|access|refresh|bearer|session|id|csrf)token|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|jwt|cert)/i;

/**
 * Determine if an object key represents a sensitive credential or secret.
 * Explicitly exempts token count/budget metrics (such as maxTokens, promptTokens, tokensUsed).
 */
export function isSensitiveKey(key: string): boolean {
	if (TOKEN_METRIC_KEY_PATTERN.test(key)) {
		return false;
	}
	return SENSITIVE_KEY_PATTERN.test(key);
}

const STRING_SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> =
	[
		// URL-embedded basic authentication credentials
		{
			pattern: /(https?:\/\/)([^:\s@/]+):([^@\s/]+)@/g,
			replacement: "$1$2:[redacted]@",
		},
		// Bearer tokens in strings: Bearer xxx
		{
			pattern: /(Bearer\s+)[a-zA-Z0-9._\-]{10,}/gi,
			replacement: "$1[redacted]",
		},
		// Basic auth tokens in strings: Basic xxx
		{
			pattern: /(Basic\s+)[a-zA-Z0-9+/=]{10,}/gi,
			replacement: "$1[redacted]",
		},
		// OpenRouter API keys
		{
			pattern: /\bsk-or-v1-[a-f0-9]{64}\b/g,
			replacement: "sk-or-v1-[redacted]",
		},
		// OpenAI, Anthropic, and standard sk- keys
		{
			pattern: /\bsk-[a-zA-Z0-9_\-]{20,}\b/g,
			replacement: "sk-[redacted]",
		},
		// Google AI API keys
		{
			pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
			replacement: "AIza[redacted]",
		},
		// GitHub tokens
		{
			pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/g,
			replacement: "gh-[redacted]",
		},
		// Slack tokens
		{
			pattern: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/g,
			replacement: "xox-[redacted]",
		},
	];

const MAX_CONTEXT_DEPTH = 6;
const MAX_STRING_LENGTH = 10_000;
const MAX_ARRAY_LENGTH = 100;

/**
 * Sanitize a string by redacting known token and secret patterns.
 */
export function sanitizeString(value: string): string {
	if (!value) return value;
	let result = value;
	for (const { pattern, replacement } of STRING_SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	if (result.length > MAX_STRING_LENGTH) {
		return `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
	}
	return result;
}

/**
 * Format and sanitize an Error object, preserving name, message, stack, cause, and metadata.
 */
export function sanitizeError(
	error: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): Record<string, unknown> {
	if (!(error instanceof Error)) {
		return {
			type: typeof error,
			message: sanitizeString(String(error)),
		};
	}

	if (seen.has(error)) {
		return { message: "[circular error]" };
	}
	seen.add(error);

	const errorObj: Record<string, unknown> = {
		name: error.name,
		message: sanitizeString(error.message),
	};

	if (error.stack) {
		errorObj.stack = sanitizeString(error.stack);
	}

	// Capture custom error properties like code, statusCode, details, context
	const customProps = error as unknown as Record<string, unknown>;
	if ("code" in customProps && customProps.code !== undefined) {
		errorObj.code = customProps.code;
	}
	if ("statusCode" in customProps && customProps.statusCode !== undefined) {
		errorObj.statusCode = customProps.statusCode;
	}
	if ("details" in customProps && customProps.details !== undefined) {
		errorObj.details = sanitizeContext(customProps.details, depth + 1, seen);
	}
	if ("context" in customProps && customProps.context !== undefined) {
		errorObj.context = sanitizeContext(customProps.context, depth + 1, seen);
	}

	// Support Error.cause chain if available
	if (
		"cause" in error &&
		error.cause !== undefined &&
		depth < MAX_CONTEXT_DEPTH
	) {
		errorObj.cause = sanitizeError(error.cause, depth + 1, seen);
	}

	return errorObj;
}

/**
 * Deeply sanitize and normalize any context value for logging.
 * Redacts sensitive keys and values, breaks circular loops, and limits depth.
 */
export function sanitizeContext(
	value: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "undefined") {
		return undefined;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return sanitizeError(value, depth, seen);
	}
	if (depth >= MAX_CONTEXT_DEPTH) {
		return "[max-depth]";
	}
	if (typeof value !== "object") {
		return sanitizeString(String(value));
	}

	if (seen.has(value)) {
		return "[circular]";
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_ARRAY_LENGTH)
			.map((item) => sanitizeContext(item, depth + 1, seen));
	}

	if (value instanceof Set) {
		return Array.from(value)
			.slice(0, MAX_ARRAY_LENGTH)
			.map((item) => sanitizeContext(item, depth + 1, seen));
	}

	if (value instanceof Map) {
		const mapObj: Record<string, unknown> = {};
		for (const [k, v] of value.entries()) {
			const keyStr = String(k);
			mapObj[keyStr] = isSensitiveKey(keyStr)
				? "[redacted]"
				: sanitizeContext(v, depth + 1, seen);
		}
		return mapObj;
	}

	const normalized: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (isSensitiveKey(key)) {
			normalized[key] = "[redacted]";
		} else {
			normalized[key] = sanitizeContext(nestedValue, depth + 1, seen);
		}
	}
	return normalized;
}
