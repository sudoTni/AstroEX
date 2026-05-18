/**
 * Enhanced Security Utilities
 *
 * Provides comprehensive security validation and sanitization functions
 * to protect against common web vulnerabilities.
 *
 * Features:
 * - Input validation and sanitization
 * - XSS protection
 * - SQL injection prevention
 * - File path security
 * - API key validation
 * - Network security utilities
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

/**
 * Security validation patterns
 */
const SECURITY_PATTERNS = {
	// XSS attack patterns
	XSS: [
		/<script[^>]*?>.*?<\/script>/gi,
		/javascript:/gi,
		/on\w+\s*=/gi,
		/<iframe[^>]*>/gi,
		/<object[^>]*>/gi,
		/<embed[^>]*>/gi,
		/<form[^>]*>/gi,
		/<input[^>]*>/gi,
		/<link[^>]*rel\s*=\s*['"]?['"]?\s*stylesheet[^>]*>/gi,
		/<style[^>]*>.*?<\/style>/gi,
		/expression\s*\(/gi,
		/javascript\s*:/gi,
		/vbscript\s*:/gi,
		/data\s*:\s*text\/html/i,
		/<meta\s+http-equiv\s*=\s*['"]?refresh['"]?[^>]*>/gi,
	],

	// SQL injection patterns
	SQL_INJECTION: [
		/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|DECLARE|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b\s*)/gi,
		/(''|''-|';|--|\/\*|\*\/|@@|xp_|sp_|exec\s*\()/gi,
		/(\b(OR|AND)\s+\w+\s*=\s*['"]?\w+['"]?)/gi,
		/(\b(UNION\s+ALL\s+SELECT|UNION\s+SELECT)\b)/gi,
		/(\b(WAITFOR\s+DELAY|SLEEP)\s*\(\s*['"]\d+['"]\s*\))/gi,
	],

	// Command injection patterns
	COMMAND_INJECTION: [
		/[;&|`$(){}[\]<>]/g,
		/(\b(exec|system|shell|cmd|bash)\b\s*\()/gi,
		/(\b(rm|del|deltree|rmdir)\b\s+-?r?f?\s*['"]?\w+['"]?)/gi,
		/(\b(cd|pwd|ls|dir)\b\s+-?\w*)/gi,
	],

	// Path traversal patterns
	PATH_TRAVERSAL: [/\.\.\/\.\.\//g, /\.\.\\/g, /\/\.\.\//g, /\\.\.\\/g],

	// Email validation pattern
	EMAIL: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,

	// URL validation pattern
	URL: /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/,

	// API key validation pattern (16-128 characters, alphanumeric + some special chars)
	API_KEY: /^[a-zA-Z0-9\-_]{16,128}$/,

	// File path validation pattern
	FILE_PATH: /^[a-zA-Z0-9_\-./\\]+$/,
} as const;

/**
 * Validate input against security patterns
 * @param input Input string to validate
 * @param type Type of validation to perform
 * @returns boolean True if input is valid
 */
export function validateInput(
	input: string,
	type:
		| "general"
		| "xss"
		| "sql"
		| "command"
		| "path"
		| "email"
		| "url"
		| "apiKey" = "general",
): boolean {
	if (!input || typeof input !== "string") {
		return false;
	}

	switch (type) {
		case "xss":
			return !SECURITY_PATTERNS.XSS.some((pattern) => pattern.test(input));

		case "sql":
			return !SECURITY_PATTERNS.SQL_INJECTION.some((pattern) =>
				pattern.test(input),
			);

		case "command":
			return !SECURITY_PATTERNS.COMMAND_INJECTION.some((pattern) =>
				pattern.test(input),
			);

		case "path":
			return (
				!SECURITY_PATTERNS.PATH_TRAVERSAL.some((pattern) =>
					pattern.test(input),
				) && SECURITY_PATTERNS.FILE_PATH.test(input)
			);

		case "email":
			return SECURITY_PATTERNS.EMAIL.test(input);

		case "url":
			return SECURITY_PATTERNS.URL.test(input);

		case "apiKey":
			return SECURITY_PATTERNS.API_KEY.test(input);
		default:
			return (
				!SECURITY_PATTERNS.XSS.some((pattern) => pattern.test(input)) &&
				!SECURITY_PATTERNS.SQL_INJECTION.some((pattern) =>
					pattern.test(input),
				) &&
				!SECURITY_PATTERNS.COMMAND_INJECTION.some((pattern) =>
					pattern.test(input),
				)
			);
	}
}

/**
 * Sanitize input to remove potential security threats
 * @param input Input string to sanitize
 * @param options Sanitization options
 * @returns Sanitized string
 */
export function sanitizeInput(
	input: string,
	options: {
		removeHtml?: boolean;
		encodeHtml?: boolean;
		stripTags?: boolean;
		maxLength?: number;
	} = {},
): string {
	if (!input || typeof input !== "string") {
		return "";
	}

	let sanitized = input;

	// Remove HTML tags if requested
	if (options.stripTags) {
		sanitized = sanitized.replace(/<[^>]*>/g, "");
	}

	// Encode HTML entities if requested
	if (options.encodeHtml) {
		sanitized = sanitized
			.replace(/&/g, "&")
			.replace(/</g, "<")
			.replace(/>/g, ">")
			.replace(/"/g, '"')
			.replace(/'/g, "&#x27;");
	}

	// Remove XSS patterns
	SECURITY_PATTERNS.XSS.forEach((pattern) => {
		sanitized = sanitized.replace(pattern, "");
	});

	// Remove SQL injection patterns
	SECURITY_PATTERNS.SQL_INJECTION.forEach((pattern) => {
		sanitized = sanitized.replace(pattern, "");
	});

	// Remove command injection patterns
	SECURITY_PATTERNS.COMMAND_INJECTION.forEach((pattern) => {
		sanitized = sanitized.replace(pattern, "");
	});

	// Remove path traversal patterns
	SECURITY_PATTERNS.PATH_TRAVERSAL.forEach((pattern) => {
		sanitized = sanitized.replace(pattern, "");
	});

	// Trim whitespace
	sanitized = sanitized.trim();

	// Limit length if specified
	if (options.maxLength && sanitized.length > options.maxLength) {
		sanitized = sanitized.substring(0, options.maxLength);
	}

	return sanitized;
}

/**
 * Validate file path for security with enhanced protections
 * @param filePath File path to validate
 * @param allowedExtensions Array of allowed file extensions
 * @param allowedBasePaths Array of allowed base paths
 * @returns string | null Returns sanitized path if valid, null if invalid
 */
export function validateFilePath(
	filePath: string,
	allowedExtensions: string[] = [],
	allowedBasePaths: string[] = [],
): string | null {
	if (!filePath || typeof filePath !== "string") {
		return null;
	}

	// Normalize path separators
	const normalizedPath = filePath.replace(/\\/g, "/");

	// Check for path traversal attempts (enhanced)
	const dangerousPatterns = [
		/\.\.\//g, // Unix parent directory
		/\.\.\\/g, // Windows parent directory
		/\\.\./g, // Alternative Windows parent directory
		/\/\.\.\//g, // Absolute Unix parent directory
		/\\.\.\\/g, // Absolute Windows parent directory
		/~(?:\/|$)/g, // Home directory references
		/^\//g, // Absolute paths
		/^\//g, // Root paths
		/\$\{.*\}/g, // Environment variable expansion
		/%.*%/g, // Windows environment variables
		/\.\.(?:\/|\\|$)/g, // Any parent directory pattern
	];

	if (dangerousPatterns.some((pattern) => pattern.test(normalizedPath))) {
		return null;
	}

	// Check for null bytes and other dangerous characters
	if (normalizedPath.includes("\0") || normalizedPath.includes("..")) {
		return null;
	}

	// Check allowed base paths if specified
	if (allowedBasePaths.length > 0) {
		const isAllowed = allowedBasePaths.some((basePath) =>
			normalizedPath.startsWith(basePath),
		);
		if (!isAllowed) {
			return null;
		}
	}

	// Check file extension if specified
	if (allowedExtensions.length > 0) {
		const extension = normalizedPath.split(".").pop()?.toLowerCase();
		if (!extension || !allowedExtensions.includes(extension)) {
			return null;
		}
	}

	// Additional validation for file names
	const fileName = normalizedPath.split("/").pop() || "";
	if (fileName.length === 0 || fileName.length > 255) {
		return null;
	}

	// Check for reserved Windows filenames
	const reservedNames = [
		"CON",
		"PRN",
		"AUX",
		"NUL",
		"COM1",
		"COM2",
		"COM3",
		"COM4",
		"COM5",
		"COM6",
		"COM7",
		"COM8",
		"LPT1",
		"LPT2",
		"LPT3",
		"LPT4",
		"LPT5",
		"LPT6",
		"LPT7",
		"LPT8",
	];
	if (reservedNames.includes(fileName.toUpperCase())) {
		return null;
	}

	// Check for dangerous file extensions
	const dangerousExtensions = [
		".exe",
		".bat",
		".cmd",
		".com",
		".pif",
		".scr",
		".vbs",
		".js",
		".jar",
	];
	const fileExtension = fileName.toLowerCase();
	if (dangerousExtensions.some((ext) => fileExtension.endsWith(ext))) {
		return null;
	}

	return normalizedPath;
}

/**
 * Validate API key format and security
 * @param apiKey API key to validate
 * @returns boolean True if API key is valid
 */
export function validateApiKey(apiKey: string): boolean {
	if (!apiKey || typeof apiKey !== "string") {
		return false;
	}

	// Check basic format
	if (!SECURITY_PATTERNS.API_KEY.test(apiKey)) {
		return false;
	}

	// Check for common test patterns
	const testPatterns = [
		/test/i,
		/demo/i,
		/sample/i,
		/example/i,
		/mock/i,
		/fake/i,
	];

	if (testPatterns.some((pattern) => pattern.test(apiKey))) {
		return false;
	}

	return true;
}

/**
 * Sanitize API key for logging purposes
 * @param apiKey API key to sanitize
 * @returns Sanitized API key
 */
export function sanitizeApiKey(apiKey: string): string {
	if (!apiKey || typeof apiKey !== "string") {
		return "";
	}

	if (apiKey.length <= 8) {
		return "*".repeat(apiKey.length);
	}

	return `${apiKey.substring(0, 4)}${"*".repeat(apiKey.length - 8)}${apiKey.substring(apiKey.length - 4)}`;
}

/**
 * Validate URL for security
 * @param url URL to validate
 * @returns boolean True if URL is secure
 */
export function validateUrl(url: string): boolean {
	if (!url || typeof url !== "string") {
		return false;
	}

	// Check basic URL format
	if (!SECURITY_PATTERNS.URL.test(url)) {
		return false;
	}

	try {
		const urlObj = new URL(url);

		// Check for dangerous protocols
		const dangerousProtocols = ["javascript:", "data:", "vbscript:", "file:"];
		if (dangerousProtocols.some((protocol) => urlObj.protocol === protocol)) {
			return false;
		}

		// Check for suspicious query parameters
		const suspiciousParams = ["<script", "javascript:", "vbscript:"];
		for (const [key, value] of urlObj.searchParams) {
			if (
				suspiciousParams.some(
					(param) =>
						key.toLowerCase().includes(param) ||
						value?.toLowerCase().includes(param),
				)
			) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Sanitize URL for logging purposes
 * @param url URL to sanitize
 * @returns Sanitized URL
 */
export function sanitizeUrl(url: string): string {
	if (!url || typeof url !== "string") {
		return "";
	}

	try {
		const urlObj = new URL(url);

		// Remove sensitive query parameters
		const sensitiveParams = ["api_key", "token", "secret", "password", "auth"];
		for (const param of sensitiveParams) {
			urlObj.searchParams.delete(param);
		}

		// Sanitize query parameter values
		for (const [key, _value] of urlObj.searchParams) {
			if (sensitiveParams.includes(key.toLowerCase())) {
				urlObj.searchParams.set(key, "***");
			}
		}

		return urlObj.toString();
	} catch {
		return url;
	}
}

/**
 * Check if a file contains potentially sensitive information
 * @param filePath Path to the file
 * @param content File content
 * @returns boolean True if file contains sensitive information
 */
export function containsSensitiveInformation(
	_filePath: string,
	content: string,
): boolean {
	if (!content) {
		return false;
	}

	const sensitivePatterns = [
		/password\s*[:=]\s*['"]?\w+['"]?/gi,
		/api[_-]?key\s*[:=]\s*['"]?\w+['"]?/gi,
		/secret\s*[:=]\s*['"]?\w+['"]?/gi,
		/token\s*[:=]\s*['"]?\w+['"]?/gi,
		/private[_-]?key\s*[:=]\s*['"]?\w+['"]?/gi,
		/certificate\s*[:=]\s*['"]?\w+['"]?/gi,
		/ssh[_-]?key\s*[:=]\s*['"]?\w+['"]?/gi,
	];

	return sensitivePatterns.some((pattern) => pattern.test(content));
}

/**
 * Rate limiting utility
 */
export class RateLimiter {
	private requests: Map<string, number[]> = new Map();
	private readonly maxRequests: number;
	private readonly timeWindow: number; // in milliseconds

	constructor(maxRequests: number = 100, timeWindow: number = 60000) {
		this.maxRequests = maxRequests;
		this.timeWindow = timeWindow;
	}

	/**
	 * Check if a request is allowed
	 * @param identifier Unique identifier for the rate limit (e.g., IP, user ID)
	 * @returns boolean True if request is allowed
	 */
	isAllowed(identifier: string): boolean {
		const now = Date.now();
		const userRequests = this.requests.get(identifier) || [];

		// Remove old requests outside the time window
		const recentRequests = userRequests.filter(
			(timestamp) => now - timestamp < this.timeWindow,
		);

		// Check if limit exceeded
		if (recentRequests.length >= this.maxRequests) {
			return false;
		}

		// Add current request
		recentRequests.push(now);
		this.requests.set(identifier, recentRequests);

		return true;
	}

	/**
	 * Get remaining requests for an identifier
	 * @param identifier Unique identifier
	 * @returns Number of remaining requests
	 */
	getRemainingRequests(identifier: string): number {
		const now = Date.now();
		const userRequests = this.requests.get(identifier) || [];
		const recentRequests = userRequests.filter(
			(timestamp) => now - timestamp < this.timeWindow,
		);

		return Math.max(0, this.maxRequests - recentRequests.length);
	}

	/**
	 * Reset rate limit for an identifier
	 * @param identifier Unique identifier
	 */
	reset(identifier: string): void {
		this.requests.delete(identifier);
	}

	/**
	 * Clear all rate limits
	 */
	clear(): void {
		this.requests.clear();
	}
}

/**
 * Create a rate limiter instance
 */
export const defaultRateLimiter = new RateLimiter();

/**
 * Security audit log entry
 */
export interface SecurityAuditLog {
	timestamp: string;
	level: "info" | "warn" | "error";
	type: string;
	message: string;
	details?: Record<string, unknown>;
	sourceIp?: string;
	userAgent?: string;
}

/**
 * Security audit logger
 */
export class SecurityAuditLogger {
	private logs: SecurityAuditLog[] = [];
	private readonly maxLogs: number = 1000;

	/**
	 * Log a security event
	 * @param level Log level
	 * @param type Event type
	 * @param message Event message
	 * @param details Additional details
	 * @param sourceIp Source IP address
	 * @param userAgent User agent
	 */
	log(
		level: "info" | "warn" | "error",
		type: string,
		message: string,
		details?: Record<string, unknown>,
		sourceIp?: string,
		userAgent?: string,
	): void {
		const logEntry: SecurityAuditLog = {
			timestamp: new Date().toISOString(),
			level,
			type,
			message,
			details,
			sourceIp,
			userAgent,
		};

		this.logs.push(logEntry);

		// Maintain log size limit
		if (this.logs.length > this.maxLogs) {
			this.logs.shift();
		}

		// Also log to console for development
		if (process.env.NODE_ENV !== "production") {
			console.log(
				`[SECURITY AUDIT] ${level.toUpperCase()}: ${type} - ${message}`,
				details,
			);
		}
	}

	/**
	 * Get security logs
	 * @returns Array of security audit logs
	 */
	getLogs(): SecurityAuditLog[] {
		return [...this.logs];
	}

	/**
	 * Clear security logs
	 */
	clearLogs(): void {
		this.logs = [];
	}

	/**
	 * Get logs by type
	 * @param type Log type
	 * @returns Array of matching logs
	 */
	getLogsByType(type: string): SecurityAuditLog[] {
		return this.logs.filter((log) => log.type === type);
	}

	/**
	 * Get logs by level
	 * @param level Log level
	 * @returns Array of matching logs
	 */
	getLogsByLevel(level: "info" | "warn" | "error"): SecurityAuditLog[] {
		return this.logs.filter((log) => log.level === level);
	}
}

/**
 * Create security audit logger instance
 */
export const securityAuditLogger = new SecurityAuditLogger();
