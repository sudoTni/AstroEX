/**
 * Enhanced Type Definitions for AstroEX
 * Version 2.8.1-Enhanced
 *
 * This module provides enhanced type safety with stricter typing,
 * better validation, and comprehensive type utilities.
 */

import { z } from "zod";

// ===== Provider Types =====
export type LLMProvider =
	| "openai"
	| "gemini"
	| "mistral"
	| "openrouter"
	| "cerebras"
	| "anthropic";

// ===== Strict Zod Schemas =====
export const EnhancedProviderSchema = z.enum([
	"openai",
	"gemini",
	"mistral",
	"openrouter",
	"cerebras",
	"anthropic",
]);
export type EnhancedProviderType = z.infer<typeof EnhancedProviderSchema>;

export const EnhancedTemperatureSchema = z.number().min(0).max(2).default(0.7);
export type EnhancedTemperatureType = z.infer<typeof EnhancedTemperatureSchema>;

export const EnhancedTopPSchema = z.number().min(0).max(1).default(0.9);
export type EnhancedTopPType = z.infer<typeof EnhancedTopPSchema>;

export const EnhancedMaxTokensSchema = z
	.number()
	.min(1)
	.max(32000)
	.default(16000);
export type EnhancedMaxTokensType = z.infer<typeof EnhancedMaxTokensSchema>;

export const EnhancedTimeoutSchema = z
	.number()
	.min(1000)
	.max(300000)
	.default(30000);
export type EnhancedTimeoutType = z.infer<typeof EnhancedTimeoutSchema>;

// ===== Job-Related Types =====
export const EnhancedJobIdSchema = z.string().min(1).max(100);
export type EnhancedJobIdType = z.infer<typeof EnhancedJobIdSchema>;

export const EnhancedJobTitleSchema = z.string().min(1).max(200);
export type EnhancedJobTitleType = z.infer<typeof EnhancedJobTitleSchema>;

export const EnhancedCompanyNameSchema = z.string().min(1).max(100);
export type EnhancedCompanyNameType = z.infer<typeof EnhancedCompanyNameSchema>;

export const EnhancedLocationSchema = z.string().min(1).max(200);
export type EnhancedLocationType = z.infer<typeof EnhancedLocationSchema>;

export const EnhancedJobUrlSchema = z
	.string()
	.url()
	.refine((url) => url.includes("linkedin.com"), {
		message: "URL must be a LinkedIn job URL",
	});
export type EnhancedJobUrlType = z.infer<typeof EnhancedJobUrlSchema>;

export const EnhancedSalaryCurrencySchema = z.enum([
	"USD",
	"EUR",
	"GBP",
	"RON",
	"CHF",
	"",
]);
export type EnhancedSalaryCurrencyType = z.infer<
	typeof EnhancedSalaryCurrencySchema
>;

// ===== Enhanced ScrapedJob Schema =====
export const ScrapedJobSchema = z.object({
	id: EnhancedJobIdSchema,
	title: EnhancedJobTitleSchema,
	company: EnhancedCompanyNameSchema,
	location: EnhancedLocationSchema,
	url: EnhancedJobUrlSchema,
	descriptionText: z.string().min(1),
	descriptionHtml: z.string().min(1),
	postedDate: z.string().min(1),
	salary: z.string().optional(),
	salaryCurrency: EnhancedSalaryCurrencySchema.optional(),
	jobType: z.string().optional(),
	experienceLevel: z.string().optional(),
	estimatedSalary: z
		.object({
			min: z.number().min(0),
			max: z.number().min(0),
			currency: EnhancedSalaryCurrencySchema,
		})
		.optional(),
	metadata: z
		.object({
			source: z.string(),
			scrapedAt: z.string(),
			confidence: z.number().min(0).max(1),
		})
		.optional(),
	applicants: z.string().optional(),
	seniorityLevel: z.string().optional(),
	employmentType: z.string().optional(),
	jobFunction: z.string().optional(),
	industries: z.string().optional(),
	salaryRange: z.string().optional(),
	postedTime: z.string().optional(),
});

export type ScrapedJobType = z.infer<typeof ScrapedJobSchema>;

// ===== Enhanced JobInterface Schema =====
export const JobInterfaceSchema = ScrapedJobSchema.extend({
	confidence: z.number().min(0).max(1).optional(),
	isVeryHighlyAligned: z.boolean().optional(),
	rationale: z.string().optional(),
});

export type JobInterfaceType = z.infer<typeof JobInterfaceSchema>;

// ===== Enhanced LLMRequest Schema =====
export const LLMMessageSchema = z.object({
	role: z.enum(["system", "user", "assistant"]),
	content: z.string().min(1),
});

export type LLMMessageType = z.infer<typeof LLMMessageSchema>;

export const EnhancedLLMRequestSchema = z.object({
	provider: EnhancedProviderSchema,
	model: z.string().min(1),
	messages: z.array(LLMMessageSchema).min(1),
	temperature: EnhancedTemperatureSchema.optional(),
	topP: EnhancedTopPSchema.optional(),
	maxTokens: EnhancedMaxTokensSchema.optional(),
	timeout: EnhancedTimeoutSchema.optional(),
	responseSchema: z.any().optional(),
});

export type EnhancedLLMRequestType = z.infer<typeof EnhancedLLMRequestSchema>;

// ===== Enhanced AIProviderConfig Schema =====
export const EnhancedAIProviderConfigSchema = z.object({
	name: z.string().min(1),
	baseUrl: z.string().url(),
	apiKey: z.string().min(10).max(100),
	model: z.string().min(1),
	temperature: EnhancedTemperatureSchema.optional(),
	topP: EnhancedTopPSchema.optional(),
	maxTokens: EnhancedMaxTokensSchema.optional(),
	timeout: EnhancedTimeoutSchema.optional(),
});

export type EnhancedAIProviderConfigType = z.infer<
	typeof EnhancedAIProviderConfigSchema
>;

// ===== Enhanced Preset Schema =====
export const EnhancedPresetSchema = z.object({
	name: z.string().min(1),
	provider: EnhancedProviderSchema,
	base_url: z.string().url(),
	modelId: z.string().min(1),
	promptTemplate: z.string().min(1),
	temperature: EnhancedTemperatureSchema,
	topP: EnhancedTopPSchema,
	maxTokens: EnhancedMaxTokensSchema.optional(),
	description: z.string().optional(),
});

export type EnhancedPresetType = z.infer<typeof EnhancedPresetSchema>;

// ===== Enhanced PresetConfig Schema =====
export const EnhancedPresetConfigSchema = z.object({
	jobCloth: z.record(EnhancedPresetSchema),
	jobJudge: z.record(EnhancedPresetSchema),
	makeMaterials: z.record(EnhancedPresetSchema),
});

export type EnhancedPresetConfigType = z.infer<
	typeof EnhancedPresetConfigSchema
>;

// ===== Performance Metrics Schema =====
export const EnhancedPerformanceMetricsSchema = z.object({
	startTime: z.number(),
	endTime: z.number(),
	duration: z.number(),
	apiCalls: z.number().min(0),
	successfulCalls: z.number().min(0),
	failedCalls: z.number().min(0),
	totalTokensUsed: z.number().min(0),
	memoryUsage: z.object({
		rss: z.number().min(0),
		heapTotal: z.number().min(0),
		heapUsed: z.number().min(0),
		external: z.number().min(0),
	}),
});

export type EnhancedPerformanceMetricsType = z.infer<
	typeof EnhancedPerformanceMetricsSchema
>;

// ===== Utility Types =====
export type DeepPartial<T> = {
	[P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type OptionalFields<T, K extends keyof T> = Omit<T, K> &
	Partial<Pick<T, K>>;

export type ReadonlyDeep<T> = {
	readonly [P in keyof T]: T[P] extends object ? ReadonlyDeep<T[P]> : T[P];
};

// ===== API Response Types =====
export type APIResponse<T> = {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
	metadata?: {
		timestamp: string;
		requestId: string;
		duration: number;
	};
};

export type PaginatedResponse<T> = APIResponse<T[]> & {
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
};

// ===== Error Types =====
export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export type ErrorContext = {
	component: string;
	action: string;
	timestamp: string;
	requestId?: string;
	userAgent?: string;
	ipAddress?: string;
};

export type AppError = {
	type: string;
	code: string;
	message: string;
	severity: ErrorSeverity;
	context: ErrorContext;
	stack?: string;
	originalError?: unknown;
};

// ===== Validation Utilities =====
export class ValidationError extends Error {
	constructor(
		public readonly field: string,
		public readonly value: unknown,
		public readonly message: string,
	) {
		super(message);
		this.name = "ValidationError";
	}
}

export const TypeValidator = {
	validate<T>(schema: z.ZodType<T>, data: unknown): T {
		const result = schema.safeParse(data);
		if (!result.success) {
			const errors = result.error.errors.map((err) => ({
				field: err.path.join("."),
				message: err.message,
			}));
			throw new ValidationError(
				"validation",
				data,
				`Validation failed: ${JSON.stringify(errors)}`,
			);
		}
		return result.data;
	},

	validatePartial<T>(schema: z.ZodType<T>, data: unknown): Partial<T> {
		const result = schema.safeParse(data);
		if (!result.success) {
			const errors = result.error.errors.map((err) => ({
				field: err.path.join("."),
				message: err.message,
			}));
			throw new ValidationError(
				"partial_validation",
				data,
				`Partial validation failed: ${JSON.stringify(errors)}`,
			);
		}
		return result.data as Partial<T>;
	},
};

// ===== Type Guards =====
export function isScrapedJob(data: unknown): data is ScrapedJobType {
	try {
		TypeValidator.validate(ScrapedJobSchema, data);
		return true;
	} catch {
		return false;
	}
}

export function isJobInterface(data: unknown): data is JobInterfaceType {
	try {
		TypeValidator.validate(JobInterfaceSchema, data);
		return true;
	} catch {
		return false;
	}
}

export function isLLMRequest(data: unknown): data is EnhancedLLMRequestType {
	try {
		TypeValidator.validate(EnhancedLLMRequestSchema, data);
		return true;
	} catch {
		return false;
	}
}

export function isAIProviderConfig(
	data: unknown,
): data is EnhancedAIProviderConfigType {
	try {
		TypeValidator.validate(EnhancedAIProviderConfigSchema, data);
		return true;
	} catch {
		return false;
	}
}

// ===== Enum Types =====
export const LogLevel = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
} as const;

export type LogLevelType = (typeof LogLevel)[keyof typeof LogLevel];

export const JobType = {
	FULL_TIME: "full-time",
	PART_TIME: "part-time",
	CONTRACT: "contract",
	INTERN: "internship",
} as const;

export type JobTypeType = (typeof JobType)[keyof typeof JobType];

export const ExperienceLevel = {
	INTERN: "internship",
	ENTRY: "entry",
	ASSOCIATE: "associate",
	MID_SENIOR: "mid-senior level",
	DIRECTOR: "director",
	EXECUTIVE: "executive",
} as const;

export type ExperienceLevelType =
	(typeof ExperienceLevel)[keyof typeof ExperienceLevel];

// ===== Date/Time Types =====
export type ISODateString = string & { __brand: "ISODateString" };
export type UnixTimestamp = number & { __brand: "UnixTimestamp" };

export function isISODateString(value: string): value is ISODateString {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
		value,
	);
}

export function toISODateString(date: Date): ISODateString {
	return date.toISOString() as ISODateString;
}

// ===== Utility Functions =====
export function createId<T extends string>(
	prefix: T,
	suffix?: string,
): `${T}_${string}` {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${prefix}_${suffix ? `${suffix}_` : ""}${timestamp}_${random}`;
}

export function sanitizeString(
	input: string,
	maxLength: number = 1000,
): string {
	// This regex identifies control characters from \x00-\x1F and the DEL character \x7F.
	// We use the RegExp constructor to avoid the "noControlCharactersInRegex" linting error.
	// Using string.match() with a string pattern instead of regex literal to avoid control characters
	const controlChars =
		"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F\x7F";
	const controlCharRegex = new RegExp(`[${controlChars}]`, "g");

	return input
		.replace(/[<>]/g, "")
		.replace(controlCharRegex, "")
		.substring(0, maxLength);
}

export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

export function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

export function debounce<T extends (...args: unknown[]) => unknown>(
	func: T,
	wait: number,
): (...args: Parameters<T>) => void {
	let timeout: NodeJS.Timeout;
	return (...args: Parameters<T>) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => func(...args), wait);
	};
}

export function throttle<T extends (...args: unknown[]) => unknown>(
	func: T,
	limit: number,
): (...args: Parameters<T>) => void {
	let inThrottle = false;
	return (...args: Parameters<T>) => {
		if (!inThrottle) {
			func(...args);
			inThrottle = true;
			setTimeout(() => {
				inThrottle = false;
			}, limit);
		}
	};
}

// ===== Event Types =====
export type EventHandler<T = void> = (data: T) => void;

export type EventMap = {
	[key: string]: unknown;
};

export type TypedEventEmitter<T extends EventMap> = {
	on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void;
	off<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void;
	emit<K extends keyof T>(event: K, data: T[K]): boolean;
	once<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void;
};

// ===== Configuration Types =====
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
