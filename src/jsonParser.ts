/**
 * Optimized JSON Parser
 *
 * Provides high-performance JSON parsing with error recovery strategies
 * specifically designed for LLM response handling.
 *
 * Features:
 * - Pre-compiled regex patterns for common JSON issues
 * - Fast fallback mechanisms
 * - Comprehensive error recovery strategies
 * - Performance monitoring and metrics
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import { AppError } from "./utils";

// Pre-compiled regex patterns for better performance
const COMPILED_REGEX_PATTERNS = {
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

/**
 * Circular buffer implementation for error history
 */
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

/**
 * Optimized JSON parser with performance-first approach
 */
export class JsonParser {
	private errorHistory: CircularBuffer<JsonParseError> = new CircularBuffer(5);
	private metrics: JsonParsingMetrics = {
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
	 * Parse JSON with optimized repair strategies
	 * @param jsonString The JSON string to parse
	 * @param options Configuration options for parsing
	 * @returns The parsed JSON object
	 * @throws AppError if parsing fails
	 */
	async parse(
		jsonString: string,
		options: {
			maxRetries?: number;
			initialDelay?: number;
			maxDelay?: number;
			enableAggressiveRepairs?: boolean;
		} = {},
	): Promise<unknown> {
		const startTime = performance.now();
		const { enableAggressiveRepairs = true } = options;

		this.metrics.totalAttempts++;

		try {
			// Fast path: try direct parsing first
			const result = JSON.parse(jsonString);
			this.metrics.successfulParses++;
			this.recordParseSuccess(startTime);
			return result;
		} catch (error: unknown) {
			this.metrics.failedParses++;

			if (enableAggressiveRepairs) {
				// Use optimized repair path for common LLM response patterns
				const repaired = await this.optimizedJsonRepair(jsonString, error);
				this.recordParseSuccess(startTime);
				return repaired;
			}

			throw this.createParseError(error, "direct_parse", startTime);
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
		const startTime = performance.now();

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
			throw this.createParseError(
				initialError,
				"structure_recovery",
				startTime,
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

			if (char === '"' && !escapeNext) {
				inString = !inString;
				result += char;
				continue;
			}

			if (!inString) {
				if (char === "{") {
					openBraces++;
					result += char;
				} else if (char === "}") {
					if (openBraces > 0) {
						openBraces--;
						result += char;
					}
				} else if (char === "[") {
					openBrackets++;
					result += char;
				} else if (char === "]") {
					if (openBrackets > 0) {
						openBrackets--;
						result += char;
					}
				} else {
					result += char;
				}
			} else {
				result += char;
			}
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
		return jsonString.replace(COMPILED_REGEX_PATTERNS.TRAILING_COMMA, "$1");
	}

	/**
	 * Repair JSON by fixing escaped quotes
	 */
	private repairJsonByFixingEscapes(jsonString: string): string {
		return jsonString.replace(
			COMPILED_REGEX_PATTERNS.UNESCAPED_QUOTES,
			'$1\\"',
		);
	}

	/**
	 * Repair JSON by balancing brackets
	 */
	private repairJsonByBalancingBrackets(jsonString: string): string {
		return this.fixTruncationIssues(jsonString);
	}

	/**
	 * Extract partial JSON data as fallback
	 */
	private extractPartialJsonData(jsonString: string): unknown {
		// Try to extract the largest valid JSON object
		const jsonObjects = jsonString.match(/\{[^{}]*\}/g);
		if (jsonObjects && jsonObjects.length > 0) {
			// Return the largest JSON object found
			const largestObject = jsonObjects.reduce((largest, current) =>
				current.length > largest.length ? current : largest,
			);
			return JSON.parse(largestObject);
		}

		throw new Error("No valid JSON object found");
	}

	/**
	 * Record parse success and update metrics
	 */
	private recordParseSuccess(startTime: number): void {
		const duration = performance.now() - startTime;
		this.metrics.averageRepairTime =
			(this.metrics.averageRepairTime * (this.metrics.successfulParses - 1) +
				duration) /
			this.metrics.successfulParses;
	}

	/**
	 * Create standardized parse error
	 */
	private createParseError(
		error: unknown,
		strategy: RepairStrategy,
		startTime: number,
	): AppError {
		const duration = performance.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : String(error);

		const errorType: ErrorType = this.classifyError(errorMessage);

		this.metrics.errorTypeDistribution[errorType]++;
		this.metrics.strategySuccessRates[strategy]++;

		const parseError: JsonParseError = {
			attempt: this.metrics.totalAttempts,
			error: errorMessage,
			strategy,
			timestamp: Date.now(),
			errorType,
			repairDuration: duration,
		};

		this.errorHistory.push(parseError);

		return new AppError(
			"JSON_PARSE_FAILED",
			400,
			`Failed to parse JSON: ${errorMessage}. Strategy: ${strategy}`,
			{
				error: errorMessage,
				strategy,
				errorType,
				duration,
				attempt: this.metrics.totalAttempts,
			},
		);
	}

	/**
	 * Classify error type for better repair strategies
	 */
	private classifyError(errorMessage: string): ErrorType {
		const errorLower = errorMessage.toLowerCase();

		if (
			errorLower.includes("truncated") ||
			errorLower.includes("unexpected end")
		) {
			return "truncation";
		}

		if (
			errorLower.includes("unexpected token") ||
			errorLower.includes("invalid syntax")
		) {
			return "syntax";
		}

		if (errorLower.includes("property") || errorLower.includes("object")) {
			return "structure";
		}

		return "unknown";
	}

	/**
	 * Get parsing metrics for performance monitoring
	 */
	getMetrics(): JsonParsingMetrics {
		return { ...this.metrics };
	}

	/**
	 * Reset metrics and error history
	 */
	reset(): void {
		this.metrics = {
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
}

// Export singleton instance for better performance
export const jsonParser = new JsonParser();
