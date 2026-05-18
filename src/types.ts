/**
 * AstroEX Type Definitions
 * Version 3.2.0
 *
 * This module defines all TypeScript interfaces and types used throughout the application.
 * These types ensure type safety and consistent data structures across all modules.
 *
 * @author tjenkel
 * @license MIT
 */

export interface GlobalArgs {
	logDir?: string;
	logFile?: string;
	disableFileLogging?: boolean;
	verbose?: boolean;
}

export interface JobClothArgs extends GlobalArgs {
	"api-key": string;
	"base-url": string;
	"model-id": string;
	temperature?: number;
	top_p?: number;
	"input-file": string;
	"output-file": string;
	batch?: number;
	retries?: number;
	"max-tokens"?: number;
	"ping-interval"?: number;
	"openai-timeout"?: number;
	"log-payload"?: boolean;
	preset?: string;
	provider?: string;
}

export interface JobJudgeArgs extends GlobalArgs {
	"api-key": string;
	"base-url": string;
	"model-id": string;
	temperature?: number;
	top_p?: number;
	"input-file": string;
	"output-file": string;
	batch?: number;
	retries?: number;
	"max-tokens"?: number;
	"ping-interval"?: number;
	"openai-timeout"?: number;
	"log-payload"?: boolean;
	preset?: string;
	provider?: string;
	sleep?: number;
	"strict-parsing"?: boolean;
	"use-jobdb"?: boolean;
}

export interface ProcessDataArgs extends GlobalArgs {
	"input-dir": string;
	"output-file": string;
	"company-filters": string;
	"title-filters": string;
}

export interface MakeMaterialsArgs extends GlobalArgs {
	"api-key": string;
	"base-url": string;
	"model-id": string;
	temperature?: number;
	top_p?: number;
	"input-file": string;
	"output-file": string;
	"cover-letter-length"?: number;
	"log-payload"?: boolean;
	preset?: string;
	provider?: string;
	model?: string;
}

export interface Er44zzModeArgs extends GlobalArgs {
	mode: 1 | 2 | 3 | 4;
	provider: string;
	model: string;
	"use-sys-prompt"?: boolean;
	"test-mode": 0 | 1 | 2;
	thoughts?: boolean;
	"model-id"?: string;
	"api-key"?: string;
	"base-url"?: string;
	temperature?: number;
	top_p?: number;
	"max-tokens"?: number;
}

export interface ScrapingArgs extends GlobalArgs {
	headless?: boolean;
	url?: string;
	"output-file"?: string;
	sleep?: number;
}

export interface PerformanceMetrics {
	startTime: number;
	endTime: number;
	duration: number;
	apiCalls: number;
	successfulCalls: number;
	failedCalls: number;
	totalTokensUsed: number;
	memoryUsage: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
	};
}

export interface LLMRequest {
	provider: "openai" | "gemini" | "mistral" | "openrouter" | "cerebras";
	model: string;
	messages: {
		role: "system" | "user" | "assistant";
		content: string;
	}[];
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	timeout?: number;
	responseSchema?: unknown; // Optional Zod schema for response validation
}

export interface LLMResponse {
	content: string | unknown;
	provider: string;
	model: string;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	duration: number;
	timestamp: string;
}

export interface JobAnalysisResult {
	jobTitle: string;
	isVeryHighlyAligned: boolean;
	rationale: string;
	confidence: number;
}

export interface AIProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	timeout?: number;
}

export interface ScrapedJob {
	id: string;
	title: string;
	company: string;
	location: string;
	descriptionText: string;
	descriptionHtml: string;
	url: string;
	postedDate: string;
	salary?: string;
	salaryCurrency?: string;
	jobType?: string;
	experienceLevel?: string;
	estimatedSalary?: {
		min: number;
		max: number;
		currency: string;
	};
	metadata?: {
		source: string;
		scrapedAt: string;
		confidence: number;
	};
}

export interface JobInterface extends ScrapedJob {
	confidence?: number;
	isVeryHighlyAligned?: boolean;
	rationale?: string;
}

export interface ApplicationConfig {
	searchTerms: string[];
	companyFilters: string[];
	titleFilters: string[];
	aiProviders: AIProviderConfig[];
	defaultPresets: Record<string, string>;
	performanceMonitoring: {
		enabled: boolean;
		reportInterval: number;
		logLevel: "debug" | "info" | "warn" | "error";
	};
	security: {
		enableInputValidation: boolean;
		enableOutputSanitization: boolean;
		enableRateLimiting: boolean;
		maxRequestsPerMinute: number;
	};
}

export interface TemplateVariables {
	jep_vars?: Record<string, unknown>;
	rop_vars?: Record<string, unknown>;
	[key: string]: unknown; // Allow for additional custom variable groups
}

// Default template variables
export const defaultTemplateVariables: TemplateVariables = {
	jep_vars: {
		targJD: "",
		myResume: "",
		myTestimonials: "",
	},
	rop_vars: {
		myProfessionalTitle: "",
		myProfessionalSummary: "",
		myKeySkills: "",
		targJD: "",
		myResume: "",
		myTestimonials: "",
		cover_length: 275,
	},
};

export interface Preset {
	name: string;
	provider: string;
	base_url: string;
	modelId: string;
	promptTemplate: string;
	temperature: number;
	topP: number;
	maxTokens?: number;
	description?: string;
}

export interface PresetConfig {
	jobCloth: { [presetName: string]: Preset };
	jobJudge: { [presetName: string]: Preset };
	makeMaterials: { [presetName: string]: Preset };
}

// Helper functions for preset management (exported for use across modules)
export function getPreset(
	command: string,
	presetName: string,
	allPresets: PresetConfig,
): Preset | undefined {
	return allPresets[command as keyof PresetConfig]?.[presetName];
}

export function getAvailablePresets(
	command: string,
	allPresets: PresetConfig,
): string[] {
	return Object.keys(allPresets[command as keyof PresetConfig] || {});
}

export function getCommandsWithPresets(): string[] {
	return ["jobCloth", "jobJudge", "makeMaterials"];
}

export function commandHasPresets(command: string): boolean {
	return getCommandsWithPresets().includes(command);
}

export interface ProcessingStats {
	filesProcessed: number;
	recordsMerged: number;
	duplicatesRemoved: number;
	filteredEntries: number;
	finalRecords: number;
	processingTime: number;
}

export interface BatchProcessingOptions {
	batchSize: number;
	maxRetries: number;
	retryDelay: number;
	timeout: number;
	parallelProcessing: boolean;
	maxConcurrentBatches: number;
}

export interface SearchOptions {
	query: string;
	location?: string;
	distance?: number;
	datePosted?: "any" | "today" | "week" | "month";
	jobType?: "full-time" | "part-time" | "contract" | "internship";
	experienceLevel?:
		| "internship"
		| "entry"
		| "associate"
		| "mid-senior level"
		| "director"
		| "executive";
	sortBy?: "relevance" | "date" | "salary";
	sortOrder?: "ascending" | "descending";
}

export interface FilterOptions {
	companies?: string[];
	titles?: string[];
	locations?: string[];
	excludeCompanies?: string[];
	excludeTitles?: string[];
	minSalary?: number;
	maxSalary?: number;
	keywords?: string[];
	excludeKeywords?: string[];
}
