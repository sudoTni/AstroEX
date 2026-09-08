/**
 * Enhanced logging utilities for consistent logging across AstroEX
 *
 * This module provides backward-compatible adapters for the centralized
 * logging system in `src/logging`.
 */

import {
	type LogContext,
	type Logger,
	createLogger as createCentralLogger,
	defaultLoggingManager,
	formatDuration,
	log,
} from "../logging";

// Legacy enum log levels for backward compatibility
export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

export type { LogContext, Logger };

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	context: LogContext;
	module: string;
	duration?: number;
}

export interface LoggingConfig {
	level: LogLevel;
	enableConsole: boolean;
	enableFile: boolean;
	correlationIdGenerator?: () => string;
}

const DEFAULT_CONFIG: LoggingConfig = {
	level: LogLevel.INFO,
	enableConsole: true,
	enableFile: true,
	correlationIdGenerator: () =>
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15),
};

let globalConfig: LoggingConfig = { ...DEFAULT_CONFIG };

export function configureLogging(config: Partial<LoggingConfig>): void {
	globalConfig = { ...globalConfig, ...config };
	const levelMap: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
		[LogLevel.DEBUG]: "debug",
		[LogLevel.INFO]: "info",
		[LogLevel.WARN]: "warn",
		[LogLevel.ERROR]: "error",
	};
	if (config.level !== undefined) {
		defaultLoggingManager.configure({
			minLevel: levelMap[config.level],
			enableConsole: config.enableConsole,
			enableFile: config.enableFile,
		});
	}
}

export function getCurrentContext(): LogContext {
	return defaultLoggingManager.getActiveContext();
}

export function setContext(context: Partial<LogContext>): void {
	const correlationId =
		context.correlationId ||
		defaultLoggingManager.getActiveContext().correlationId ||
		globalConfig.correlationIdGenerator?.() ||
		"default";
	defaultLoggingManager.setContext({ ...context, correlationId });
}

export function clearContext(): void {
	defaultLoggingManager.clearContext();
}

export function debugLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	createCentralLogger(module).debug(message, {
		...context,
		...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
	});
}

export function infoLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	createCentralLogger(module).info(message, {
		...context,
		...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
	});
}

export function warnLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	createCentralLogger(module).warn(message, {
		...context,
		...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
	});
}

export function errorLog(
	module: string,
	message: string,
	context?: LogContext,
	duration?: number,
): void {
	createCentralLogger(module).error(message, undefined, {
		...context,
		...(duration !== undefined ? { durationMs: Math.round(duration) } : {}),
	});
}

export function performanceLog(
	module: string,
	operation: string,
	startTime: number,
	context?: LogContext,
): void {
	const duration = performance.now() - startTime;
	createCentralLogger(module).info(
		`Performance: ${operation} (${formatDuration(duration)})`,
		{
			...context,
			durationMs: Math.round(duration * 100) / 100,
		},
	);
}

export function createLogger(module: string): Logger {
	return createCentralLogger(module);
}

/**
 * Decorator for automatic performance logging on async methods.
 */
export function logPerformance(moduleName: string) {
	return (
		_target: unknown,
		propertyKey: string,
		descriptor: PropertyDescriptor,
	) => {
		const originalMethod = descriptor.value;

		descriptor.value = async function (...args: unknown[]) {
			const logger = createCentralLogger(moduleName);
			const timer = logger.startTimer(String(propertyKey));

			try {
				const result = await originalMethod.apply(this, args);
				timer.done(`${String(propertyKey)} completed`, "info");
				return result;
			} catch (error) {
				const elapsed = timer.elapsedMs();
				logger.error(`${String(propertyKey)} failed`, error, {
					durationMs: elapsed,
				});
				throw error;
			}
		};
	};
}

/**
 * Wrapper function for async operations with automatic error logging.
 */
export async function withLogging<T>(
	logger: Logger,
	operation: string,
	fn: () => Promise<T>,
	context?: LogContext,
): Promise<T | null> {
	const timer = logger.startTimer(operation);
	try {
		const result = await fn();
		timer.done(`${operation} completed`, "info", context);
		return result;
	} catch (error) {
		const elapsed = timer.elapsedMs();
		logger.error(`${operation} failed`, error, {
			...context,
			durationMs: elapsed,
		});
		return null;
	}
}

/**
 * Wrapper function for sync operations with automatic error logging.
 */
export function withLoggingSync<T>(
	logger: Logger,
	operation: string,
	fn: () => T,
	context?: LogContext,
): T | null {
	const timer = logger.startTimer(operation);
	try {
		const result = fn();
		timer.done(`${operation} completed`, "info", context);
		return result;
	} catch (error) {
		const elapsed = timer.elapsedMs();
		logger.error(`${operation} failed`, error, {
			...context,
			durationMs: elapsed,
		});
		return null;
	}
}
