/**
 * Enhanced logging utilities for consistent logging across AstroEX
 *
 * This module provides structured logging with correlation IDs, log levels,
 * and consistent formatting across the application.
 */

import { formatDate, formatDuration, log } from "../utils";

// Log levels with numeric values for comparison
export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

// Log context interface for structured logging
export interface LogContext {
	correlationId?: string;
	userId?: string;
	sessionId?: string;
	requestId?: string;
	[key: string]: unknown;
}

// Log entry interface for structured logging
export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	context: LogContext;
	module: string;
	duration?: number;
}

// Logging configuration
export interface LoggingConfig {
	level: LogLevel;
	enableConsole: boolean;
	enableFile: boolean;
	enableStructured: boolean;
	correlationIdGenerator?: () => string;
}

// Default logging configuration
const DEFAULT_CONFIG: LoggingConfig = {
	level: LogLevel.INFO,
	enableConsole: true,
	enableFile: true,
	enableStructured: true,
	correlationIdGenerator: () =>
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15),
};

// Global logging configuration
let globalConfig: LoggingConfig = { ...DEFAULT_CONFIG };

// Thread-local storage for correlation IDs (in a real implementation, would use actual thread-local storage)
const correlationContext = new Map<string, LogContext>();

/**
 * Set global logging configuration
 */
export function configureLogging(config: Partial<LoggingConfig>): void {
	globalConfig = { ...globalConfig, ...config };
}

/**
 * Get current correlation context
 */
export function getCurrentContext(): LogContext {
	const correlationId = globalConfig.correlationIdGenerator?.() || "default";
	return correlationContext.get(correlationId) || {};
}

/**
 * Set correlation context for the current operation
 */
export function setContext(context: Partial<LogContext>): void {
	const correlationId =
		context.correlationId ||
		globalConfig.correlationIdGenerator?.() ||
		"default";
	correlationContext.set(correlationId, { ...getCurrentContext(), ...context });
}

/**
 * Clear correlation context
 */
export function clearContext(): void {
	correlationContext.clear();
}

/**
 * Format log entry for structured logging
 */
function formatStructuredEntry(entry: LogEntry): string {
	return JSON.stringify({
		timestamp: entry.timestamp,
		level: LogLevel[entry.level],
		message: entry.message,
		module: entry.module,
		duration: entry.duration,
		context: entry.context,
	});
}

/**
 * Internal logging function with enhanced features
 */
function enhancedLog(
	module: string,
	message: string,
	level: LogLevel,
	context: LogContext = {},
	duration?: number,
): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		context: { ...getCurrentContext(), ...context },
		module,
		duration,
	};

	// Check if log level is enabled
	if (level < globalConfig.level) {
		return;
	}

	// Format the message for console output
	const levelName = LogLevel[level].toUpperCase();
	const timestamp = formatDate(new Date(), "yyyy-MM-dd HH:mm:ss");
	const contextStr =
		Object.keys(entry.context).length > 0
			? ` ${JSON.stringify(entry.context)}`
			: "";

	const formattedMessage = `[${timestamp}] [${module}] [${levelName}]${contextStr} ${message}${duration ? ` (${formatDuration(duration)})` : ""}`;

	// Console logging
	if (globalConfig.enableConsole) {
		switch (level) {
			case LogLevel.ERROR:
				console.error(formattedMessage);
				break;
			case LogLevel.WARN:
				console.warn(formattedMessage);
				break;
			case LogLevel.INFO:
				console.info(formattedMessage);
				break;
			case LogLevel.DEBUG:
				console.debug(formattedMessage);
				break;
			default:
				console.log(formattedMessage);
		}
	}

	// File logging (using existing log function)
	if (globalConfig.enableFile) {
		log(
			module,
			`${message}${contextStr}`,
			LogLevel[level].toLowerCase() as "log" | "error" | "warn" | "info",
			{
				...entry.context,
				duration,
			},
		);
	}

	// Structured logging (could be sent to external logging service)
	if (globalConfig.enableStructured) {
		// In a real implementation, this could send to ELK, Splunk, etc.
		console.log(formatStructuredEntry(entry));
	}
}

/**
 * Debug logging
 */
export function debugLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	enhancedLog(module, message, LogLevel.DEBUG, context, duration);
}

/**
 * Info logging
 */
export function infoLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	enhancedLog(module, message, LogLevel.INFO, context, duration);
}

/**
 * Warning logging
 */
export function warnLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	enhancedLog(module, message, LogLevel.WARN, context, duration);
}

/**
 * Error logging
 */
export function errorLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	enhancedLog(module, message, LogLevel.ERROR, context, duration);
}

/**
 * Performance logging for timing operations
 */
export function performanceLog(
	module: string,
	operation: string,
	startTime: number,
	context?: LogContext,
): void {
	const duration = performance.now() - startTime;
	infoLog(module, `Performance: ${operation}`, context, duration);
}

/**
 * Create a logger for a specific module
 */
export function createLogger(module: string): Logger {
	return {
		debug: (message: string, context?: LogContext, duration?: number) =>
			debugLog(module, message, context, duration),
		info: (message: string, context?: LogContext, duration?: number) =>
			infoLog(module, message, context, duration),
		warn: (message: string, context?: LogContext, duration?: number) =>
			warnLog(module, message, context, duration),
		error: (message: string, context?: LogContext, duration?: number) =>
			errorLog(module, message, context, duration),
		performance: (operation: string, startTime: number, context?: LogContext) =>
			performanceLog(module, operation, startTime, context),
	};
}

/**
 * Logger interface
 */
export interface Logger {
	debug: (message: string, context?: LogContext, duration?: number) => void;
	info: (message: string, context?: LogContext, duration?: number) => void;
	warn: (message: string, context?: LogContext, duration?: number) => void;
	error: (message: string, context?: LogContext, duration?: number) => void;
	performance: (
		operation: string,
		startTime: number,
		context?: LogContext,
	) => void;
}

/**
 * Decorator for automatic performance logging
 */
export function logPerformance(moduleName: string) {
	return (
		_target: unknown,
		propertyKey: string,
		descriptor: PropertyDescriptor,
	) => {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: unknown[]) {
			const logger = createLogger(moduleName);
			const startTime = performance.now();

			try {
				const result = await originalMethod.apply(this, args);
				logger.performance(`${propertyKey}`, startTime);
				return result;
			} catch (error) {
				logger.error(
					`${propertyKey} failed`,
					{ error },
					performance.now() - startTime,
				);
				throw error;
			}
		};
	};
}

/**
 * Wrapper function for async operations with automatic error logging
 */
export async function withLogging<T>(
	logger: Logger,
	operation: string,
	fn: () => Promise<T>,
	context?: LogContext,
): Promise<T | null> {
	const startTime = performance.now();

	try {
		const result = await fn();
		logger.performance(operation, startTime, context);
		return result;
	} catch (error) {
		logger.error(
			`${operation} failed`,
			{ ...context, error },
			performance.now() - startTime,
		);
		return null;
	}
}

/**
 * Wrapper function for sync operations with automatic error logging
 */
export function withLoggingSync<T>(
	logger: Logger,
	operation: string,
	fn: () => T,
	context?: LogContext,
): T | null {
	const startTime = performance.now();

	try {
		const result = fn();
		logger.performance(operation, startTime, context);
		return result;
	} catch (error) {
		logger.error(
			`${operation} failed`,
			{ ...context, error },
			performance.now() - startTime,
		);
		return null;
	}
}
