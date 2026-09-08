/**
 * AstroEX Logging System - Core Logger & Engine
 *
 * Provides structured, scoped, performant, and secure logging.
 */

import { formatJson, formatTerminal } from "./formatter";
import { isLogLevelEnabled, normalizeLogLevel } from "./levels";
import { sanitizeContext, sanitizeError } from "./redaction";
import { ConsoleTransport, FileTransport } from "./transports";
import type {
	LegacyLogLevel,
	LogContext,
	LogLevel,
	LogOutputOptions,
	LogRecord,
	LogTimer,
	Logger,
	LoggingConfig,
} from "./types";

class ScopedTimer implements LogTimer {
	readonly startTime: number = performance.now();

	constructor(
		readonly operation: string,
		private readonly logger: Logger,
	) {}

	elapsedMs(): number {
		return Math.round((performance.now() - this.startTime) * 100) / 100;
	}

	done(
		message?: string,
		level: LogLevel = "info",
		additionalContext: LogContext = {},
	): number {
		const elapsed = this.elapsedMs();
		const msg = message || `${this.operation} completed`;
		const mergedContext = {
			...additionalContext,
			durationMs: elapsed,
		};

		switch (level) {
			case "trace":
				this.logger.trace(msg, mergedContext);
				break;
			case "debug":
				this.logger.debug(msg, mergedContext);
				break;
			case "success":
				this.logger.success(msg, mergedContext);
				break;
			case "warn":
				this.logger.warn(msg, mergedContext);
				break;
			case "error":
				this.logger.error(msg, undefined, mergedContext);
				break;
			case "fatal":
				this.logger.fatal(msg, undefined, mergedContext);
				break;
			default:
				this.logger.info(msg, mergedContext);
				break;
		}

		return elapsed;
	}
}

class ScopedLogger implements Logger {
	constructor(
		readonly component: string,
		private readonly defaultContext: LogContext,
		private readonly manager: LoggingManager,
	) {}

	private emit(
		level: LogLevel,
		message: string,
		context?: LogContext,
		output?: LogOutputOptions,
	): void {
		const mergedContext = {
			...this.manager.getActiveContext(),
			...this.defaultContext,
			...context,
		};

		this.manager.dispatch(
			{
				timestamp: new Date().toISOString(),
				level,
				component: this.component,
				message,
				context:
					Object.keys(mergedContext).length > 0 ? mergedContext : undefined,
			},
			output,
		);
	}

	trace(message: string, context?: LogContext): void {
		this.emit("trace", message, context);
	}

	debug(message: string, context?: LogContext): void {
		this.emit("debug", message, context);
	}

	info(message: string, context?: LogContext): void {
		this.emit("info", message, context);
	}

	success(message: string, context?: LogContext): void {
		this.emit("success", message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.emit("warn", message, context);
	}

	error(message: string, errorOrContext?: unknown, context?: LogContext): void {
		let finalContext: LogContext = { ...context };

		if (errorOrContext !== undefined && errorOrContext !== null) {
			if (errorOrContext instanceof Error) {
				finalContext.error = sanitizeError(errorOrContext);
			} else if (
				typeof errorOrContext === "object" &&
				!Array.isArray(errorOrContext)
			) {
				finalContext = { ...errorOrContext, ...finalContext };
			} else {
				finalContext.error = sanitizeError(errorOrContext);
			}
		}

		this.emit("error", message, finalContext);
	}

	fatal(message: string, errorOrContext?: unknown, context?: LogContext): void {
		let finalContext: LogContext = { ...context };

		if (errorOrContext !== undefined && errorOrContext !== null) {
			if (errorOrContext instanceof Error) {
				finalContext.error = sanitizeError(errorOrContext);
			} else if (
				typeof errorOrContext === "object" &&
				!Array.isArray(errorOrContext)
			) {
				finalContext = { ...errorOrContext, ...finalContext };
			} else {
				finalContext.error = sanitizeError(errorOrContext);
			}
		}

		this.emit("fatal", message, finalContext);
	}

	infoOnce(key: string, message: string, context?: LogContext): void {
		if (this.manager.markLoggedOnce(`${this.component}:${key}`)) {
			this.info(message, context);
		}
	}

	debugOnce(key: string, message: string, context?: LogContext): void {
		if (this.manager.markLoggedOnce(`${this.component}:${key}`)) {
			this.debug(message, context);
		}
	}

	startTimer(operation = this.component): LogTimer {
		return new ScopedTimer(operation, this);
	}

	async time<T>(
		operation: string,
		fn: () => Promise<T>,
		context?: LogContext,
	): Promise<T> {
		const timer = this.startTimer(operation);
		try {
			const result = await fn();
			timer.done(`${operation} succeeded`, "debug", context);
			return result;
		} catch (error) {
			const elapsed = timer.elapsedMs();
			this.error(`${operation} failed`, error, {
				...context,
				durationMs: elapsed,
			});
			throw error;
		}
	}

	timeSync<T>(operation: string, fn: () => T, context?: LogContext): T {
		const timer = this.startTimer(operation);
		try {
			const result = fn();
			timer.done(`${operation} succeeded`, "debug", context);
			return result;
		} catch (error) {
			const elapsed = timer.elapsedMs();
			this.error(`${operation} failed`, error, {
				...context,
				durationMs: elapsed,
			});
			throw error;
		}
	}

	child(subComponent: string, defaultContext?: LogContext): Logger {
		const childComponent = `${this.component}:${subComponent}`;
		return new ScopedLogger(
			childComponent,
			{ ...this.defaultContext, ...defaultContext },
			this.manager,
		);
	}

	isLevelEnabled(level: LogLevel): boolean {
		return isLogLevelEnabled(level, this.manager.getConfig().minLevel);
	}
}

export class LoggingManager {
	private config: LoggingConfig;
	private activeContext: LogContext = {};
	private consoleTransport = new ConsoleTransport();
	private fileTransport = new FileTransport();
	private seenOnceKeys = new Set<string>();

	constructor() {
		this.config = this.resolveInitialConfig();
	}

	private resolveInitialConfig(): LoggingConfig {
		const configuredLevel = process.env.ASTROEX_LOG_LEVEL?.trim().toLowerCase();
		let minLevel: LogLevel = "info";

		if (
			configuredLevel &&
			["trace", "debug", "info", "success", "warn", "error", "fatal"].includes(
				configuredLevel,
			)
		) {
			minLevel = configuredLevel as LogLevel;
		} else if (
			process.env.ASTROEX_VERBOSE === "1" ||
			process.argv.includes("--verbose") ||
			process.argv.includes("-v")
		) {
			minLevel = "debug";
		} else {
			minLevel = "info";
		}

		const format =
			process.env.ASTROEX_LOG_FORMAT?.toLowerCase() === "json"
				? "json"
				: "pretty";

		const noColor =
			Boolean(process.env.NO_COLOR) ||
			Boolean(process.env.ASTROEX_NO_COLOR) ||
			process.argv.includes("--no-color");

		return {
			minLevel,
			format,
			enableConsole: true,
			enableFile: true,
			useColor: !noColor,
		};
	}

	getConfig(): LoggingConfig {
		return { ...this.config };
	}

	configure(updates: Partial<LoggingConfig>): void {
		this.config = { ...this.config, ...updates };
	}

	getActiveContext(): LogContext {
		return { ...this.activeContext };
	}

	setContext(ctx: Partial<LogContext>): void {
		this.activeContext = { ...this.activeContext, ...ctx };
	}

	clearContext(): void {
		this.activeContext = {};
	}

	markLoggedOnce(key: string): boolean {
		if (this.seenOnceKeys.has(key)) {
			return false;
		}
		this.seenOnceKeys.add(key);
		return true;
	}

	clearOnceKeys(): void {
		this.seenOnceKeys.clear();
	}

	withContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
		const previous = { ...this.activeContext };
		this.activeContext = { ...this.activeContext, ...ctx };
		try {
			return fn();
		} finally {
			this.activeContext = previous;
		}
	}

	initializeFileLogging(
		logDir: string,
		fileName: string,
		commandName?: string,
	): string {
		return this.fileTransport.initialize(logDir, fileName, commandName);
	}

	getLogFilePath(): string | null {
		return this.fileTransport.getFilePath();
	}

	closeFileLogging(): Promise<void> {
		return this.fileTransport.close();
	}

	createLogger(component: string, defaultContext?: LogContext): Logger {
		return new ScopedLogger(component, defaultContext ?? {}, this);
	}

	dispatch(record: LogRecord, outputOptions: LogOutputOptions = {}): void {
		if (!record.component || typeof record.component !== "string") {
			process.stderr.write("[AstroEX] invalid log component\n");
			return;
		}
		if (!record.message || typeof record.message !== "string") {
			process.stderr.write(
				`[AstroEX] invalid log message for ${record.component}\n`,
			);
			return;
		}

		const level = normalizeLogLevel(record.level);
		if (!isLogLevelEnabled(level, this.config.minLevel)) {
			return;
		}

		let sanitizedContext: Record<string, unknown> | undefined;
		if (record.context) {
			try {
				sanitizedContext = sanitizeContext(record.context) as Record<
					string,
					unknown
				>;
			} catch (err) {
				sanitizedContext = { contextSerializationError: String(err) };
			}
		}

		const cleanRecord: LogRecord = {
			timestamp: record.timestamp || new Date().toISOString(),
			level,
			component: record.component,
			message: record.message,
			...(sanitizedContext && Object.keys(sanitizedContext).length > 0
				? { context: sanitizedContext }
				: {}),
		};

		// Output to console
		const shouldLogConsole =
			outputOptions.console !== false && this.config.enableConsole;
		if (shouldLogConsole) {
			const formatted =
				this.config.format === "json"
					? formatJson(cleanRecord)
					: formatTerminal(cleanRecord, this.config.useColor);
			this.consoleTransport.write(cleanRecord, formatted);
		}

		// Output to file
		const shouldLogFile =
			outputOptions.file !== false && this.config.enableFile;
		if (shouldLogFile) {
			const jsonLine = formatJson(cleanRecord);
			this.fileTransport.write(cleanRecord, jsonLine);
		}
	}
}

// Global default instance
export const defaultLoggingManager = new LoggingManager();

export function createLogger(
	component: string,
	defaultContext?: LogContext,
): Logger {
	return defaultLoggingManager.createLogger(component, defaultContext);
}

/**
 * Standard log function matching legacy signature.
 */
export function log(
	component: string,
	message: string,
	level: LegacyLogLevel = "info",
	context?: object,
	output: LogOutputOptions = {},
): void {
	defaultLoggingManager.dispatch(
		{
			timestamp: new Date().toISOString(),
			level: normalizeLogLevel(level),
			component,
			message,
			context: context as LogContext | undefined,
		},
		output,
	);
}

/**
 * Log a message only once per unique key.
 */
export function logOnce(
	key: string,
	component: string,
	message: string,
	level: LegacyLogLevel = "info",
	context?: object,
	output: LogOutputOptions = {},
): void {
	if (defaultLoggingManager.markLoggedOnce(`${component}:${key}`)) {
		log(component, message, level, context, output);
	}
}

/**
 * Reset tracked logOnce keys (useful for testing).
 */
export function clearOnceKeys(): void {
	defaultLoggingManager.clearOnceKeys();
}

/**
 * Enhanced error logging helper.
 */
export function logError(
	prefix: string,
	error: unknown,
	context?: object,
	logLevel: "error" | "warn" = "error",
): void {
	const logger = defaultLoggingManager.createLogger(prefix);
	if (logLevel === "warn") {
		logger.warn(
			error instanceof Error ? error.message : String(error),
			context as LogContext,
		);
	} else {
		logger.error(
			error instanceof Error ? error.message : String(error),
			error,
			context as LogContext,
		);
	}
}

export function initializeFileLogging(
	logDir: string,
	fileName: string,
	commandName?: string,
): string {
	return defaultLoggingManager.initializeFileLogging(
		logDir,
		fileName,
		commandName,
	);
}

export function closeFileLogging(): Promise<void> {
	return defaultLoggingManager.closeFileLogging();
}

export function getLogFilePath(): string | null {
	return defaultLoggingManager.getLogFilePath();
}

export function configureLogging(config: Partial<LoggingConfig>): void {
	defaultLoggingManager.configure(config);
}

export function setContext(context: Partial<LogContext>): void {
	defaultLoggingManager.setContext(context);
}

export function clearContext(): void {
	defaultLoggingManager.clearContext();
}

export function getCurrentContext(): LogContext {
	return defaultLoggingManager.getActiveContext();
}

export function withContext<T>(context: Partial<LogContext>, fn: () => T): T {
	return defaultLoggingManager.withContext(context, fn);
}
