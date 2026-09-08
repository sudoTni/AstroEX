/**
 * AstroEX Logging System - Type Definitions
 *
 * Defines core types, interfaces, and log levels for structured observability.
 */

export type LogLevel =
	| "trace"
	| "debug"
	| "info"
	| "success"
	| "warn"
	| "error"
	| "fatal";

export type LegacyLogLevel = LogLevel | "log";

export type LogFormat = "pretty" | "json";

export interface LogContext {
	correlationId?: string;
	sessionId?: string;
	requestId?: string;
	jobId?: string;
	durationMs?: number;
	[key: string]: unknown;
}

export interface LogRecord {
	timestamp: string;
	level: LogLevel;
	component: string;
	message: string;
	context?: Record<string, unknown>;
	durationMs?: number;
}

export interface LogOutputOptions {
	console?: boolean;
	file?: boolean;
}

export interface LogTimer {
	readonly operation: string;
	readonly startTime: number;
	elapsedMs(): number;
	done(
		message?: string,
		level?: LogLevel,
		additionalContext?: LogContext,
	): number;
}

export interface Logger {
	readonly component: string;
	trace(message: string, context?: LogContext): void;
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	success(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, errorOrContext?: unknown, context?: LogContext): void;
	fatal(message: string, errorOrContext?: unknown, context?: LogContext): void;

	infoOnce(key: string, message: string, context?: LogContext): void;
	debugOnce(key: string, message: string, context?: LogContext): void;

	startTimer(operation?: string): LogTimer;
	time<T>(
		operation: string,
		fn: () => Promise<T>,
		context?: LogContext,
	): Promise<T>;
	timeSync<T>(operation: string, fn: () => T, context?: LogContext): T;

	child(subComponent: string, defaultContext?: LogContext): Logger;
	isLevelEnabled(level: LogLevel): boolean;
}

export interface LoggingConfig {
	minLevel: LogLevel;
	format: LogFormat;
	enableConsole: boolean;
	enableFile: boolean;
	useColor: boolean;
	logDirectory?: string;
	logFile?: string;
}
