import { z } from "zod";

export const OpenRouterCallUsageSchema = z.object({
	requestId: z.string().min(1).optional(),
	timestamp: z.string(),
	model: z.string().min(1).optional(),
	stage: z.string().min(1).optional(),
	inputTokens: z.number().int().safe().nonnegative(),
	outputTokens: z.number().int().safe().nonnegative(),
	totalTokens: z.number().int().safe().nonnegative(),
	costUsd: z.number().finite().nonnegative(),
});

export type OpenRouterCallUsage = z.infer<typeof OpenRouterCallUsageSchema>;

export interface OpenRouterUsageSummary {
	accountedCalls: number;
	unavailableUsageCalls: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export interface OpenRouterUsageRecordResult {
	recorded: boolean;
	callNumber: number;
	totals: OpenRouterUsageSummary;
}

export interface OpenRouterUsageMetadata {
	requestId?: string;
	timestamp?: string;
	model?: string;
	stage?: string;
}

/**
 * Convert OpenRouter's OpenAI-compatible wire usage into the internal billing
 * shape without coercing or estimating any values.
 */
export function parseOpenRouterUsage(
	rawUsage: unknown,
	metadata: OpenRouterUsageMetadata = {},
): OpenRouterCallUsage | undefined {
	if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
		return undefined;
	}

	const usage = rawUsage as Record<string, unknown>;
	const parsed = OpenRouterCallUsageSchema.safeParse({
		...(metadata.requestId ? { requestId: metadata.requestId } : {}),
		timestamp: metadata.timestamp ?? new Date().toISOString(),
		...(metadata.model ? { model: metadata.model } : {}),
		...(metadata.stage ? { stage: metadata.stage } : {}),
		inputTokens: usage.prompt_tokens,
		outputTokens: usage.completion_tokens,
		totalTokens: usage.total_tokens,
		costUsd: usage.cost,
	});

	return parsed.success ? parsed.data : undefined;
}

/** A compact display formatter; raw numeric values remain in log context. */
export function formatUsd(value: number): string {
	if (value === 0) return "$0";
	return `$${Number(value.toPrecision(8)).toString()}`;
}

/** Mutable usage state owned by exactly one pipeline execution. */
export class OpenRouterUsageTracker {
	private readonly accountingIds = new Set<string>();
	private accountedCalls = 0;
	private unavailableUsageCalls = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private totalTokens = 0;
	private costUsd = 0;

	record(
		accountingId: string,
		usage: OpenRouterCallUsage,
	): OpenRouterUsageRecordResult {
		if (this.accountingIds.has(accountingId)) {
			return {
				recorded: false,
				callNumber: this.accountedCalls,
				totals: this.getSummary(),
			};
		}

		const validatedUsage = OpenRouterCallUsageSchema.parse(usage);
		this.accountingIds.add(accountingId);
		this.accountedCalls++;
		this.inputTokens += validatedUsage.inputTokens;
		this.outputTokens += validatedUsage.outputTokens;
		this.totalTokens += validatedUsage.totalTokens;
		this.costUsd += validatedUsage.costUsd;

		return {
			recorded: true,
			callNumber: this.accountedCalls,
			totals: this.getSummary(),
		};
	}

	markUsageUnavailable(): OpenRouterUsageSummary {
		this.unavailableUsageCalls++;
		return this.getSummary();
	}

	getSummary(): OpenRouterUsageSummary {
		return {
			accountedCalls: this.accountedCalls,
			unavailableUsageCalls: this.unavailableUsageCalls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens: this.totalTokens,
			costUsd: this.costUsd,
		};
	}
}
