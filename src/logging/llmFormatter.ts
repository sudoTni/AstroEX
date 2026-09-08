/**
 * AstroEX Logging System - LLM Request, Response & Reasoning Formatter
 *
 * Produces structured, visually distinct, human-readable terminal blocks
 * for LLM requests, responses, tool calls, and reasoning tokens with intentional
 * HSV gradient framing and robust nested payload formatting.
 */

import { LOG_GRADIENTS, applyHsvFade, isColorSupported } from "./fader";
import { sanitizeContext, sanitizeString } from "./redaction";

export interface LLMRequestLogData {
	provider: string;
	model: string;
	requestId?: string;
	correlationId?: string;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	timeout?: number;
	reasoning_effort?: string;
	messages?: Array<{ role: string; content: string }>;
	responseSchema?: unknown;
	tools?: unknown[];
	toolChoice?: unknown;
	extra?: Record<string, unknown>;
}

export interface LLMResponseLogData {
	provider: string;
	model: string;
	requestId?: string;
	responseId?: string;
	duration?: number;
	finishReason?: string;
	content?: unknown;
	contentStreamed?: boolean;
	omitContent?: boolean;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		cachedTokens?: number;
		reasoningTokens?: number;
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		cached_tokens?: number;
		reasoning_tokens?: number;
	};
	toolCalls?: Array<{
		id?: string;
		name: string;
		arguments: unknown;
	}>;
	extra?: Record<string, unknown>;
}

export interface LLMReasoningLogData {
	provider?: string;
	model?: string;
	reasoningContent?: string;
	reasoningTokens?: number;
	reasoningSummary?: string;
	isStreaming?: boolean;
}

export interface ToolLogData {
	toolName: string;
	callId?: string;
	arguments?: unknown;
	result?: unknown;
	duration?: number;
	error?: unknown;
}

export interface FormatOptions {
	useColor?: boolean;
	maxPayloadLength?: number;
}

/**
 * Format an arbitrary value into clean, indented, and safe multiline string.
 * Protects against circular references and masks sensitive data.
 */
export function formatStructuredData(
	value: unknown,
	indent = 2,
	maxLen?: number,
	seen = new WeakSet<object>(),
): string {
	const limit =
		maxLen ??
		(process.env.ASTROEX_LOG_MAX_PAYLOAD_LENGTH
			? Number.parseInt(process.env.ASTROEX_LOG_MAX_PAYLOAD_LENGTH, 10)
			: undefined);

	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") {
		const sanitized = sanitizeString(value);
		if (limit && sanitized.length > limit) {
			return `"${sanitized.slice(0, limit)}... [truncated ${sanitized.length - limit} chars]"`;
		}
		return `"${sanitized}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (typeof value === "bigint") {
		return `${value.toString()}n`;
	}
	if (typeof value === "symbol") {
		return value.toString();
	}
	if (typeof value === "function") {
		return `[Function: ${value.name || "anonymous"}]`;
	}
	if (value instanceof Date) {
		return `[Date: ${value.toISOString()}]`;
	}
	if (value instanceof RegExp) {
		return value.toString();
	}
	if (value instanceof Error) {
		return `[${value.name}: ${sanitizeString(value.message)}]`;
	}

	if (typeof value === "object") {
		if (seen.has(value)) {
			return "[Circular]";
		}
		seen.add(value);

		const pad = " ".repeat(indent);
		const innerPad = " ".repeat(indent + 2);

		if (Array.isArray(value)) {
			if (value.length === 0) return "[]";
			const items = value
				.map(
					(item) =>
						`${innerPad}${formatStructuredData(item, indent + 2, limit, seen)},`,
				)
				.join("\n");
			return `[\n${items}\n${pad}]`;
		}

		// Plain object or map-like
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return "{}";

		const sanitizedEntries =
			sanitizeContext(value as Record<string, unknown>) ?? {};
		const lines = Object.entries(sanitizedEntries).map(([k, v]) => {
			const formattedVal = formatStructuredData(v, indent + 2, limit, seen);
			return `${innerPad}${k}: ${formattedVal},`;
		});

		return `{\n${lines.join("\n")}\n${pad}}`;
	}

	return String(value);
}

/**
 * Format a complete LLM request with structured border framing and request gradient.
 */
export function formatLLMRequest(
	data: LLMRequestLogData,
	options: FormatOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();

	const headerText = `╭─ LLM REQUEST [${data.provider}/${data.model}]${
		data.requestId ? ` (id: ${data.requestId})` : ""
	}`;
	const header = applyHsvFade(headerText, "request", {
		useColor,
		bold: true,
	});

	const border = (glyph: string) =>
		applyHsvFade(glyph, "request", { useColor });

	const lines: string[] = [header];

	// Parameters summary
	const params: string[] = [];
	if (data.temperature !== undefined)
		params.push(`temperature=${data.temperature}`);
	if (data.topP !== undefined) params.push(`topP=${data.topP}`);
	if (data.maxTokens !== undefined) params.push(`maxTokens=${data.maxTokens}`);
	if (data.timeout !== undefined) params.push(`timeout=${data.timeout}ms`);
	if (data.reasoning_effort !== undefined && data.reasoning_effort !== "")
		params.push(`reasoning_effort=${data.reasoning_effort}`);

	lines.push(`${border("│")} Parameters: ${params.join(", ") || "default"}`);

	if (data.responseSchema) {
		lines.push(`${border("│")} Response Schema: [Configured Object Schema]`);
	}

	// Messages section
	if (data.messages && data.messages.length > 0) {
		const msgDivider = applyHsvFade(
			`├─ Messages (${data.messages.length})`,
			"request",
			{ useColor, bold: true },
		);
		lines.push(msgDivider);

		for (const [idx, msg] of data.messages.entries()) {
			const roleLabel = applyHsvFade(`[${msg.role.toUpperCase()}]`, "request", {
				useColor,
				dim: true,
			});
			lines.push(`${border("│")} ${roleLabel} (Message #${idx + 1}):`);

			const contentLines = sanitizeString(msg.content).split("\n");
			for (const cLine of contentLines) {
				lines.push(`${border("│")}   ${cLine}`);
			}
		}
	}

	// Tools section if defined
	if (data.tools && data.tools.length > 0) {
		const toolDivider = applyHsvFade(
			`├─ Tools (${data.tools.length} available)`,
			"request",
			{ useColor, bold: true },
		);
		lines.push(toolDivider);
		const formattedTools = formatStructuredData(
			data.tools,
			2,
			options.maxPayloadLength,
		);
		for (const tLine of formattedTools.split("\n")) {
			lines.push(`${border("│")}   ${tLine}`);
		}
	}

	const footer = applyHsvFade("╰─", "request", { useColor });
	lines.push(footer);

	return lines.join("\n");
}

/**
 * Format a complete LLM response with structured border framing and response gradient.
 */
export function formatLLMResponse(
	data: LLMResponseLogData,
	options: FormatOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();

	const durStr =
		data.duration !== undefined ? `${Math.round(data.duration)}ms` : undefined;
	const totalTokens = data.usage?.totalTokens ?? data.usage?.total_tokens;
	const tokenStr =
		totalTokens !== undefined ? `${totalTokens} tokens` : undefined;
	const metaParts = [durStr, tokenStr].filter(Boolean).join(", ");

	const headerText = `╭─ LLM RESPONSE [${data.provider}/${data.model}]${
		metaParts ? ` (${metaParts})` : ""
	}`;
	const header = applyHsvFade(headerText, "response", {
		useColor,
		bold: true,
	});

	const border = (glyph: string) =>
		applyHsvFade(glyph, "response", { useColor });

	const lines: string[] = [header];

	if (data.responseId) {
		lines.push(`${border("│")} Response ID: ${data.responseId}`);
	}
	if (data.finishReason) {
		lines.push(`${border("│")} Finish Reason: ${data.finishReason}`);
	}

	// Usage breakdown
	if (data.usage) {
		const u = data.usage;
		const promptTokens = u.promptTokens ?? u.prompt_tokens;
		const completionTokens = u.completionTokens ?? u.completion_tokens;
		const total = u.totalTokens ?? u.total_tokens;
		const cached = u.cachedTokens ?? u.cached_tokens;
		const reasoning = u.reasoningTokens ?? u.reasoning_tokens;

		const usageParts = [
			promptTokens !== undefined ? `prompt=${promptTokens}` : undefined,
			completionTokens !== undefined
				? `completion=${completionTokens}`
				: undefined,
			total !== undefined ? `total=${total}` : undefined,
			cached !== undefined ? `cached=${cached}` : undefined,
			reasoning !== undefined ? `reasoning=${reasoning}` : undefined,
		].filter(Boolean);

		if (usageParts.length > 0) {
			lines.push(`${border("│")} Token Usage: ${usageParts.join(", ")}`);
		}
	}

	// Tool calls section if any
	if (data.toolCalls && data.toolCalls.length > 0) {
		const toolsDivider = applyHsvFade(
			`├─ Tool Calls (${data.toolCalls.length})`,
			"toolCall",
			{ useColor, bold: true },
		);
		lines.push(toolsDivider);
		for (const tc of data.toolCalls) {
			lines.push(
				`${border("│")}   Function: ${tc.name}${tc.id ? ` (callId: ${tc.id})` : ""}`,
			);
			const argsFormatted = formatStructuredData(
				tc.arguments,
				4,
				options.maxPayloadLength,
			);
			for (const aLine of argsFormatted.split("\n")) {
				lines.push(`${border("│")}     ${aLine}`);
			}
		}
	}

	// Content section
	if (data.omitContent || data.contentStreamed) {
		lines.push(`${border("│")} Content: [Streamed live above]`);
	} else {
		const contentDivider = applyHsvFade("├─ Content", "response", {
			useColor,
			bold: true,
		});
		lines.push(contentDivider);

		if (typeof data.content === "string") {
			const contentLines = sanitizeString(data.content).split("\n");
			for (const cLine of contentLines) {
				lines.push(`${border("│")}   ${cLine}`);
			}
		} else if (data.content !== undefined) {
			const formatted = formatStructuredData(
				data.content,
				2,
				options.maxPayloadLength,
			);
			for (const cLine of formatted.split("\n")) {
				lines.push(`${border("│")}   ${cLine}`);
			}
		}
	}

	const footer = applyHsvFade("╰─", "response", { useColor });
	lines.push(footer);

	return lines.join("\n");
}

/**
 * Format reasoning content or token diagnostics with the reasoning gradient.
 */
export function formatReasoningBlock(
	data: LLMReasoningLogData | string,
	options: FormatOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();
	const obj: LLMReasoningLogData =
		typeof data === "string" ? { reasoningContent: data } : data;

	const modelLabel = [obj.provider, obj.model].filter(Boolean).join("/");
	const headerText = `╭─ REASONING${modelLabel ? ` [${modelLabel}]` : ""}${
		obj.reasoningTokens !== undefined ? ` (${obj.reasoningTokens} tokens)` : ""
	}`;
	const header = applyHsvFade(headerText, "reasoning", {
		useColor,
		bold: true,
	});

	const border = (glyph: string) =>
		applyHsvFade(glyph, "reasoning", { useColor });

	const lines: string[] = [header];

	if (obj.reasoningSummary) {
		lines.push(
			`${border("│")} Summary: ${sanitizeString(obj.reasoningSummary)}`,
		);
	}

	if (obj.reasoningContent) {
		const contentLines = sanitizeString(obj.reasoningContent).split("\n");
		for (const cLine of contentLines) {
			lines.push(`${border("│")}   ${cLine}`);
		}
	} else if (obj.reasoningTokens !== undefined && !obj.reasoningSummary) {
		lines.push(
			`${border("│")}   (Provider reported ${obj.reasoningTokens} reasoning tokens consumed during inference)`,
		);
	}

	const footer = applyHsvFade("╰─", "reasoning", { useColor });
	lines.push(footer);

	return lines.join("\n");
}

/**
 * Format a tool execution call with toolCall gradient.
 */
export function formatToolCallBlock(
	data: ToolLogData,
	options: FormatOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();

	const headerText = `╭─ TOOL CALL [${data.toolName}]${
		data.callId ? ` (id: ${data.callId})` : ""
	}`;
	const header = applyHsvFade(headerText, "toolCall", {
		useColor,
		bold: true,
	});

	const border = (glyph: string) =>
		applyHsvFade(glyph, "toolCall", { useColor });

	const lines: string[] = [header];

	if (data.arguments !== undefined) {
		lines.push(`${border("│")} Arguments:`);
		const formatted = formatStructuredData(
			data.arguments,
			2,
			options.maxPayloadLength,
		);
		for (const aLine of formatted.split("\n")) {
			lines.push(`${border("│")}   ${aLine}`);
		}
	}

	const footer = applyHsvFade("╰─", "toolCall", { useColor });
	lines.push(footer);

	return lines.join("\n");
}

/**
 * Format a tool execution result with toolResult gradient.
 */
export function formatToolResultBlock(
	data: ToolLogData,
	options: FormatOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();

	const durStr =
		data.duration !== undefined ? ` (${Math.round(data.duration)}ms)` : "";
	const headerText = `╭─ TOOL RESULT [${data.toolName}]${durStr}`;
	const header = applyHsvFade(headerText, "toolResult", {
		useColor,
		bold: true,
	});

	const border = (glyph: string) =>
		applyHsvFade(glyph, "toolResult", { useColor });

	const lines: string[] = [header];

	if (data.error) {
		lines.push(`${border("│")} Status: ERROR`);
		lines.push(
			`${border("│")} Error: ${
				data.error instanceof Error ? data.error.message : String(data.error)
			}`,
		);
	} else {
		lines.push(`${border("│")} Status: SUCCESS`);
	}

	if (data.result !== undefined) {
		lines.push(`${border("│")} Result:`);
		const formatted = formatStructuredData(
			data.result,
			2,
			options.maxPayloadLength,
		);
		for (const rLine of formatted.split("\n")) {
			lines.push(`${border("│")}   ${rLine}`);
		}
	}

	const footer = applyHsvFade("╰─", "toolResult", { useColor });
	lines.push(footer);

	return lines.join("\n");
}
