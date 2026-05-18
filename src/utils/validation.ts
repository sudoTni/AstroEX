/**
 * Enhanced Input Validation Module
 *
 * This module provides comprehensive input validation utilities with type safety,
 * detailed error messages, and security-focused validation patterns.
 *
 * Features:
 * - Zod-based schema validation with type inference
 * - Security-focused input sanitization
 * - Comprehensive error handling with detailed messages
 * - Integration with existing error handling patterns
 * - Support for custom validation rules
 */

import { z } from "zod";
import { createError, ErrorType } from "./errors";

// ===== Type-safe validation schemas =====

/**
 * Base validation schema for common input types
 */
export const BaseInputSchema = z.object({
	id: z.string().min(1).max(100).optional(),
	name: z.string().min(1).max(200).optional(),
	description: z.string().min(0).max(2000).optional(),
	url: z.string().url().optional(),
	email: z.string().email().optional(),
	number: z.number().min(0).max(1000000).optional(),
	boolean: z.boolean().optional(),
	array: z.array(z.unknown()).optional(),
	object: z.record(z.unknown()).optional(),
});

export type BaseInputType = z.infer<typeof BaseInputSchema>;

/**
 * Enhanced API key validation schema
 */
export const ApiKeySchema = z
	.string()
	.min(10, "API key must be at least 10 characters long")
	.max(100, "API key must be at most 100 characters long")
	.regex(
		/^[a-zA-Z0-9\-_]+$/,
		"API key can only contain letters, numbers, hyphens, and underscores",
	)
	.refine((key) => {
		// Check for test patterns
		const testPatterns = [
			/sk-test/i,
			/test_/i,
			/demo/i,
			/example/i,
			/fake/i,
			/mock/i,
		];
		return !testPatterns.some((pattern) => pattern.test(key));
	}, "API key appears to be a test/demo key");

/**
 * Enhanced URL validation schema
 */
export const UrlSchema = z
	.string()
	.url("Invalid URL format")
	.refine((url) => {
		try {
			const parsed = new URL(url);
			// Check for common dangerous protocols
			const dangerousProtocols = ["javascript:", "data:", "vbscript:", "file:"];
			return !dangerousProtocols.includes(parsed.protocol);
		} catch {
			return false;
		}
	}, "URL contains potentially dangerous protocol")
	.refine((url) => {
		// Check for IP addresses in URLs (security concern)
		const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
		return !ipPattern.test(url);
	}, "URL contains IP address (security risk)")
	.refine((url) => {
		// Check for localhost
		return !url.includes("localhost") && !url.includes("127.0.0.1");
	}, "URL contains localhost (security risk)");

/**
 * Enhanced file path validation schema
 */
export const FilePathSchema = z
	.string()
	.min(1, "File path cannot be empty")
	.max(500, "File path is too long")
	.refine((path) => {
		// Remove path traversal attempts
		const sanitized = path
			.replace(/\.\.\//g, "")
			.replace(/\/+/g, "/")
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");

		// Check for dangerous patterns
		const dangerousPatterns = [
			/\\.\./, // Windows parent directory
			/\/\.\./, // Unix parent directory
			/\\~/, // Windows home directory
			/\/~/, // Unix home directory
			/\\$/, // Trailing backslash
			/\/$/, // Trailing slash
		];

		return !dangerousPatterns.some((pattern) => pattern.test(sanitized));
	}, "File path contains potentially dangerous patterns");

/**
 * Enhanced temperature validation schema
 */
export const TemperatureSchema = z
	.number()
	.min(0, "Temperature must be at least 0")
	.max(2, "Temperature must be at most 2")
	.step(0.1, "Temperature must be in increments of 0.1");

/**
 * Enhanced topP validation schema
 */
export const TopPSchema = z
	.number()
	.min(0, "Top-P must be at least 0")
	.max(1, "Top-P must be at most 1")
	.step(0.01, "Top-P must be in increments of 0.01");

/**
 * Enhanced maxTokens validation schema
 */
export const MaxTokensSchema = z
	.number()
	.min(1, "Max tokens must be at least 1")
	.max(32000, "Max tokens must be at most 32,000");

/**
 * Enhanced timeout validation schema
 */
export const TimeoutSchema = z
	.number()
	.min(1000, "Timeout must be at least 1000ms")
	.max(300000, "Timeout must be at most 300000ms (5 minutes)");

/**
 * Enhanced job ID validation schema
 */
export const JobIdSchema = z
	.string()
	.min(1, "Job ID cannot be empty")
	.max(50, "Job ID is too long")
	.regex(
		/^[a-zA-Z0-9\-_]+$/,
		"Job ID can only contain letters, numbers, hyphens, and underscores",
	);

/**
 * Enhanced company name validation schema
 */
export const CompanyNameSchema = z
	.string()
	.min(1, "Company name cannot be empty")
	.max(100, "Company name is too long")
	.regex(/^[a-zA-Z0-9\s\-_&.,]+$/, "Company name contains invalid characters");

/**
 * Enhanced location validation schema
 */
export const LocationSchema = z
	.string()
	.min(1, "Location cannot be empty")
	.max(200, "Location is too long")
	.regex(/^[a-zA-Z0-9\s\-_.,]+$/, "Location contains invalid characters");

/**
 * Enhanced job title validation schema
 */
export const JobTitleSchema = z
	.string()
	.min(1, "Job title cannot be empty")
	.max(200, "Job title is too long")
	.regex(/^[a-zA-Z0-9\s\-_&.,()]+$/, "Job title contains invalid characters");

/**
 * Enhanced salary validation schema
 */
export const SalarySchema = z
	.string()
	.min(0, "Salary cannot be negative")
	.max(50, "Salary value is too long")
	.regex(/^[0-9\s\-kK$€£¥]+$/, "Salary contains invalid characters")
	.optional();

/**
 * Enhanced salary currency validation schema
 */
export const SalaryCurrencySchema = z.enum([
	"USD",
	"EUR",
	"GBP",
	"RON",
	"CHF",
	"",
]);

/**
 * Enhanced job type validation schema
 */
export const JobTypeSchema = z
	.enum([
		"full-time",
		"part-time",
		"contract",
		"internship",
		"temporary",
		"freelance",
		"other",
	])
	.optional();

/**
 * Enhanced experience level validation schema
 */
export const ExperienceLevelSchema = z
	.enum([
		"internship",
		"entry",
		"associate",
		"mid-senior level",
		"director",
		"executive",
		"not applicable",
	])
	.optional();

/**
 * Enhanced employment type validation schema
 */
export const EmploymentTypeSchema = z
	.enum([
		"full-time",
		"part-time",
		"contract",
		"internship",
		"temporary",
		"other",
	])
	.optional();

/**
 * Enhanced seniority level validation schema
 */
export const SeniorityLevelSchema = z
	.enum([
		"intern",
		"entry",
		"associate",
		"mid-level",
		"senior",
		"lead",
		"manager",
		"director",
		"executive",
		"owner",
		"partner",
		"volunteer",
		"other",
	])
	.optional();

/**
 * Enhanced job function validation schema
 */
export const JobFunctionSchema = z
	.string()
	.min(0, "Job function cannot be negative")
	.max(100, "Job function is too long")
	.regex(/^[a-zA-Z0-9\s\-_&.,()]+$/, "Job function contains invalid characters")
	.optional();

/**
 * Enhanced industries validation schema
 */
export const IndustriesSchema = z
	.string()
	.min(0, "Industries cannot be negative")
	.max(200, "Industries is too long")
	.regex(/^[a-zA-Z0-9\s\-_&.,()]+$/, "Industries contains invalid characters")
	.optional();

/**
 * Enhanced job posted date validation schema
 */
export const PostedDateSchema = z
	.string()
	.min(1, "Posted date cannot be empty")
	.max(50, "Posted date is too long")
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Posted date must be in YYYY-MM-DD format")
	.optional();

/**
 * Enhanced applicants validation schema
 */
export const ApplicantsSchema = z
	.string()
	.min(0, "Applicants cannot be negative")
	.max(20, "Applicants value is too long")
	.regex(/^[0-9kKmM]+$/, "Applicants contains invalid characters")
	.optional();

/**
 * Enhanced salary range validation schema
 */
export const SalaryRangeSchema = z
	.string()
	.min(0, "Salary range cannot be negative")
	.max(100, "Salary range is too long")
	.regex(/^[0-9\s\-kK$€£¥]+$/, "Salary range contains invalid characters")
	.optional();

/**
 * Enhanced posted time validation schema
 */
export const PostedTimeSchema = z
	.string()
	.min(0, "Posted time cannot be negative")
	.max(50, "Posted time is too long")
	.regex(/^[0-9\s\-:+a-zA-Z]+$/, "Posted time contains invalid characters")
	.optional();

/**
 * Enhanced remote ok validation schema
 */
export const RemoteOkSchema = z.boolean().optional();

/**
 * Enhanced metadata validation schema
 */
export const MetadataSchema = z
	.object({
		source: z.string().min(1).max(50),
		scrapedAt: z.string().min(1).max(50),
		confidence: z.number().min(0).max(1),
	})
	.optional();

/**
 * Enhanced estimated salary validation schema
 */
export const EstimatedSalarySchema = z
	.object({
		min: z.number().min(0),
		max: z.number().min(0),
		currency: SalaryCurrencySchema,
	})
	.optional();

/**
 * Enhanced scraped job validation schema
 */
export const ScrapedJobSchema = z.object({
	id: JobIdSchema,
	title: JobTitleSchema,
	company: CompanyNameSchema,
	location: LocationSchema,
	descriptionText: z.string().min(1, "Description text cannot be empty"),
	descriptionHtml: z.string().min(1, "Description HTML cannot be empty"),
	url: UrlSchema,
	postedDate: PostedDateSchema,
	salary: SalarySchema,
	salaryCurrency: SalaryCurrencySchema,
	jobType: JobTypeSchema,
	experienceLevel: ExperienceLevelSchema,
	estimatedSalary: EstimatedSalarySchema,
	metadata: MetadataSchema,
	applicants: ApplicantsSchema,
	seniorityLevel: SeniorityLevelSchema,
	employmentType: EmploymentTypeSchema,
	jobFunction: JobFunctionSchema,
	industries: IndustriesSchema,
	salaryRange: SalaryRangeSchema,
	postedTime: PostedTimeSchema,
	remoteOk: RemoteOkSchema,
});

export type ScrapedJobType = z.infer<typeof ScrapedJobSchema>;

/**
 * Enhanced job interface validation schema
 */
export const JobInterfaceSchema = ScrapedJobSchema.extend({
	confidence: z.number().min(0).max(1).optional(),
	isVeryHighlyAligned: z.boolean().optional(),
	rationale: z.string().optional(),
});

export type JobInterfaceType = z.infer<typeof JobInterfaceSchema>;

/**
 * Enhanced LLM request validation schema
 */
export const LLMRequestSchema = z.object({
	provider: z.enum([
		"openai",
		"gemini",
		"mistral",
		"openrouter",
		"cerebras",
		"anthropic",
	]),
	model: z.string().min(1, "Model name cannot be empty"),
	messages: z
		.array(
			z.object({
				role: z.enum(["system", "user", "assistant"]),
				content: z.string().min(1, "Message content cannot be empty"),
			}),
		)
		.min(1, "At least one message is required"),
	temperature: TemperatureSchema.optional(),
	topP: TopPSchema.optional(),
	maxTokens: MaxTokensSchema.optional(),
	timeout: TimeoutSchema.optional(),
	responseSchema: z.any().optional(),
});

export type LLMRequestType = z.infer<typeof LLMRequestSchema>;

/**
 * Enhanced AI provider config validation schema
 */
export const AIProviderConfigSchema = z.object({
	name: z.string().min(1, "Provider name cannot be empty"),
	baseUrl: UrlSchema,
	apiKey: ApiKeySchema,
	model: z.string().min(1, "Model cannot be empty"),
	temperature: TemperatureSchema.optional(),
	topP: TopPSchema.optional(),
	maxTokens: MaxTokensSchema.optional(),
	timeout: TimeoutSchema.optional(),
});

export type AIProviderConfigType = z.infer<typeof AIProviderConfigSchema>;

/**
 * Enhanced preset validation schema
 */
export const PresetSchema = z.object({
	name: z.string().min(1, "Preset name cannot be empty"),
	provider: z.enum([
		"openai",
		"gemini",
		"mistral",
		"openrouter",
		"cerebras",
		"anthropic",
	]),
	base_url: UrlSchema,
	modelId: z.string().min(1, "Model ID cannot be empty"),
	promptTemplate: z.string().min(1, "Prompt template cannot be empty"),
	temperature: TemperatureSchema,
	topP: TopPSchema,
	maxTokens: MaxTokensSchema.optional(),
	description: z.string().optional(),
});

export type PresetType = z.infer<typeof PresetSchema>;

/**
 * Enhanced preset config validation schema
 */
export const PresetConfigSchema = z.object({
	jobCloth: z.record(PresetSchema),
	jobJudge: z.record(PresetSchema),
	makeMaterials: z.record(PresetSchema),
});

export type PresetConfigType = z.infer<typeof PresetConfigSchema>;

/**
 * Enhanced global args validation schema
 */
export const GlobalArgsSchema = z.object({
	logDir: FilePathSchema.optional(),
	logFile: z.string().min(1).max(100).optional(),
	disableFileLogging: z.boolean().optional(),
	verbose: z.boolean().optional(),
});

export type GlobalArgsType = z.infer<typeof GlobalArgsSchema>;

/**
 * Enhanced job judge args validation schema
 */
export const JobJudgeArgsSchema = GlobalArgsSchema.extend({
	"api-key": ApiKeySchema,
	"base-url": UrlSchema,
	"model-id": z.string().min(1, "Model ID cannot be empty"),
	temperature: TemperatureSchema.optional(),
	top_p: TopPSchema.optional(),
	"input-file": FilePathSchema,
	"output-file": FilePathSchema,
	batch: z.number().min(1).max(100).optional(),
	retries: z.number().min(0).max(10).optional(),
	"max-tokens": MaxTokensSchema.optional(),
	"ping-interval": z.number().min(1000).max(30000).optional(),
	"openai-timeout": z.number().min(1000).max(300000).optional(),
	"log-payload": z.boolean().optional(),
	preset: z.string().min(1).max(50).optional(),
	provider: z
		.enum([
			"openai",
			"gemini",
			"mistral",
			"openrouter",
			"cerebras",
			"anthropic",
		])
		.optional(),
	sleep: z.number().min(0).max(300).optional(),
	"strict-parsing": z.boolean().optional(),
});

export type JobJudgeArgsType = z.infer<typeof JobJudgeArgsSchema>;

/**
 * Enhanced job cloth args validation schema
 */
export const JobClothArgsSchema = GlobalArgsSchema.extend({
	"api-key": ApiKeySchema,
	"base-url": UrlSchema,
	"model-id": z.string().min(1, "Model ID cannot be empty"),
	temperature: TemperatureSchema.optional(),
	top_p: TopPSchema.optional(),
	"input-file": FilePathSchema,
	"output-file": FilePathSchema,
	batch: z.number().min(1).max(100).optional(),
	retries: z.number().min(0).max(10).optional(),
	"max-tokens": MaxTokensSchema.optional(),
	"ping-interval": z.number().min(1000).max(30000).optional(),
	"openai-timeout": z.number().min(1000).max(300000).optional(),
	"log-payload": z.boolean().optional(),
	preset: z.string().min(1).max(50).optional(),
	provider: z
		.enum([
			"openai",
			"gemini",
			"mistral",
			"openrouter",
			"cerebras",
			"anthropic",
		])
		.optional(),
});

export type JobClothArgsType = z.infer<typeof JobClothArgsSchema>;

/**
 * Enhanced make materials args validation schema
 */
export const MakeMaterialsArgsSchema = GlobalArgsSchema.extend({
	"api-key": ApiKeySchema,
	"base-url": UrlSchema,
	"model-id": z.string().min(1, "Model ID cannot be empty"),
	temperature: TemperatureSchema.optional(),
	top_p: TopPSchema.optional(),
	"input-file": FilePathSchema,
	"output-file": FilePathSchema,
	"cover-letter-length": z.number().min(1).max(5000).optional(),
	"log-payload": z.boolean().optional(),
	preset: z.string().min(1).max(50).optional(),
	provider: z
		.enum([
			"openai",
			"gemini",
			"mistral",
			"openrouter",
			"cerebras",
			"anthropic",
		])
		.optional(),
	model: z.string().min(1).max(100).optional(),
});

export type MakeMaterialsArgsType = z.infer<typeof MakeMaterialsArgsSchema>;

/**
 * Enhanced er44zz mode args validation schema
 */
export const Er44zzModeArgsSchema = GlobalArgsSchema.extend({
	mode: z.enum(["1", "2", "3", "4"]),
	provider: z.enum([
		"openai",
		"gemini",
		"mistral",
		"openrouter",
		"cerebras",
		"anthropic",
	]),
	model: z.string().min(1, "Model cannot be empty"),
	"use-sys-prompt": z.boolean().optional(),
	"test-mode": z.enum(["0", "1", "2"]),
	thoughts: z.boolean().optional(),
	"model-id": z.string().min(1).max(100).optional(),
	"api-key": ApiKeySchema.optional(),
	"base-url": UrlSchema.optional(),
	temperature: TemperatureSchema.optional(),
	top_p: TopPSchema.optional(),
	"max-tokens": MaxTokensSchema.optional(),
});

export type Er44zzModeArgsType = z.infer<typeof Er44zzModeArgsSchema>;

/**
 * Enhanced scraping args validation schema
 */
export const ScrapingArgsSchema = GlobalArgsSchema.extend({
	headless: z.boolean().optional(),
	url: UrlSchema.optional(),
	"output-file": FilePathSchema.optional(),
	sleep: z.number().min(0).max(300).optional(),
});

export type ScrapingArgsType = z.infer<typeof ScrapingArgsSchema>;

/**
 * Enhanced processing stats validation schema
 */
export const ProcessingStatsSchema = z.object({
	filesProcessed: z.number().min(0),
	recordsMerged: z.number().min(0),
	duplicatesRemoved: z.number().min(0),
	filteredEntries: z.number().min(0),
	finalRecords: z.number().min(0),
	processingTime: z.number().min(0),
});

export type ProcessingStatsType = z.infer<typeof ProcessingStatsSchema>;

/**
 * Enhanced batch processing options validation schema
 */
export const BatchProcessingOptionsSchema = z.object({
	batchSize: z.number().min(1).max(100),
	maxRetries: z.number().min(0).max(10),
	retryDelay: z.number().min(1000).max(30000),
	timeout: z.number().min(1000).max(300000),
	parallelProcessing: z.boolean(),
	maxConcurrentBatches: z.number().min(1).max(10),
});

export type BatchProcessingOptionsType = z.infer<
	typeof BatchProcessingOptionsSchema
>;

/**
 * Enhanced search options validation schema
 */
export const SearchOptionsSchema = z.object({
	query: z.string().min(1, "Search query cannot be empty"),
	location: z.string().min(0).max(100).optional(),
	distance: z.number().min(0).max(1000).optional(),
	datePosted: z.enum(["any", "today", "week", "month"]).optional(),
	jobType: z
		.enum(["full-time", "part-time", "contract", "internship"])
		.optional(),
	experienceLevel: z
		.enum([
			"internship",
			"entry",
			"associate",
			"mid-senior level",
			"director",
			"executive",
		])
		.optional(),
	sortBy: z.enum(["relevance", "date", "salary"]).optional(),
	sortOrder: z.enum(["ascending", "descending"]).optional(),
});

export type SearchOptionsType = z.infer<typeof SearchOptionsSchema>;

/**
 * Enhanced filter options validation schema
 */
export const FilterOptionsSchema = z.object({
	companies: z.array(z.string().min(1).max(100)).optional(),
	titles: z.array(z.string().min(1).max(100)).optional(),
	locations: z.array(z.string().min(1).max(100)).optional(),
	excludeCompanies: z.array(z.string().min(1).max(100)).optional(),
	excludeTitles: z.array(z.string().min(1).max(100)).optional(),
	minSalary: z.number().min(0).optional(),
	maxSalary: z.number().min(0).optional(),
	keywords: z.array(z.string().min(1).max(100)).optional(),
	excludeKeywords: z.array(z.string().min(1).max(100)).optional(),
});

export type FilterOptionsType = z.infer<typeof FilterOptionsSchema>;

/**
 * Enhanced application config validation schema
 */
export const AppConfigSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().min(1),
	environment: z.enum(["development", "staging", "production"]),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	port: z.number().min(1).max(65535),
	database: z.object({
		host: z.string().min(1),
		port: z.number().min(1).max(65535),
		name: z.string().min(1),
		username: z.string().min(1),
		password: z.string().min(1),
	}),
	security: z.object({
		jwtSecret: z.string().min(32),
		jwtExpiration: z.string().min(1),
		bcryptRounds: z.number().min(4).max(12),
	}),
	performance: z.object({
		enableMetrics: z.boolean(),
		metricsInterval: z.number().min(1000),
	}),
});

export type AppConfigType = z.infer<typeof AppConfigSchema>;

// ===== Validation utilities =====

/**
 * Enhanced validation result interface
 */
export interface ValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	sanitized?: unknown;
}

/**
 * Enhanced validator class with comprehensive validation capabilities
 */
export class EnhancedValidator {
	/**
	 * Validate input against schema with enhanced error reporting
	 */
	static validate<T>(
		schema: z.ZodType<T>,
		data: unknown,
		context: string = "Input validation",
	): T {
		const result = schema.safeParse(data);

		if (!result.success) {
			const errors = result.error.errors.map((error) => {
				const path = error.path.join(".");
				const message = error.message;
				return `${path}: ${message}`;
			});

			throw createError(
				ErrorType.SCHEMA_VALIDATION_FAILED,
				`Validation failed for ${context}: ${errors.join(", ")}`,
				{ context, errors, data },
				result.error,
			);
		}

		return result.data;
	}

	/**
	 * Validate input with partial validation (useful for updates)
	 */
	static validatePartial<T>(
		schema: z.ZodType<T>,
		data: unknown,
		context: string = "Partial validation",
	): Partial<T> {
		const result = schema.safeParse(data);

		if (!result.success) {
			const errors = result.error.errors.map((error) => {
				const path = error.path.join(".");
				const message = error.message;
				return `${path}: ${message}`;
			});

			throw createError(
				ErrorType.SCHEMA_VALIDATION_FAILED,
				`Partial validation failed for ${context}: ${errors.join(", ")}`,
				{ context, errors, data },
				result.error,
			);
		}

		return result.data;
	}

	/**
	 * Validate input with detailed error reporting
	 */
	static validateWithDetails<T>(
		schema: z.ZodType<T>,
		data: unknown,
		_context: string = "Input validation",
	): ValidationResult {
		const result = schema.safeParse(data);

		if (result.success) {
			return {
				isValid: true,
				errors: [],
				warnings: [],
				sanitized: result.data,
			};
		}

		const errors = result.error.errors.map((error) => {
			const path = error.path.join(".");
			const message = error.message;
			return `${path}: ${message}`;
		});

		return {
			isValid: false,
			errors,
			warnings: [],
		};
	}

	/**
	 * Validate multiple inputs at once
	 */
	static validateMultiple<T>(
		schemas: Record<string, z.ZodType<T>>,
		data: Record<string, unknown>,
		context: string = "Batch validation",
	): Record<string, T> {
		const result: Record<string, T> = {};
		const errors: string[] = [];

		for (const [key, schema] of Object.entries(schemas)) {
			try {
				result[key] = EnhancedValidator.validate(
					schema,
					data[key],
					`${context}.${key}`,
				);
			} catch (error) {
				if (error instanceof Error) {
					errors.push(`${key}: ${error.message}`);
				}
			}
		}

		if (errors.length > 0) {
			throw createError(
				ErrorType.SCHEMA_VALIDATION_FAILED,
				`Batch validation failed for ${context}: ${errors.join(", ")}`,
				{ context, errors, data },
				new Error(errors.join(", ")),
			);
		}

		return result;
	}

	/**
	 * Validate input with custom rules
	 */
	static validateWithCustomRules<T>(
		data: unknown,
		rules: Array<{
			name: string;
			validator: (value: T) => boolean;
			message: string;
		}>,
		context: string = "Custom validation",
	): T {
		const errors: string[] = [];

		for (const rule of rules) {
			try {
				if (!rule.validator(data as T)) {
					errors.push(rule.message);
				}
			} catch (error) {
				errors.push(
					`${rule.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (errors.length > 0) {
			throw createError(
				ErrorType.SCHEMA_VALIDATION_FAILED,
				`Custom validation failed for ${context}: ${errors.join(", ")}`,
				{ context, errors, data },
				new Error(errors.join(", ")),
			);
		}

		return data as T;
	}

	/**
	 * Sanitize input data
	 */
	static sanitize<T>(data: unknown, schema: z.ZodType<T>): T {
		try {
			// Parse and validate the data
			const validated = EnhancedValidator.validate(
				schema,
				data,
				"Sanitization",
			);

			// Additional sanitization can be added here
			return validated;
		} catch (error) {
			throw createError(
				ErrorType.VALIDATION_ERROR,
				`Data sanitization failed: ${error instanceof Error ? error.message : String(error)}`,
				{ data },
				error,
			);
		}
	}

	/**
	 * Validate and sanitize input data
	 */
	static validateAndSanitize<T>(
		schema: z.ZodType<T>,
		data: unknown,
		context: string = "Validation and sanitization",
	): T {
		try {
			const validated = EnhancedValidator.validate(schema, data, context);
			return EnhancedValidator.sanitize(validated, schema);
		} catch (error) {
			throw createError(
				ErrorType.VALIDATION_ERROR,
				`Validation and sanitization failed: ${error instanceof Error ? error.message : String(error)}`,
				{ context, data },
				error,
			);
		}
	}
}

// ===== Specialized validation functions =====

/**
 * Validate scraped job data
 */
export function validateScrapedJob(data: unknown): ScrapedJobType {
	return EnhancedValidator.validate(
		ScrapedJobSchema,
		data,
		"Scraped job validation",
	);
}

/**
 * Validate job interface data
 */
export function validateJobInterface(data: unknown): JobInterfaceType {
	return EnhancedValidator.validate(
		JobInterfaceSchema,
		data,
		"Job interface validation",
	);
}

/**
 * Validate LLM request data
 */
export function validateLLMRequest(data: unknown): LLMRequestType {
	return EnhancedValidator.validate(
		LLMRequestSchema,
		data,
		"LLM request validation",
	);
}

/**
 * Validate AI provider config data
 */
export function validateAIProviderConfig(data: unknown): AIProviderConfigType {
	return EnhancedValidator.validate(
		AIProviderConfigSchema,
		data,
		"AI provider config validation",
	);
}

/**
 * Validate preset data
 */
export function validatePreset(data: unknown): PresetType {
	return EnhancedValidator.validate(PresetSchema, data, "Preset validation");
}

/**
 * Validate preset config data
 */
export function validatePresetConfig(data: unknown): PresetConfigType {
	return EnhancedValidator.validate(
		PresetConfigSchema,
		data,
		"Preset config validation",
	);
}

/**
 * Validate global args data
 */
export function validateGlobalArgs(data: unknown): GlobalArgsType {
	return EnhancedValidator.validate(
		GlobalArgsSchema,
		data,
		"Global args validation",
	);
}

/**
 * Validate job judge args data
 */
export function validateJobJudgeArgs(data: unknown): JobJudgeArgsType {
	return EnhancedValidator.validate(
		JobJudgeArgsSchema,
		data,
		"Job judge args validation",
	);
}

/**
 * Validate job cloth args data
 */
export function validateJobClothArgs(data: unknown): JobClothArgsType {
	return EnhancedValidator.validate(
		JobClothArgsSchema,
		data,
		"Job cloth args validation",
	);
}

/**
 * Validate make materials args data
 */
export function validateMakeMaterialsArgs(
	data: unknown,
): MakeMaterialsArgsType {
	return EnhancedValidator.validate(
		MakeMaterialsArgsSchema,
		data,
		"Make materials args validation",
	);
}

/**
 * Validate er44zz mode args data
 */
export function validateEr44zzModeArgs(data: unknown): Er44zzModeArgsType {
	return EnhancedValidator.validate(
		Er44zzModeArgsSchema,
		data,
		"Er44zz mode args validation",
	);
}

/**
 * Validate scraping args data
 */
export function validateScrapingArgs(data: unknown): ScrapingArgsType {
	return EnhancedValidator.validate(
		ScrapingArgsSchema,
		data,
		"Scraping args validation",
	);
}

/**
 * Validate processing stats data
 */
export function validateProcessingStats(data: unknown): ProcessingStatsType {
	return EnhancedValidator.validate(
		ProcessingStatsSchema,
		data,
		"Processing stats validation",
	);
}

/**
 * Validate batch processing options data
 */
export function validateBatchProcessingOptions(
	data: unknown,
): BatchProcessingOptionsType {
	return EnhancedValidator.validate(
		BatchProcessingOptionsSchema,
		data,
		"Batch processing options validation",
	);
}

/**
 * Validate search options data
 */
export function validateSearchOptions(data: unknown): SearchOptionsType {
	return EnhancedValidator.validate(
		SearchOptionsSchema,
		data,
		"Search options validation",
	);
}

/**
 * Validate filter options data
 */
export function validateFilterOptions(data: unknown): FilterOptionsType {
	return EnhancedValidator.validate(
		FilterOptionsSchema,
		data,
		"Filter options validation",
	);
}

/**
 * Validate application config data
 */
export function validateAppConfig(data: unknown): AppConfigType {
	return EnhancedValidator.validate(
		AppConfigSchema,
		data,
		"App config validation",
	);
}

// ===== Legacy validation functions for backward compatibility =====

/**
 * Validate API key format (enhanced version)
 */
export function validateApiKey(
	apiKey: string,
	context: string = "API key validation",
): void {
	EnhancedValidator.validate(ApiKeySchema, apiKey, context);
}

/**
 * Validate URL format (enhanced version)
 */
export function validateUrl(
	url: string,
	context: string = "URL validation",
): void {
	EnhancedValidator.validate(UrlSchema, url, context);
}

/**
 * Validate file path format (enhanced version)
 */
export function validateFilePath(
	filePath: string,
	context: string = "File path validation",
): string {
	return EnhancedValidator.validate(FilePathSchema, filePath, context);
}

/**
 * Validate temperature value (enhanced version)
 */
export function validateTemperature(
	temperature: number,
	context: string = "Temperature validation",
): number {
	return EnhancedValidator.validate(TemperatureSchema, temperature, context);
}

/**
 * Validate topP value (enhanced version)
 */
export function validateTopP(
	topP: number,
	context: string = "Top-P validation",
): number {
	return EnhancedValidator.validate(TopPSchema, topP, context);
}

/**
 * Validate maxTokens value (enhanced version)
 */
export function validateMaxTokens(
	maxTokens: number,
	context: string = "Max tokens validation",
): number {
	return EnhancedValidator.validate(MaxTokensSchema, maxTokens, context);
}

/**
 * Validate timeout value (enhanced version)
 */
export function validateTimeout(
	timeout: number,
	context: string = "Timeout validation",
): number {
	return EnhancedValidator.validate(TimeoutSchema, timeout, context);
}

/**
 * Validate job ID format (enhanced version)
 */
export function validateJobId(
	jobId: string,
	context: string = "Job ID validation",
): string {
	return EnhancedValidator.validate(JobIdSchema, jobId, context);
}

/**
 * Validate company name format (enhanced version)
 */
export function validateCompanyName(
	companyName: string,
	context: string = "Company name validation",
): string {
	return EnhancedValidator.validate(CompanyNameSchema, companyName, context);
}

/**
 * Validate location format (enhanced version)
 */
export function validateLocation(
	location: string,
	context: string = "Location validation",
): string {
	return EnhancedValidator.validate(LocationSchema, location, context);
}

/**
 * Validate job title format (enhanced version)
 */
export function validateJobTitle(
	jobTitle: string,
	context: string = "Job title validation",
): string {
	return EnhancedValidator.validate(JobTitleSchema, jobTitle, context);
}

/**
 * Validate salary format (enhanced version)
 */
export function validateSalary(
	salary: string | undefined,
	context: string = "Salary validation",
): string | undefined {
	if (salary === undefined) return undefined;
	return EnhancedValidator.validate(SalarySchema, salary, context);
}

/**
 * Validate salary currency format (enhanced version)
 */
export function validateSalaryCurrency(
	salaryCurrency: string,
	context: string = "Salary currency validation",
): string {
	return EnhancedValidator.validate(
		SalaryCurrencySchema,
		salaryCurrency,
		context,
	);
}

/**
 * Validate job type format (enhanced version)
 */
export function validateJobType(
	jobType: string | undefined,
	context: string = "Job type validation",
): string | undefined {
	if (jobType === undefined) return undefined;
	return EnhancedValidator.validate(JobTypeSchema, jobType, context);
}

/**
 * Validate experience level format (enhanced version)
 */
export function validateExperienceLevel(
	experienceLevel: string | undefined,
	context: string = "Experience level validation",
): string | undefined {
	if (experienceLevel === undefined) return undefined;
	return EnhancedValidator.validate(
		ExperienceLevelSchema,
		experienceLevel,
		context,
	);
}

/**
 * Validate employment type format (enhanced version)
 */
export function validateEmploymentType(
	employmentType: string | undefined,
	context: string = "Employment type validation",
): string | undefined {
	if (employmentType === undefined) return undefined;
	return EnhancedValidator.validate(
		EmploymentTypeSchema,
		employmentType,
		context,
	);
}

/**
 * Validate seniority level format (enhanced version)
 */
export function validateSeniorityLevel(
	seniorityLevel: string | undefined,
	context: string = "Seniority level validation",
): string | undefined {
	if (seniorityLevel === undefined) return undefined;
	return EnhancedValidator.validate(
		SeniorityLevelSchema,
		seniorityLevel,
		context,
	);
}

/**
 * Validate job function format (enhanced version)
 */
export function validateJobFunction(
	jobFunction: string | undefined,
	context: string = "Job function validation",
): string | undefined {
	if (jobFunction === undefined) return undefined;
	return EnhancedValidator.validate(JobFunctionSchema, jobFunction, context);
}

/**
 * Validate industries format (enhanced version)
 */
export function validateIndustries(
	industries: string | undefined,
	context: string = "Industries validation",
): string | undefined {
	if (industries === undefined) return undefined;
	return EnhancedValidator.validate(IndustriesSchema, industries, context);
}

/**
 * Validate posted date format (enhanced version)
 */
export function validatePostedDate(
	postedDate: string | undefined,
	context: string = "Posted date validation",
): string | undefined {
	if (postedDate === undefined) return undefined;
	return EnhancedValidator.validate(PostedDateSchema, postedDate, context);
}

/**
 * Validate applicants format (enhanced version)
 */
export function validateApplicants(
	applicants: string | undefined,
	context: string = "Applicants validation",
): string | undefined {
	if (applicants === undefined) return undefined;
	return EnhancedValidator.validate(ApplicantsSchema, applicants, context);
}

/**
 * Validate salary range format (enhanced version)
 */
export function validateSalaryRange(
	salaryRange: string | undefined,
	context: string = "Salary range validation",
): string | undefined {
	if (salaryRange === undefined) return undefined;
	return EnhancedValidator.validate(SalaryRangeSchema, salaryRange, context);
}

/**
 * Validate posted time format (enhanced version)
 */
export function validatePostedTime(
	postedTime: string | undefined,
	context: string = "Posted time validation",
): string | undefined {
	if (postedTime === undefined) return undefined;
	return EnhancedValidator.validate(PostedTimeSchema, postedTime, context);
}

/**
 * Validate remote ok format (enhanced version)
 */
export function validateRemoteOk(
	remoteOk: boolean | undefined,
	context: string = "Remote OK validation",
): boolean | undefined {
	if (remoteOk === undefined) return undefined;
	return EnhancedValidator.validate(RemoteOkSchema, remoteOk, context);
}

/**
 * Validate metadata format (enhanced version)
 */
export function validateMetadata(
	metadata: unknown,
	context: string = "Metadata validation",
): unknown {
	return EnhancedValidator.validate(MetadataSchema, metadata, context);
}

/**
 * Validate estimated salary format (enhanced version)
 */
export function validateEstimatedSalary(
	estimatedSalary: unknown,
	context: string = "Estimated salary validation",
): unknown {
	return EnhancedValidator.validate(
		EstimatedSalarySchema,
		estimatedSalary,
		context,
	);
}

// ===== Export all schemas and types for easy access =====

// Schemas are exported individually above for better tree-shaking
// Types are inferred automatically from schemas using z.infer<>
