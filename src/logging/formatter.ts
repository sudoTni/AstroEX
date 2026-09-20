/**
 * AstroEX Logging System - Formatters
 *
 * Formats structured LogRecords for terminal display or machine-readable JSONL.
 */

import { LOG_GRADIENTS, type LogGradientKey, applyHsvFade } from "./fader";
import type { LogLevel, LogRecord } from "./types";

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(milliseconds: number): string {
	if (!milliseconds || milliseconds <= 0) {
		return "";
	}
	if (milliseconds < 1000) {
		return `${Math.round(milliseconds)}ms`;
	}

	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	const parts: string[] = [];
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (remainingSeconds > 0 || minutes === 0) {
		parts.push(`${remainingSeconds}s`);
	}

	return parts.join(" ");
}

/**
 * Format Date to standard YYYY-MM-DD HH:mm:ss format.
 */
export function formatTimestamp(date: Date = new Date()): string {
	const year = date.getFullYear();
	const month = `0${date.getMonth() + 1}`.slice(-2);
	const day = `0${date.getDate()}`.slice(-2);
	const hours = `0${date.getHours()}`.slice(-2);
	const minutes = `0${date.getMinutes()}`.slice(-2);
	const seconds = `0${date.getSeconds()}`.slice(-2);
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
	trace: "TRACE",
	debug: "DEBUG",
	info: "INFO ",
	success: "OK   ",
	warn: "WARN ",
	error: "ERROR",
	fatal: "FATAL",
};

/**
 * Colorize level badge for terminal output.
 */
function colorizeLevel(
	level: LogLevel,
	label: string,
	useColor: boolean,
): string {
	if (!useColor) return `[${label}]`;

	const badge = `[${label}]`;
	const gradientKey = level as LogGradientKey;
	if (LOG_GRADIENTS[gradientKey]) {
		return applyHsvFade(badge, gradientKey, { useColor, bold: true });
	}

	return badge;
}

function fade(
	text: string,
	gradient: LogGradientKey,
	useColor: boolean,
	options: { bold?: boolean; dim?: boolean } = {},
): string {
	return applyHsvFade(text, gradient, {
		useColor,
		mode: "per-line",
		...options,
	});
}

function isSectionBoundary(message: string): boolean {
	const trimmed = message.trim();
	return (
		/^={3,}.*={3,}$/.test(trimmed) ||
		/^(?:stage \d+(?:\.\d+)?\/\d+:|phase \d+:)/i.test(trimmed)
	);
}

function contextGradient(key: string, value: unknown): LogGradientKey {
	const normalizedKey = key.toLowerCase();
	if (
		/(?:path|file|dir|directory|destination|url|uri)$/.test(normalizedKey) ||
		(typeof value === "string" &&
			(/^(?:[a-z]+:\/\/|[~/]|[a-z]:[\\/])/i.test(value) ||
				value.includes("/") ||
				/\.(?:json|jsonl|sqlite|log|txt|md)$/i.test(value)))
	) {
		return "path";
	}
	if (
		/(?:id$)|(?:^|_)(?:preset|model|provider|source|stage|session|correlation)/.test(
			normalizedKey,
		)
	) {
		return "identifier";
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return "metric";
	}
	return "value";
}

function formatContextValue(
	key: string,
	value: unknown,
	useColor: boolean,
): string {
	const rendered =
		typeof value === "string" && value.includes(" ")
			? `"${value}"`
			: String(value);
	return fade(rendered, contextGradient(key, value), useColor);
}

/**
 * Format context for human terminal view.
 */
function formatTerminalContext(
	context: Record<string, unknown> | undefined,
	useColor: boolean,
): { inline: string; multiline: string } {
	if (!context || Object.keys(context).length === 0) {
		return { inline: "", multiline: "" };
	}

	const inlineParts: string[] = [];
	const multilineLines: string[] = [];
	const remaining: Record<string, unknown> = {};

	for (const [k, v] of Object.entries(context)) {
		if (k === "durationMs" && typeof v === "number") {
			const durStr = formatDuration(v) || `${Math.round(v)}ms`;
			inlineParts.push(fade(`(${durStr})`, "duration", useColor));
		} else if (k === "error" && typeof v === "object" && v !== null) {
			const errObj = v as { name?: string; message?: string; stack?: string };
			const errMsg = errObj.message || String(v);
			const errName = errObj.name || "Error";
			multilineLines.push(fade(`  ↳ ${errName}: ${errMsg}`, "error", useColor));
			if (errObj.stack && typeof errObj.stack === "string") {
				const stackLines = errObj.stack
					.split("\n")
					.slice(1, 5) // Up to 4 stack frames
					.map((line) =>
						fade(`    ${line.trim()}`, "diagnostic", useColor, { dim: true }),
					);
				multilineLines.push(...stackLines);
			}
		} else if (
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean"
		) {
			const keyStyled = fade(`${k}=`, "diagnostic", useColor, { dim: true });
			const valStyled = formatContextValue(k, v, useColor);
			inlineParts.push(`${keyStyled}${valStyled}`);
		} else {
			remaining[k] = v;
		}
	}

	if (Object.keys(remaining).length > 0) {
		try {
			const serialized = JSON.stringify(remaining);
			inlineParts.push(fade(serialized, "diagnostic", useColor, { dim: true }));
		} catch {
			inlineParts.push("[complex-context]");
		}
	}

	const inline = inlineParts.length > 0 ? ` ${inlineParts.join(" ")}` : "";
	const multiline =
		multilineLines.length > 0 ? `\n${multilineLines.join("\n")}` : "";

	return { inline, multiline };
}

/**
 * Format a LogRecord for terminal output (development / interactive).
 */
export function formatTerminal(record: LogRecord, useColor: boolean): string {
	const timestampStr = formatTimestamp(new Date(record.timestamp));
	const timestamp = fade(timestampStr, "diagnostic", useColor, { dim: true });

	const label = LEVEL_LABELS[record.level] || record.level.toUpperCase();
	const levelBadge = colorizeLevel(record.level, label, useColor);

	const componentBadge = fade(`[${record.component}]`, "component", useColor, {
		bold: true,
	});

	let message = record.message;
	if (useColor) {
		if (record.level === "error" || record.level === "fatal")
			message = fade(message, record.level, useColor);
		else if (record.level === "warn" || record.level === "success")
			message = fade(message, record.level, useColor);
		else if (record.level === "debug" || record.level === "trace")
			message = fade(message, "diagnostic", useColor, { dim: true });
		else if (isSectionBoundary(message))
			message = fade(message, "section", useColor, { bold: true });
	}

	const { inline, multiline } = formatTerminalContext(record.context, useColor);

	return `${timestamp} ${componentBadge} ${levelBadge} ${message}${inline}${multiline}`;
}

/**
 * Format a LogRecord as structured JSON string (production / file logging).
 */
export function formatJson(record: LogRecord): string {
	const out: Record<string, unknown> = {
		timestamp: record.timestamp,
		level: record.level,
		component: record.component,
		message: record.message,
	};
	if (record.context && Object.keys(record.context).length > 0) {
		out.context = record.context;
	}
	return JSON.stringify(out);
}
