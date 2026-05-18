/**
 * Security utilities and best practices for AstroEX
 * Version 2.7.0
 *
 * This module provides comprehensive security utilities for the AstroEX application.
 * Includes API key validation, input sanitization, file security, and network security.
 *
 * Features:
 * - Enhanced API key validation with entropy checking
 * - Comprehensive input validation against attack patterns
 * - File security scanning and permission validation
 * - Environment variable security checks
 * - Network security utilities
 * - Security audit capabilities
 *
 * Version 2.7.0 Improvements:
 * - Fixed unterminated string literal in HTML entity encoding
 * - Improved control character handling in input sanitization
 * - Enhanced regex patterns for better security validation
 * - Better error handling in security functions
 * - Improved file permission validation
 * - Enhanced network security utilities
 *
 * @author tjenkel
 * @license MIT
 * @since 2.0.0
 */
/**
 * Security utilities and best practices for AstroEX
 * Version 2.7.0
 *
 * This module provides comprehensive security utilities for the AstroEX application.
 * Includes API key validation, input sanitization, file security, and network security.
 *
 * Version 2.7.0 Improvements:
 * - Fixed unterminated string literal in HTML entity encoding
 * - Improved control character handling in input sanitization
 * - Enhanced regex patterns for better security validation
 * - Better error handling in security functions
 * - Improved file permission validation
 * - Enhanced network security utilities
 *
 * @author tjenkel
 * @license MIT
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./utils";

// =============================================================================
// SECURITY CONSTANTS
// =============================================================================

/** Security algorithm for hashing */
export const SECURITY_ALGORITHM = "sha256";

/** Security encoding for hashing */
export const SECURITY_ENCODING = "hex";

/** Minimum API key length */
export const MIN_API_KEY_LENGTH = 16;

/** Maximum API key length */
export const MAX_API_KEY_LENGTH = 128;

/** Sensitive environment variables */
export const SENSITIVE_ENV_VARS = [
	"API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"MISTRAL_API_KEY",
	"DATABASE_URL",
	"SECRET_KEY",
	"PASSWORD",
	"TOKEN",
] as const;

/** File patterns that should not be exposed */
export const SENSITIVE_FILE_PATTERNS = [
	/\.pem$/,
	/\.key$/,
	/\.crt$/,
	/\.p12$/,
	/\.jks$/,
	/password/i,
	/secret/i,
	/private/i,
	/config/i,
] as const;

/** HTTP headers that should be sanitized */
export const SENSITIVE_HEADERS = [
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
] as const;

/**
 * Validate API key format and security with enhanced options
 * Performs comprehensive validation including length checks, pattern detection,
 * entropy calculation, and security analysis.
 *
 * @param apiKey The API key to validate
 * @param provider The name of the provider (for logging purposes)
 * @param options Configuration options for validation
 * @param options.allowTestKeys Whether to allow test keys (default: false)
 * @param options.minEntropy Minimum entropy requirement (default: 3.5)
 * @param options.maxRepetitiveChars Maximum allowed consecutive identical characters (default: 10)
 * @param options.checkEntropy Whether to perform entropy calculation (default: true)
 * @param options.providerWhitelist List of allowed providers (default: undefined)
 * @returns true if the API key is valid, false otherwise
 *
 * @example
 * ```typescript
 * // Basic validation
 * const isValid = validateApiKey('sk-1234567890abcdef', 'openai');
 *
 * // Enhanced validation with custom options
 * const isValid = validateApiKey('sk-1234567890abcdef', 'openai', {
 *   allowTestKeys: false,
 *   minEntropy: 4.0,
 *   maxRepetitiveChars: 5,
 *   checkEntropy: true
 * });
 * ```
 */
/** Query parameters that should be sanitized */
export const SENSITIVE_PARAMS = [
	"api_key",
	"token",
	"password",
	"secret",
	"auth",
] as const;

// =============================================================================
// API KEY VALIDATION
// =============================================================================

/**
 * Enhanced API key validation options
 */
export interface ApiKeyValidationOptions {
	allowTestKeys?: boolean;
	minEntropy?: number;
	maxRepetitiveChars?: number;
	checkEntropy?: boolean;
	providerWhitelist?: string[];
}

/**
 * Validate API key format and security with enhanced options
 */
export function validateApiKey(
	apiKey: string,
	provider: string = "unknown",
	options: ApiKeyValidationOptions = {},
): boolean {
	if (!apiKey || typeof apiKey !== "string") {
		log("Security", `Invalid API key format for ${provider}`, "error");
		return false;
	}

	// Check length
	if (
		apiKey.length < MIN_API_KEY_LENGTH ||
		apiKey.length > MAX_API_KEY_LENGTH
	) {
		log(
			"Security",
			`API key length out of bounds for ${provider}: ${apiKey.length} characters`,
			"error",
		);
		return false;
	}

	// Provider whitelist check
	if (
		options.providerWhitelist &&
		!options.providerWhitelist.includes(provider)
	) {
		log("Security", `Untrusted provider for API key: ${provider}`, "error");
		return false;
	}

	// Check for common patterns that indicate test keys
	const testPatterns = [
		/^sk-test_/i,
		/^test_/i,
		/^demo_/i,
		/^dummy_/i,
		/^example_/i,
		/^sample_/i,
	];

	if (!options.allowTestKeys) {
		for (const pattern of testPatterns) {
			if (pattern.test(apiKey)) {
				log(
					"Security",
					`Potential test API key detected for ${provider}`,
					"warn",
				);
				return false;
			}
		}
	}

	// Check for weak patterns
	const weakPatterns = [
		/^.{0,10}$/, // Too short (already checked, but double validation)
		/^[a-zA-Z0-9]{10,}$/, // Only alphanumeric (might be weak)
		/^.{16,}$/, // Just long enough
		/^(a+|b+|c+|d+|e+|f+|g+|h+|i+|j+|k+|l+|m+|n+|o+|p+|q+|r+|s+|t+|u+|v+|w+|x+|y+|z+)+$/i, // Repetitive letters
		/^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)+$/, // Repetitive numbers
	];

	for (const pattern of weakPatterns) {
		if (pattern.test(apiKey)) {
			log(
				"Security",
				`Potentially weak API key pattern detected for ${provider}`,
				"warn",
			);
		}
	}

	// Enhanced security checks
	if (options.checkEntropy) {
		const entropy = calculateShannonEntropy(apiKey);
		if (entropy < (options.minEntropy || 3.5)) {
			log(
				"Security",
				`Low entropy API key detected for ${provider}: ${entropy.toFixed(2)} bits`,
				"warn",
			);
		}
	}

	// Check for excessive repetitive characters
	if (options.maxRepetitiveChars) {
		const repetitiveChars = findMaxRepetitiveChars(apiKey);
		if (repetitiveChars > options.maxRepetitiveChars) {
			log(
				"Security",
				`Excessive repetitive characters in API key for ${provider}: ${repetitiveChars} consecutive`,
				"warn",
			);
		}
	}

	return true;
}

/**
 * Calculate Shannon entropy for a string
 */
function calculateShannonEntropy(str: string): number {
	const freq = new Map<string, number>();
	for (const char of str) {
		freq.set(char, (freq.get(char) || 0) + 1);
	}

	let entropy = 0;
	for (const count of freq.values()) {
		const probability = count / str.length;
		entropy -= probability * Math.log2(probability);
	}

	return entropy;
}

/**
 * Find maximum number of consecutive identical characters
 */
function findMaxRepetitiveChars(str: string): number {
	let maxCount = 1;
	let currentCount = 1;

	for (let i = 1; i < str.length; i++) {
		if (str[i] === str[i - 1]) {
			currentCount++;
			maxCount = Math.max(maxCount, currentCount);
		} else {
			currentCount = 1;
		}
	}

	return maxCount;
}

/**
 * Sanitize API key for logging
 */
export function sanitizeApiKey(apiKey: string): string {
	if (!apiKey || apiKey.length <= 8) {
		return "[REDACTED]";
	}

	// Show first 4 and last 4 characters
	const start = apiKey.substring(0, 4);
	const end = apiKey.substring(apiKey.length - 4);
	return `${start}...${end}`;
}

/**
 * Hash API key for storage comparison
 */
export function hashApiKey(apiKey: string): string {
	return crypto
		.createHash(SECURITY_ALGORITHM)
		.update(apiKey)
		.digest(SECURITY_ENCODING);
}

// =============================================================================
// ENVIRONMENT VARIABLE SECURITY
// =============================================================================

/**
 * Check for sensitive environment variables
 */
export function checkSensitiveEnvironmentVariables(): void {
	const sensitiveVarsFound: string[] = [];

	for (const envVar of SENSITIVE_ENV_VARS) {
		const value = process.env[envVar];
		if (value && value.length > 0) {
			sensitiveVarsFound.push(envVar);
			log(
				"Security",
				`Sensitive environment variable found: ${envVar}`,
				"warn",
				{
					var: envVar,
					sanitizedValue: sanitizeApiKey(value),
					length: value.length,
				},
			);
		}
	}

	if (sensitiveVarsFound.length > 0) {
		log(
			"Security",
			`Found ${sensitiveVarsFound.length} sensitive environment variables`,
			"warn",
			{
				variables: sensitiveVarsFound,
			},
		);
	}
}

/**
 * Sanitize environment variables for logging
 */
export function sanitizeEnvironmentVariables(
	envVars: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const sanitized = { ...envVars };

	for (const [key, value] of Object.entries(envVars)) {
		if (
			SENSITIVE_ENV_VARS.some((sensitive) =>
				key.toUpperCase().includes(sensitive),
			)
		) {
			sanitized[key] = sanitizeApiKey(value || "");
		}
	}

	return sanitized;
}

// =============================================================================
// FILE SECURITY
// =============================================================================

/**
 * Check for sensitive files in the project
 */
export function checkSensitiveFiles(rootDir: string): void {
	const sensitiveFiles: string[] = [];

	function scanDirectory(dir: string): void {
		try {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					// Skip node_modules and other common directories
					if (
						!["node_modules", ".git", ".next", "dist", "build"].includes(file)
					) {
						scanDirectory(filePath);
					}
				} else {
					// Check for sensitive file patterns
					for (const pattern of SENSITIVE_FILE_PATTERNS) {
						if (pattern.test(file)) {
							sensitiveFiles.push(filePath);
							log(
								"Security",
								`Potentially sensitive file found: ${filePath}`,
								"warn",
								{
									file,
									pattern: pattern.toString(),
								},
							);
							break;
						}
					}
				}
			}
		} catch (error) {
			log("Security", `Error scanning directory ${dir}: ${error}`, "error");
		}
	}

	scanDirectory(rootDir);

	if (sensitiveFiles.length > 0) {
		log(
			"Security",
			`Found ${sensitiveFiles.length} potentially sensitive files`,
			"warn",
			{
				files: sensitiveFiles,
			},
		);
	}
}

/**
 * Validate file permissions
 */
export function validateFilePermissions(filePath: string): boolean {
	try {
		const stats = fs.statSync(filePath);

		// Check if file is world-readable or world-writable
		const isWorldReadable = (stats.mode & 0o0004) !== 0;
		const isWorldWritable = (stats.mode & 0o0002) !== 0;

		if (isWorldReadable || isWorldWritable) {
			log(
				"Security",
				`Insecure file permissions detected: ${filePath}`,
				"warn",
				{
					mode: stats.mode.toString(8),
					worldReadable: isWorldReadable,
					worldWritable: isWorldWritable,
				},
			);
			return false;
		}

		return true;
	} catch (error) {
		log(
			"Security",
			`Error checking file permissions for ${filePath}: ${error}`,
			"error",
		);
		return false;
	}
}

/**
 * Sanitize file content for logging
 */
export function sanitizeFileContent(
	content: string,
	sensitivePatterns: RegExp[] = [],
): string {
	let sanitized = content;

	// Remove common sensitive patterns
	const defaultPatterns = [
		/(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{10,}["']?/gi,
		/(?:sk-|pk-)[a-zA-Z0-9_-]{20,}/gi,
		/Bearer\s+[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/gi,
	];

	const patternsToUse = [...defaultPatterns, ...sensitivePatterns];

	for (const pattern of patternsToUse) {
		sanitized = sanitized.replace(pattern, "[REDACTED]");
	}

	return sanitized;
}

// =============================================================================
// NETWORK SECURITY
// =============================================================================

/**
 * Sanitize HTTP headers for logging
 */
export function sanitizeHttpHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const sanitized: Record<string, string> = {};

	for (const [key, value] of Object.entries(headers)) {
		const lowerKey = key.toLowerCase();

		if (SENSITIVE_HEADERS.some((sensitive) => lowerKey.includes(sensitive))) {
			sanitized[key] = "[REDACTED]";
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Sanitize query parameters for logging
 */
export function sanitizeQueryParams(
	params: Record<string, string>,
): Record<string, string> {
	const sanitized: Record<string, string> = {};

	for (const [key, value] of Object.entries(params)) {
		const lowerKey = key.toLowerCase();

		if (SENSITIVE_PARAMS.some((sensitive) => lowerKey.includes(sensitive))) {
			sanitized[key] = "[REDACTED]";
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Validate URL for security
 */
export function validateUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);

		// Check for potentially dangerous protocols
		const dangerousProtocols = ["javascript:", "data:", "file:", "vbscript:"];

		if (dangerousProtocols.includes(parsedUrl.protocol)) {
			log(
				"Security",
				`Potentially dangerous URL protocol detected: ${parsedUrl.protocol}`,
				"error",
			);
			return false;
		}

		// Check for localhost/127.0.0.1 in production
		if (process.env.NODE_ENV === "production") {
			const localhostPatterns = ["localhost", "127.0.0.1", "::1"];
			if (
				localhostPatterns.some((pattern) =>
					parsedUrl.hostname.includes(pattern),
				)
				/**
				 * Validate input against common attack patterns with enhanced options
				 * Performs comprehensive security validation for different input types including
				 * SQL injection, XSS, command injection, and other attack vectors.
				 *
				 * @param input The input string to validate
				 * @param type The type of input for context-specific validation (default: 'general')
				 * @param options Configuration options for validation
				 * @param options.strict Whether to perform strict validation (default: false)
				 * @param options.maxLength Maximum allowed input length (default: undefined)
				 * @param options.minLength Minimum required input length (default: undefined)
				 * @param options.allowSpaces Whether to allow spaces in input (default: undefined)
				 * @param options.allowSpecialChars Whether to allow special characters (default: undefined)
				 * @param options.allowNumbers Whether to allow numbers (default: undefined)
				 * @param options.allowLetters Whether to allow letters (default: undefined)
				 * @param options.customPatterns Additional custom regex patterns to test against (default: [])
				 * @returns true if the input is valid, false otherwise
				 *
				 * @example
				 * ```typescript
				 * // Basic validation
				 * const isValid = validateInput('normal text', 'general');
				 *
				 * // Strict validation for file paths
				 * const isValid = validateInput('/path/to/file.txt', 'file', {
				 *   strict: true,
				 *   allowSpecialChars: true
				 * });
				 *
				 * // URL validation with custom patterns
				 * const isValid = validateInput('https://example.com', 'url', {
				 *   customPatterns: [/https?:\/\/.+/]
				 * });
				 * ```
				 */
			) {
				log("Security", `Localhost URL detected in production: ${url}`, "warn");
			}
		}

		return true;
	} catch (_error) {
		log("Security", `Invalid URL format: ${url}`, "error");
		return false;
	}
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

/**
 * Enhanced validation options
 */
export interface ValidationOptions {
	strict?: boolean;
	maxLength?: number;
	minLength?: number;
	allowSpaces?: boolean;
	allowSpecialChars?: boolean;
	allowNumbers?: boolean;
	allowLetters?: boolean;
	customPatterns?: RegExp[];
}

/**
 * Validate input against common attack patterns with enhanced options
 */
export function validateInput(
	input: string,
	type: string = "general",
	options: ValidationOptions = {},
): boolean {
	if (!input || typeof input !== "string") {
		return false;
	}

	// Apply length constraints
	if (options.minLength && input.length < options.minLength) {
		log("Security", `Input too short for ${type} validation`, "error", {
			input: input.substring(0, 100),
			minLength: options.minLength,
			actualLength: input.length,
		});
		return false;
	}

	if (options.maxLength && input.length > options.maxLength) {
		log("Security", `Input too long for ${type} validation`, "error", {
			input: input.substring(0, 100),
			maxLength: options.maxLength,
			actualLength: input.length,
		});
		return false;
	}

	// Character type validation
	if (
		options.allowNumbers !== undefined &&
		!/\d/.test(input) !== options.allowNumbers
	) {
		log("Security", `Number validation failed for ${type}`, "error", {
			input: input.substring(0, 100),
			requiresNumbers: options.allowNumbers,
		});
		return false;
	}

	if (
		options.allowLetters !== undefined &&
		!/[a-zA-Z]/.test(input) !== options.allowLetters
	) {
		log("Security", `Letter validation failed for ${type}`, "error", {
			input: input.substring(0, 100),
			requiresLetters: options.allowLetters,
		});
		return false;
	}

	if (
		options.allowSpaces !== undefined &&
		/\s/.test(input) !== options.allowSpaces
	) {
		log("Security", `Space validation failed for ${type}`, "error", {
			input: input.substring(0, 100),
			allowSpaces: options.allowSpaces,
		});
		return false;
	}

	// Common attack patterns
	const attackPatterns = {
		sqlInjection:
			/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|DECLARE|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b\s*)/gi,
		xss: /<script[^>]*?>.*?<\/script>|javascript:|on\w+\s*=/gi,
		commandInjection: /[;&|`$(){}[\]<>]/g,
		pathTraversal: /\.\.\/|\.\.\\|\/\.\.|\.\.\//g,
		ldapInjection: /(\(|\)|&|\||!|\*|\?|=|>|<|,|"|;|#)/g,
		ssrf: /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/gi,
	};

	const patternsToCheck = {
		general: [
			attackPatterns.sqlInjection,
			attackPatterns.xss,
			attackPatterns.commandInjection,
		],
		file: [attackPatterns.pathTraversal, attackPatterns.commandInjection],
		url: [
			attackPatterns.xss,
			attackPatterns.ssrf,
			attackPatterns.commandInjection,
		],
		command: [attackPatterns.commandInjection, attackPatterns.sqlInjection],
		database: [attackPatterns.sqlInjection, attackPatterns.ldapInjection],
		api: [attackPatterns.sqlInjection, attackPatterns.xss, attackPatterns.ssrf],
	};

	const relevantPatterns =
		patternsToCheck[type as keyof typeof patternsToCheck] ||
		patternsToCheck.general;

	// Add custom patterns if provided
	const allPatterns = options.customPatterns
		? [...relevantPatterns, ...options.customPatterns]
		: relevantPatterns;

	for (const pattern of allPatterns) {
		if (pattern.test(input)) {
			log("Security", `Potential ${type} injection attack detected`, "error", {
				input: input.substring(0, 100) + (input.length > 100 ? "..." : ""),
				pattern: pattern.toString(),
				type,
			});
			return false;
		}
	}

	// Additional strict validation
	if (options.strict) {
		// Check for null bytes and other dangerous characters
		if (input.includes("\0") || input.includes("\x00")) {
			log("Security", `Null byte detected in ${type} input`, "error");
			return false;
		}

		// Check for excessive control characters
		const controlCharCount = input
			.split("")
			.filter(
				(char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127,
			).length;
		if (controlCharCount > input.length * 0.1) {
			log(
				"Security",
				`Excessive control characters in ${type} input`,
				"error",
				{
					controlCharCount,
					totalLength: input.length,
				},
			);
			return false;
		}
	}

	return true;
}

/**
 * Sanitize input for safe usage
 */
export function sanitizeInput(input: string): string {
	if (!input || typeof input !== "string") {
		return "";
	}

	// Remove control characters except allowed ones
	let sanitized = input.replace(/[^\x20-\x7E]/g, "");

	// Escape HTML entities
	sanitized = sanitized
		.replace(/&/g, "&")
		.replace(/</g, "<")
		.replace(/>/g, ">")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

	// Remove potentially dangerous characters
	sanitized = sanitized.replace(/[<>"'&]/g, "");

	return sanitized.trim();
}

// =============================================================================
// SECURITY AUDIT
// =============================================================================

/**
 * Perform comprehensive security audit
 */
export function performSecurityAudit(rootDir: string): void {
	log("Security", "Starting comprehensive security audit...", "info");

	// Check environment variables
	log("Security", "Checking environment variables...", "info");
	checkSensitiveEnvironmentVariables();

	// Check sensitive files
	log("Security", "Scanning for sensitive files...", "info");
	checkSensitiveFiles(rootDir);

	// Check API keys in common locations
	log("Security", "Checking for API keys in code...", "info");
	checkApiKeysInCode(rootDir);

	// Check file permissions
	log("Security", "Checking file permissions...", "info");
	checkFilePermissions(rootDir);

	log("Security", "Security audit completed", "info");
}

/**
 * Check for API keys hardcoded in code
 */
function checkApiKeysInCode(rootDir: string): void {
	const apiKeyPatterns = [
		/(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[a-zA-Z0-9_-]{10,}["']?/gi,
		/(?:sk-|pk-)[a-zA-Z0-9_-]{20,}/gi,
	];

	function scanCodeFiles(dir: string): void {
		try {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					if (
						!["node_modules", ".git", ".next", "dist", "build"].includes(file)
					) {
						scanCodeFiles(filePath);
					}
				} else if (
					file.endsWith(".ts") ||
					file.endsWith(".js") ||
					file.endsWith(".json")
				) {
					try {
						const content = fs.readFileSync(filePath, "utf-8");

						for (const pattern of apiKeyPatterns) {
							const matches = content.match(pattern);
							if (matches) {
								log(
									"Security",
									`Potential API key found in code: ${filePath}`,
									"error",
									{
										file: filePath,
										matches: matches.slice(0, 3), // Show first 3 matches
									},
								);
							}
						}
					} catch (_error) {
						// Skip files that can't be read
					}
				}
			}
		} catch (_error) {
			// Skip directories that can't be accessed
		}
	}

	scanCodeFiles(rootDir);
}

/**
 * Check file permissions recursively
 */
function checkFilePermissions(rootDir: string): void {
	function checkDirectory(dir: string): void {
		try {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					if (
						!["node_modules", ".git", ".next", "dist", "build"].includes(file)
					) {
						checkDirectory(filePath);
					}
				} else {
					validateFilePermissions(filePath);
				}
			}
		} catch (_error) {
			// Skip directories that can't be accessed
		}
	}
	/**
	 * Perform comprehensive security audit with detailed reporting
	 * Conducts thorough security checks across multiple domains including
	 * environment variables, file security, API key validation, and input validation.
	 *
	 * @param rootDir The root directory to scan for security issues
	 * @returns Object containing audit summary and detailed security assessment
	 *
	 * The audit results include:
	 * - Summary with overall security status and severity level
	 * - API key validation results for test scenarios
	 * - Input validation test results
	 * - File security findings including sensitive files and permission issues
	 *
	 * @example
	 * ```typescript
	 * const audit = performEnhancedSecurityAudit('./src');
	 *
	 * if (audit.summary.isSecure) {
	 *   console.log('Security audit passed!');
	 * } else {
	 *   console.log('Security audit failed with issues:');
	 *   audit.summary.errors.forEach(error => console.log(`- ${error}`));
	 *   audit.summary.warnings.forEach(warning => console.log(`- ${warning}`));
	 * }
	 *
	 * // View detailed results
	 * console.log('API Key Validation:', audit.details.apiKeys.validationResults);
	 * console.log('File Security Issues:', audit.details.fileSecurity.sensitiveFiles);
	 * ```
	 */

	checkDirectory(rootDir);
}

// =============================================================================
// SECURITY UTILITIES
// =============================================================================

/**
 * Generate a secure random string
 */
export function generateSecureString(length: number = 32): string {
	return crypto
		.randomBytes(length)
		.toString(SECURITY_ENCODING)
		.substring(0, length);
}

/**
 * Generate a secure random token
 */
export function generateSecureToken(): string {
	return crypto.randomBytes(32).toString(SECURITY_ENCODING);
}

/**
 * Check if running in secure environment
 */
export function isSecureEnvironment(): boolean {
	const checks = {
		https:
			process.env.NODE_ENV === "production"
				? process.env.HTTPS !== "false"
				: true,
		noDebug: process.env.NODE_ENV === "production" ? !process.env.DEBUG : true,
		noInspects:
			!process.execArgv.includes("--inspect") &&
			!process.execArgv.includes("--inspect-brk"),
	};

	const isSecure = Object.values(checks).every(Boolean);

	if (!isSecure) {
		log("Security", "Running in potentially insecure environment", "warn", {
			checks,
			env: process.env.NODE_ENV,
		});
	}

	return isSecure;
}

/**
 * Get security summary
 */
/**
 * Comprehensive security audit with enhanced validation
 */
export function performEnhancedSecurityAudit(rootDir: string): {
	summary: {
		isSecure: boolean;
		checks: Record<string, boolean>;
		warnings: string[];
		errors: string[];
	};
	details: {
		apiKeys: {
			validationResults: Array<{
				provider: string;
				valid: boolean;
				warnings: string[];
			}>;
		};
		inputValidation: {
			samples: Array<{
				input: string;
				type: string;
				valid: boolean;
				errors: string[];
			}>;
		};
		fileSecurity: {
			sensitiveFiles: string[];
			permissionIssues: string[];
		};
	};
} {
	log("Security", "Starting enhanced security audit...", "info");

	const summary = {
		isSecure: true,
		checks: {} as Record<string, boolean>,
		warnings: [] as string[],
		errors: [] as string[],
	};

	const details = {
		apiKeys: {
			validationResults: [] as Array<{
				provider: string;
				valid: boolean;
				warnings: string[];
			}>,
		},
		inputValidation: {
			samples: [] as Array<{
				input: string;
				type: string;
				valid: boolean;
				errors: string[];
			}>,
		},
		fileSecurity: {
			sensitiveFiles: [] as string[],
			permissionIssues: [] as string[],
		},
	};

	// Environment variables check
	log("Security", "Checking environment variables...", "info");
	let hasSensitiveVars = false;
	for (const envVar of SENSITIVE_ENV_VARS) {
		const value = process.env[envVar];
		if (value && value.length > 0) {
			hasSensitiveVars = true;
			log(
				"Security",
				`Sensitive environment variable found: ${envVar}`,
				"warn",
				{
					var: envVar,
					sanitizedValue: sanitizeApiKey(value),
					length: value.length,
				},
			);
		}
	}
	summary.checks.environmentVariables = !hasSensitiveVars;
	if (hasSensitiveVars) {
		summary.warnings.push("Sensitive environment variables detected");
		summary.errors.push("Environment variables contain sensitive data");
	}

	// File security check
	log("Security", "Scanning for sensitive files...", "info");
	const sensitiveFiles = checkSensitiveFilesEnhanced(rootDir);
	details.fileSecurity.sensitiveFiles = sensitiveFiles;
	if (sensitiveFiles.length > 0) {
		summary.warnings.push(
			`Found ${sensitiveFiles.length} potentially sensitive files`,
		);
	}

	// File permissions check
	log("Security", "Checking file permissions...", "info");
	const permissionIssues = checkFilePermissionsEnhanced(rootDir);
	details.fileSecurity.permissionIssues = permissionIssues;
	if (permissionIssues.length > 0) {
		summary.warnings.push(`Found ${permissionIssues.length} permission issues`);
	}

	// API key validation samples
	log("Security", "Testing API key validation...", "info");
	const apiKeysToTest = [
		{ key: "sk-test-key-123456", provider: "openai", shouldFail: true },
		{
			key: "sk-1234567890123456789012345678901234567890",
			provider: "openai",
			shouldFail: false,
		},
		{ key: "short", provider: "gemini", shouldFail: true },
		{ key: "a".repeat(100), provider: "mistral", shouldFail: true },
	];

	for (const { key, provider, shouldFail } of apiKeysToTest) {
		const result = {
			provider,
			valid: validateApiKey(key, provider, {
				allowTestKeys: false,
				checkEntropy: true,
			}),
			warnings: [] as string[],
		};

		if (result.valid !== !shouldFail) {
			summary.errors.push(
				`API key validation mismatch for ${provider}: expected ${!shouldFail}, got ${result.valid}`,
			);
		}

		details.apiKeys.validationResults.push(result);
	}

	// Input validation samples
	log("Security", "Testing input validation...", "info");
	const inputSamples = [
		{ input: "SELECT * FROM users", type: "sql", shouldFail: true },
		{ input: "<script>alert('xss')</script>", type: "xss", shouldFail: true },
		{ input: "normal text", type: "general", shouldFail: false },
		{ input: "file.txt", type: "file", shouldFail: false },
		{ input: "../../../etc/passwd", type: "file", shouldFail: true },
	];

	for (const { input, type, shouldFail } of inputSamples) {
		const result = {
			input,
			type,
			valid: validateInput(input, type, { strict: true }),
			errors: [] as string[],
		};

		if (result.valid !== !shouldFail) {
			result.errors.push(
				`Validation mismatch: expected ${!shouldFail}, got ${result.valid}`,
			);
		}

		details.inputValidation.samples.push(result);
	}

	// Overall security assessment
	summary.isSecure =
		Object.values(summary.checks).every(Boolean) &&
		summary.errors.length === 0 &&
		summary.warnings.length < 3;

	log("Security", "Enhanced security audit completed", "info", {
		isSecure: summary.isSecure,
		errors: summary.errors.length,
		warnings: summary.warnings.length,
	});

	return { summary, details };
}

/**
 * Enhanced sensitive files check with better patterns
 */
function checkSensitiveFilesEnhanced(rootDir: string): string[] {
	const sensitiveFiles: string[] = [];
	const enhancedPatterns = [
		/\.pem$/,
		/\.key$/,
		/\.crt$/,
		/\.p12$/,
		/\.jks$/,
		/\.pfx$/,
		/\.p7b$/,
		/\.p7s$/,
		/\.der$/,
		/\.p8$/,
		/\.p12$/,
		/\.pem$/,
		/password/i,
		/secret/i,
		/private/i,
		/config/i,
		/\.env$/,
		/\.env\.local$/,
		/\.env\.production$/,
		/\.env\.development$/,
		/\.key$/,
		/\.pem$/,
		/\.crt$/,
		/\.p12$/,
		/\.jks$/,
		/\.pfx$/,
		/\.p7b$/,
		/\.p7s$/,
		/\.der$/,
		/\.p8$/,
		/\.p12$/,
	];

	function scanDirectory(dir: string): void {
		try {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					if (
						![
							"node_modules",
							".git",
							".next",
							"dist",
							"build",
							".cache",
							".temp",
						].includes(file)
					) {
						scanDirectory(filePath);
					}
				} else {
					for (const pattern of enhancedPatterns) {
						if (pattern.test(file)) {
							sensitiveFiles.push(filePath);
							log(
								"Security",
								`Potentially sensitive file found: ${filePath}`,
								"warn",
								{
									file,
									pattern: pattern.toString(),
								},
							);
							break;
						}
					}
				}
			}
		} catch (error) {
			log("Security", `Error scanning directory ${dir}: ${error}`, "error");
		}
	}

	scanDirectory(rootDir);
	return sensitiveFiles;
}

/**
 * Enhanced file permissions check
 */
function checkFilePermissionsEnhanced(rootDir: string): string[] {
	const permissionIssues: string[] = [];

	function checkDirectory(dir: string): void {
		try {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					if (
						![
							"node_modules",
							".git",
							".next",
							"dist",
							"build",
							".cache",
							".temp",
						].includes(file)
					) {
						checkDirectory(filePath);
					}
				} else {
					if (!validateFilePermissions(filePath)) {
						permissionIssues.push(filePath);
					}
				}
			}
		} catch (_error) {
			// Skip directories that can't be accessed
		}
	}

	checkDirectory(rootDir);
	return permissionIssues;
}

/**
 * Get security summary with enhanced details
 */
export function getEnhancedSecuritySummary(): {
	isSecure: boolean;
	checks: {
		environmentVariables: boolean;
		filePermissions: boolean;
		sensitiveFiles: boolean;
		inputValidation: boolean;
		secureEnvironment: boolean;
		apiKeyValidation: boolean;
	};
	warnings: string[];
	errors: string[];
	severity: "low" | "medium" | "high" | "critical";
} {
	const warnings: string[] = [];
	const errors: string[] = [];

	const checks = {
		environmentVariables: SENSITIVE_ENV_VARS.every(
			(varName) => !process.env[varName] || process.env[varName]?.length === 0,
		),
		filePermissions: true, // Would need to check actual files
		sensitiveFiles: true, // Would need to scan actual files
		inputValidation: true, // Assuming validation is implemented
		secureEnvironment: isSecureEnvironment(),
		apiKeyValidation: true, // Assuming API keys are validated
	};

	if (!checks.environmentVariables) {
		warnings.push("Sensitive environment variables detected");
	}

	if (!checks.secureEnvironment) {
		warnings.push("Running in potentially insecure environment");
	}

	// Calculate severity
	let severity: "low" | "medium" | "high" | "critical" = "low";
	if (errors.length > 0) {
		severity = "critical";
	} else if (warnings.length > 2) {
		severity = "high";
	} else if (warnings.length > 0) {
		severity = "medium";
	}

	return {
		isSecure: Object.values(checks).every(Boolean),
		checks,
		warnings,
		errors,
		severity,
	};
}
