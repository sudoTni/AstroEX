/**
 * Application constants and configuration for AstroEX
 * Version 3.5.0
 *
 * This file contains all constants used throughout the application.
 * Centralized constants improve maintainability and consistency.
 *
 * Version 3.5.0 Improvements:
 * - Fixed merge conflicts in constants file
 * - Resolved regex escape character issues in scrapeJob.ts
 * - Fixed unterminated string literal in security.ts
 * - Improved control character handling in security functions
 * - Enhanced error handling and security validation
 * - Optimized performance and code quality
 * - Updated comprehensive documentation
 */

// =============================================================================
// IMPORTS
// =============================================================================

import * as path from "node:path";

// =============================================================================
// APPLICATION CONSTANTS
// =============================================================================

/** Application name */
export const APP_NAME = "AstroEX";

/** Application version */
export const APP_VERSION = "3.5.0";

/** Application description */
export const APP_DESCRIPTION =
	"Advanced LinkedIn job scraping, filtering, and evaluation tool with enhanced API support, CLI parameter consistency, and AI-powered resume optimization";

/** Author information */
export const AUTHOR = "tjenkel";

/** Contributors */
export const CONTRIBUTORS = [
	{
		name: "llpujol",
		url: "https://github.com/llpujol",
	},
];

/** License type */
export const LICENSE = "MIT";

/** Minimum Node.js version */
export const MIN_NODE_VERSION = "12.0.0";

// =============================================================================
// PATH CONSTANTS
// =============================================================================

/** Root directory path */
export const ROOT_DIR = path.resolve(__dirname, "..", "..");

/** Data directory path */
export const DATA_DIR = path.join(ROOT_DIR, "data");

/** Logs directory path */
export const LOGS_DIR = path.join(ROOT_DIR, "logs");

/** Materials directory path */
export const MATERIALS_DIR = path.join(ROOT_DIR, "materials");

/** External data directory path */
export const EXTERNAL_DATA_DIR = path.join(ROOT_DIR, "user_data");

/** Resume file path */
export const RESUME_FILE_PATH = path.join(EXTERNAL_DATA_DIR, "my_resume.txt");

/** Professional title file path */
export const PROFESSIONAL_TITLE_FILE_PATH = path.join(
	EXTERNAL_DATA_DIR,
	"my_professional_title.txt",
);

/** Professional summary file path */
export const PROFESSIONAL_SUMMARY_FILE_PATH = path.join(
	EXTERNAL_DATA_DIR,
	"my_professional_summary.txt",
);

/** Key skills file path */
export const KEY_SKILLS_FILE_PATH = path.join(
	EXTERNAL_DATA_DIR,
	"my_key_skills.txt",
);

/** Testimonials file path */
export const TESTIMONIALS_FILE_PATH = path.join(
	EXTERNAL_DATA_DIR,
	"my_testimonials.txt",
);

// =============================================================================
// FILE PATTERNS
// =============================================================================

/** Processed job files pattern */
export const PROCESSED_JOB_FILES_PATTERN = "processed_jobs_*.json";

/** Clothed job files pattern */
export const CLOTHED_JOB_FILES_PATTERN = "clothed_jobs_*.json";

/** Judged job files pattern */
export const JUDGED_JOB_FILES_PATTERN = "judged_jobs_*.json";

/** Log files pattern */
export const LOG_FILES_PATTERN = "*.log";

/** Prompt files pattern */
export const PROMPT_FILES_PATTERN = "*.json";

// =============================================================================
// DEFAULT CONFIGURATION VALUES
// =============================================================================

/** Default AI provider configuration */
export const DEFAULT_AI_CONFIG = {
	base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
	api_key: "",
	model_id: "gemini-2.0-flash-thinking-exp-01-21",
	temperature: 0.45,
	top_p: 0.95,
	"max-tokens": 16000,
	timeout: 60,
};

/** Default scraping configuration */
export const DEFAULT_SCRAPING_CONFIG = {
	headless: true,
	timeout: 30000,
	concurrency: 1,
	requestDelay: 1000,
};

/** Default job processing configuration */
export const DEFAULT_JOB_PROCESSING_CONFIG = {
	batch: 50,
	retries: 3,
	"ping-interval": 15,
	"openai-timeout": 60,
	verbose: false,
	"log-payload": false,
	removeDuplicates: true,
	minConfidence: 0.7,
	maxJobs: 1000,
};

/** Default logging configuration */
export const DEFAULT_LOGGING_CONFIG = {
	logDir: LOGS_DIR,
	logFile: "astroex.log",
	"disable-file-logging": false,
	level: "info" as const,
};

/** Default performance configuration */
export const DEFAULT_PERFORMANCE_CONFIG = {
	defaultBatchSize: 100,
	maxConcurrentCalls: 5,
	enableMonitoring: true,
};

// =============================================================================
// AI PROVIDER SETTINGS
// =============================================================================

/** Supported AI providers */
export const SUPPORTED_AI_PROVIDERS = {
	OPENAI: "openai",
	GEMINI: "gemini",
	MISTRAL: "mistral",
} as const;

/** Default models for each provider */
export const DEFAULT_MODELS = {
	[SUPPORTED_AI_PROVIDERS.OPENAI]: "gpt-4-turbo-preview",
	[SUPPORTED_AI_PROVIDERS.GEMINI]: "gemini-2.0-flash-thinking-exp-01-21",
	[SUPPORTED_AI_PROVIDERS.MISTRAL]: "mistral-medium-latest",
} as const;

/** Base URLs for each provider */
export const PROVIDER_BASE_URLS = {
	[SUPPORTED_AI_PROVIDERS.OPENAI]: "https://api.openai.com/v1",
	[SUPPORTED_AI_PROVIDERS.GEMINI]:
		"https://generativelanguage.googleapis.com/v1beta/openai",
	[SUPPORTED_AI_PROVIDERS.MISTRAL]: "https://api.mistral.ai/v1",
} as const;

// =============================================================================
// PUPPETEER CONFIGURATION
// =============================================================================

/** Default Puppeteer launch options */
export const PUPPETEER_LAUNCH_OPTIONS = {
	headless: "new" as const,
	args: [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-dev-shm-usage",
		"--disable-accelerated-2d-canvas",
		"--no-first-run",
		"--no-zygote",
		"--disable-gpu",
	],
};

/** Puppeteer viewport configuration */
export const PUPPETEER_VIEWPORT = {
	width: 1920,
	height: 1080,
};

/** Default navigation timeout */
export const DEFAULT_NAVIGATION_TIMEOUT = 30000;

/** Default wait timeout */
export const DEFAULT_WAIT_TIMEOUT = 10000;

// =============================================================================
// LINKEDIN SPECIFIC CONSTANTS
// =============================================================================

/** LinkedIn base URL */
export const LINKEDIN_BASE_URL = "https://www.linkedin.com";

/** LinkedIn jobs URL */
export const LINKEDIN_JOBS_URL = "https://www.linkedin.com/jobs";

/** LinkedIn authentication wall path */
export const LINKEDIN_AUTHWALL_PATH = "linkedin.com/authwall";

/** LinkedIn job search card selector */
export const LINKEDIN_JOB_SEARCH_SELECTOR = ".job-search-card";

/** LinkedIn job title selectors */
export const LINKEDIN_JOB_TITLE_SELECTORS = [
	"h1.top-card-layout__title",
	"h1.topcard__title",
];

/** LinkedIn company name selectors */
export const LINKEDIN_COMPANY_SELECTORS = ["a.topcard__org-name-link"];

/** LinkedIn location selector */
export const LINKEDIN_LOCATION_SELECTOR =
	"//div[contains(@class,'topcard__flavor-row')]/span[contains(@class, 'topcard__flavor--bullet')]/text()";

/** LinkedIn posted time selectors */
export const LINKEDIN_POSTED_TIME_SELECTORS = ["span.posted-time-ago__text"];

/** LinkedIn applicants selector */
export const LINKEDIN_APPLICANTS_SELECTOR = "span.num-applicants__caption";

/** LinkedIn salary selectors */
export const LINKEDIN_SALARY_SELECTORS = [
	"div.compensation__salary",
	"span.main-job-card__salary-info",
];

/** LinkedIn job criteria selectors */
export const LINKEDIN_JOB_CRITERIA_SELECTORS = {
	seniority:
		"//h3[contains(text(), 'Seniority level')]/following-sibling::span/text()",
	employment:
		"//h3[contains(text(), 'Employment type')]/following-sibling::span/text()",
	function:
		"//h3[contains(text(), 'Job function')]/following-sibling::span/text()",
	industries:
		"//h3[contains(text(), 'Industries')]/following-sibling::span/text()",
};

/** LinkedIn description selectors */
export const LINKEDIN_DESCRIPTION_SELECTORS = [
	"div.description__text--rich div.show-more-less-html__markup",
];

/** LinkedIn "See more" button selector */
export const LINKEDIN_SEE_MORE_SELECTOR = ".show-more-less-html__button";

// =============================================================================
// HTTP STATUS CODES
// =============================================================================

/** HTTP 429 Too Many Requests */
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;

/** HTTP 500 Internal Server Error */
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

/** HTTP 502 Bad Gateway */
export const HTTP_STATUS_BAD_GATEWAY = 502;

/** HTTP 503 Service Unavailable */
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

/** HTTP 504 Gateway Timeout */
export const HTTP_STATUS_GATEWAY_TIMEOUT = 504;

// =============================================================================
// RETRY CONFIGURATION
// =============================================================================

/** Default maximum retry attempts */
export const DEFAULT_MAX_RETRIES = 3;

/** Default retry delay in milliseconds */
export const DEFAULT_RETRY_DELAY = 5000;

/** Exponential backoff base */
export const EXPONENTIAL_BACKOFF_BASE = 2;

/** Maximum retry delay in milliseconds */
export const MAX_RETRY_DELAY = 30000;

/** Status codes that should trigger retry */
export const RETRY_STATUS_CODES = [
	HTTP_STATUS_TOO_MANY_REQUESTS,
	HTTP_STATUS_INTERNAL_SERVER_ERROR,
	HTTP_STATUS_BAD_GATEWAY,
	HTTP_STATUS_SERVICE_UNAVAILABLE,
	HTTP_STATUS_GATEWAY_TIMEOUT,
];

// =============================================================================
// PERFORMANCE CONSTANTS
// =============================================================================

/** Default performance monitoring batch size */
export const DEFAULT_PERFORMANCE_BATCH_SIZE = 10;

/** Performance monitoring log interval */
export const PERFORMANCE_LOG_INTERVAL = 30000; // 30 seconds

/** Memory usage warning threshold (in bytes) */
export const MEMORY_WARNING_THRESHOLD = 500 * 1024 * 1024; // 500MB

/** Memory usage critical threshold (in bytes) */
export const MEMORY_CRITICAL_THRESHOLD = 1000 * 1024 * 1024; // 1GB

// =============================================================================
// VALIDATION CONSTANTS
// =============================================================================

/** Minimum confidence score */
export const MIN_CONFIDENCE_SCORE = 0.0;

/** Maximum confidence score */
export const MAX_CONFIDENCE_SCORE = 1.0;

/** Minimum temperature value */
export const MIN_TEMPERATURE = 0.0;

/** Maximum temperature value */
export const MAX_TEMPERATURE = 2.0;

/** Minimum top-p value */
export const MIN_TOP_P = 0.0;

/** Maximum top-p value */
export const MAX_TOP_P = 1.0;

/** Minimum batch size */
export const MIN_BATCH_SIZE = 1;

/** Maximum batch size */
export const MAX_BATCH_SIZE = 1000;

/** Minimum timeout value */
export const MIN_TIMEOUT = 1000; // 1 second

/** Maximum timeout value */
export const MAX_TIMEOUT = 300000; // 5 minutes

// =============================================================================
// UTILITY CONSTANTS
// =============================================================================

/** Date format for file names */
export const FILE_DATE_FORMAT = "yyyyMMdd_HHmmss";

/** Date format for log entries */
export const LOG_DATE_FORMAT = "yyyy-MM-dd HH:mm:ss";

/** Date format for display */
export const DISPLAY_DATE_FORMAT = "yyyy-mm-dd";

/** Supported file extensions */
export const SUPPORTED_FILE_EXTENSIONS = {
	json: [".json"],
	text: [".txt", ".md"],
	log: [".log"],
};

/** Maximum file size for reading (in bytes) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** Default encoding for file operations */
export const DEFAULT_FILE_ENCODING = "utf-8";

// =============================================================================
// ERROR MESSAGES
// =============================================================================

/** Generic error messages */
export const ERROR_MESSAGES = {
	FILE_NOT_FOUND: "File not found",
	FILE_NOT_READABLE: "File is not readable",
	FILE_EMPTY: "File is empty",
	INVALID_JSON: "Invalid JSON format",
	INVALID_ARRAY: "File does not contain a JSON array",
	NETWORK_ERROR: "Network error occurred",
	TIMEOUT_ERROR: "Operation timed out",
	AUTHENTICATION_ERROR: "Authentication failed",
	RATE_LIMIT_ERROR: "Rate limit exceeded",
	VALIDATION_ERROR: "Validation failed",
	UNKNOWN_ERROR: "Unknown error occurred",
} as const;

// =============================================================================
// SUCCESS MESSAGES
// =============================================================================

/** Success messages */
export const SUCCESS_MESSAGES = {
	OPERATION_COMPLETED: "Operation completed successfully",
	DATA_PROCESSED: "Data processed successfully",
	FILE_SAVED: "File saved successfully",
	ANALYSIS_COMPLETED: "Analysis completed successfully",
	OPTIMIZATION_COMPLETED: "Optimization completed successfully",
} as const;

// =============================================================================
// WARNING MESSAGES
// =============================================================================

/** Warning messages */
export const WARNING_MESSAGES = {
	DUPLICATE_DATA: "Duplicate data found and removed",
	DATA_TRUNCATED: "Data truncated due to size limits",
	PERFORMANCE_DEGRADED: "Performance degraded due to resource constraints",
	FALLBACK_BEHAVIOR: "Using fallback behavior due to error",
} as const;
