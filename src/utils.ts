import {
	applyBannerRainbow,
	applyRainbowText,
	hsvToRgb,
	isColorSupported,
	log,
	logError,
} from "./logging";

export { applyBannerRainbow, applyRainbowText, hsvToRgb, isColorSupported };

/** Print the AstroEX banner with the screenshot-matched block/fade effect. */
export function printBanner(useColor = isColorSupported()) {
	const banner = `        ▄▄▄       ██████ ▄▄▄█████▓ ██▀███   ▒█████
       ▒████▄   ▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▒██▒  ██▒
       ▒██  ▀█▄ ░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒██░  ██▒
       ░██▄▄▄▄██  ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒██   ██░
        ▓█   ▓██▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░ ████▓▒░
        ▒▒   ▓▒█░ ▒▓▒ ▒ ░  ▒ ░░   ░ ▒▓ ░▒▓░░ ▒░▒░▒░
         ▒   ▒▒ ░ ░▒  ░ ░    ░      ░▒ ░ ▒░  ░ ▒ ▒░
         ░   ▒    ░  ░    ░        ░░   ░ ░ ░ ░ ▒
             ░  ░       ░           ░         ░ ░
			 `;

	if (useColor) {
		const rawLines = banner.trimEnd().split("\n");
		const commonIndent = Math.min(
			...rawLines
				.filter((line) => line.trim().length > 0)
				.map((line) => line.match(/^ */)?.[0].length ?? 0),
		);
		const lines = rawLines.map((line) => line.slice(commonIndent).trimEnd());
		const contentWidth = Math.max(...lines.map((line) => line.length));
		const coloredLines = lines.map((line, index) =>
			applyBannerRainbow(
				` ${line.padEnd(contentWidth)} `,
				useColor,
				rawLines[index].length,
			),
		);
		process.stdout.write(`${coloredLines.join("\n")}\n`);
	} else {
		process.stdout.write(`${banner}\n`);
	}
}

export function formatDate(
	date: Date | string | number,
	format = "yyyy-mm-dd",
): string {
	const d = new Date(date);
	const year = d.getFullYear();
	const month = `0${d.getMonth() + 1}`.slice(-2);
	const day = `0${d.getDate()}`.slice(-2);
	const hours = `0${d.getHours()}`.slice(-2);
	const minutes = `0${d.getMinutes()}`.slice(-2);
	const seconds = `0${d.getSeconds()}`.slice(-2);

	switch (format) {
		case "yyyyMMdd_HHmmss":
			return `${year}${month}${day}_${hours}${minutes}${seconds}`;
		case "yyyy-MM-dd HH:mm:ss":
			return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
		default:
			return `${year}-${month}-${day}`;
	}
}

/**
 * Create standardized error types for better error handling
 */
export class AppError extends Error {
	constructor(
		public readonly code: string,
		public readonly statusCode: number = 500,
		message?: string,
		public readonly context?: object,
	) {
		super(message || `Application error: ${code}`);
		this.name = "AppError";
	}
}

/**
 * Handle async errors consistently
 */
export async function handleAsyncError<T>(
	operation: () => Promise<T>,
	prefix: string,
	errorCode = "ASYNC_ERROR",
	defaultValue?: T,
): Promise<T | undefined> {
	try {
		return await operation();
	} catch (error) {
		const appError =
			error instanceof Error
				? new AppError(errorCode, 500, error.message, {
						originalError: error.message,
					})
				: new AppError(errorCode, 500, String(error));

		logError(prefix, appError, { operation: operation.name || "anonymous" });
		return defaultValue;
	}
}

/**
 * Safe async wrapper with error handling
 * @param operation Async operation to execute
 * @param prefix Log prefix for error reporting
 * @param errorMessage Custom error message (optional)
 * @param context Additional context for error logging
 * @returns Result of operation or null on failure
 */
export async function safeAsyncOperation<T>(
	operation: () => Promise<T>,
	prefix: string,
	errorMessage = "Operation failed",
	context?: object,
): Promise<T | null> {
	try {
		return await operation();
	} catch (error) {
		logError(prefix, error as Error | string, {
			...context,
			operation: operation.name || "anonymous",
			errorMessage,
		});
		return null;
	}
}

/**
 * Retry wrapper with exponential backoff
 * @param operation Async operation to retry
 * @param maxRetries Maximum number of retry attempts
 * @param initialDelay Initial delay in milliseconds
 * @param prefix Log prefix for error reporting
 * @param context Additional context for error logging
 * @returns Result of operation or null on failure
 */
export async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	maxRetries = 3,
	initialDelay = 1000,
	prefix = "Retry",
	context?: object,
): Promise<T | null> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error as Error;
			const delay = initialDelay * 2 ** (attempt - 1);

			log(prefix, `Attempt ${attempt} failed, retrying in ${delay}ms`, "warn", {
				...context,
				attempt,
				maxRetries,
				delay,
				error: error instanceof Error ? error.message : String(error),
			});

			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	logError(prefix, lastError || "Operation failed after retries", {
		...context,
		maxRetries,
	});

	return null;
}

// Re-export centralized logging system
export * from "./logging";

// Re-export enhanced logging utilities without colliding exports
export {
	LogEntry,
	debugLog,
	infoLog,
	warnLog,
	errorLog,
	performanceLog,
	logPerformance,
	withLogging,
	withLoggingSync,
} from "./utils/enhancedLogging";
