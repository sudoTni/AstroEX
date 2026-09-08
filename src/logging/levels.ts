/**
 * AstroEX Logging System - Log Levels & Severity
 */

import type { LegacyLogLevel, LogLevel } from "./types";

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
	trace: 5,
	debug: 10,
	info: 20,
	success: 25,
	warn: 30,
	error: 40,
	fatal: 50,
};

const VALID_LEVELS = new Set<string>([
	"trace",
	"debug",
	"info",
	"success",
	"warn",
	"error",
	"fatal",
]);

export function normalizeLogLevel(level: LegacyLogLevel | string): LogLevel {
	const lower = String(level).trim().toLowerCase();
	if (lower === "log") return "debug";
	if (VALID_LEVELS.has(lower)) {
		return lower as LogLevel;
	}
	return "info";
}

export function isLogLevelEnabled(
	candidate: LogLevel,
	threshold: LogLevel,
): boolean {
	const candidateSeverity =
		LOG_LEVEL_SEVERITY[candidate] ?? LOG_LEVEL_SEVERITY.info;
	const thresholdSeverity =
		LOG_LEVEL_SEVERITY[threshold] ?? LOG_LEVEL_SEVERITY.info;
	return candidateSeverity >= thresholdSeverity;
}
