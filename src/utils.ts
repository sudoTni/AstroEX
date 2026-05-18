import * as fs from "node:fs";
import * as path from "node:path";
import * as chalk from "chalk";
import type * as puppeteer from "puppeteer";

// --- Rainbow/Gradient Color Utilities ---

/**
 * Convert HSV to RGB.
 * @param h Hue [0,1]
 * @param s Saturation [0,1]
 * @param v Value [0,1]
 * @returns [r,g,b] in [0,255]
 */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	let r = 0,
		g = 0,
		b = 0;
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));
	switch (i % 6) {
		case 0:
			r = v;
			g = t;
			b = p;
			break;
		case 1:
			r = q;
			g = v;
			b = p;
			break;
		case 2:
			r = p;
			g = v;
			b = t;
			break;
		case 3:
			r = p;
			g = q;
			b = v;
			break;
		case 4:
			r = t;
			g = p;
			b = v;
			break;
		case 5:
			r = v;
			g = p;
			b = q;
			break;
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Detect if the terminal supports truecolor (24-bit).
 */
function _supportsTruecolor(): boolean {
	const env = process.env;
	return (
		!!env.COLORTERM?.match(/truecolor|24bit/i) ||
		!!env.TERM_PROGRAM?.match(/iTerm|WezTerm|Apple_Terminal/i) ||
		!!env.TERM?.match(/xterm-truecolor|tmux-truecolor|rxvt|konsole/i)
	);
}

/**
 * Interpolate between two RGB colors.
 * @param color1 [r,g,b] first color
 * @param color2 [r,g,b] second color
 * @param t interpolation factor [0,1]
 * @returns [r,g,b] interpolated color
 */
function interpolateColor(
	color1: [number, number, number],
	color2: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(color1[0] + (color2[0] - color1[0]) * t),
		Math.round(color1[1] + (color2[1] - color1[1]) * t),
		Math.round(color1[2] + (color2[2] - color1[2]) * t),
	];
}

/**
 * Generate a smooth gradient palette by interpolating between colors.
 * @param basePalette Original color palette
 * @param targetSteps Number of color steps to generate
 * @returns Smooth gradient palette
 */
function generateSmoothGradient(
	basePalette: [number, number, number][],
	targetSteps: number = 50,
): [number, number, number][] {
	if (basePalette.length <= 1) {
		return basePalette;
	}

	const smoothPalette: [number, number, number][] = [];
	const totalSegments = basePalette.length - 1;

	for (let seg = 0; seg < totalSegments; seg++) {
		const color1 = basePalette[seg];
		const color2 = basePalette[seg + 1];

		// Steps for this segment
		const stepsInSegment =
			Math.floor((targetSteps / totalSegments) * (seg + 1)) -
			Math.floor((targetSteps / totalSegments) * seg);

		for (let i = 0; i < stepsInSegment; i++) {
			const t = i / Math.max(1, stepsInSegment - 1);
			smoothPalette.push(interpolateColor(color1, color2, t));
		}
	}

	// Ensure we have exactly targetSteps colors
	while (smoothPalette.length < targetSteps && smoothPalette.length < 200) {
		const lastColor =
			smoothPalette[smoothPalette.length - 1] ||
			basePalette[basePalette.length - 1];
		smoothPalette.push(lastColor);
	}

	return smoothPalette.slice(0, targetSteps);
}

/**
 * Apply a rainbow gradient to a string, coloring each visible character.
 * Handles empty strings and non-ASCII.
 */
export function applyRainbowText(
	text: string,
	startHue: number = 0,
	useColor: boolean = true,
): string {
	if (!useColor || !text) return text;
	let out = "";
	let pos = 0;
	// Split by Unicode codepoints for safety
	for (const char of [...text]) {
		// Avoid coloring ANSI escape codes
		if (char.trim() && char.charCodeAt(0) !== 27) {
			const hue = (startHue + pos / Math.max(1, text.length)) % 1.0;
			const [r, g, b] = hsvToRgb(hue, 0.8, 0.98);
			out += `\x1b[38;2;${r};${g};${b}m${char}\x1b[0m`;
			pos++;
		} else {
			out += char;
		}
	}
	return out;
}

/**
 * Apply a linear gradient from a palette to a string with smooth color transitions.
 * Handles empty strings and palette edge cases.
 */
export function applyGradientText(
	text: string,
	palette: [number, number, number][],
	useColor: boolean = true,
): string {
	if (!useColor || palette.length === 0 || !text) return text;

	// Generate smooth gradient palette with many intermediate colors
	const smoothPalette = generateSmoothGradient(palette, 50);

	const n = text.length;
	let out = "";
	for (let i = 0; i < n; i++) {
		const idx =
			smoothPalette.length === 1
				? 0
				: Math.floor((i * (smoothPalette.length - 1)) / Math.max(1, n - 1));
		const [r, g, b] = smoothPalette[idx];
		out += `\x1b[38;2;${r};${g};${b}m${text[i]}\x1b[0m`;
	}
	return out;
}

// Color palettes (RGB arrays)
export const paletteInfo: [number, number, number][] = [
	[0, 206, 209], // Dark Turquoise
	[0, 191, 255], // Deep Sky Blue
	[30, 144, 255], // Dodger Blue
	[0, 255, 127], // Spring Green
	[64, 224, 208], // Turquoise
	[127, 255, 212], // Aquamarine
	[102, 205, 170], // Medium Aquamarine
	[32, 178, 170], // Light Sea Green
];

export const paletteWarn: [number, number, number][] = [
	[255, 215, 0], // Gold
	[255, 165, 0], // Orange
	[255, 140, 0], // Dark Orange
	[255, 120, 0], // Burnt Orange
	[255, 175, 25], // Amber
	[255, 193, 37], // Goldenrod
	[250, 250, 210], // Light Goldenrod
	[240, 230, 140], // Khaki
];

export const paletteError: [number, number, number][] = [
	[255, 0, 0], // Red
	[220, 20, 60], // Crimson
	[178, 34, 34], // Firebrick
	[139, 0, 0], // Dark Red
	[255, 69, 0], // Red-Orange
	[255, 99, 71], // Tomato
	[205, 92, 92], // Indian Red
	[165, 0, 33], // Deep Red (replaces Light Coral for a less harsh end)
];

// Banner function (block/fade effect)
/**
 * Print the AstroEX banner with a vivid rainbow gradient and fade blocks.
 * The banner centers itself based on terminal width if possible.
 */
export function printBanner(useColor: boolean = true) {
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
		const lines = banner.split("\n");
		const coloredLines = lines.map((line) =>
			applyRainbowText(line, 0, useColor),
		);
		process.stdout.write(`${coloredLines.join("\n")}\n`);
	} else {
		process.stdout.write(`${banner}\n`);
	}
}

let logFileStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;

export function initializeFileLogging(
	logDir: string,
	fileName: string,
	commandName?: string,
): void {
	if (logFileStream) {
		logFileStream.end(); // Close existing stream if any
	}
	const fullLogDir = path.resolve(logDir);
	if (!fs.existsSync(fullLogDir)) {
		fs.mkdirSync(fullLogDir, { recursive: true });
	}

	// If commandName is provided, prepend it to the filename
	const finalFileName = commandName ? `${commandName}_${fileName}` : fileName;
	logFilePath = path.join(fullLogDir, finalFileName);
	logFileStream = fs.createWriteStream(logFilePath, { flags: "a" });
	logFileStream.on("error", (err) => {
		console.error(`Error writing to log file ${logFilePath}:`, err);
	});
}

export function closeFileLogging(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (logFileStream) {
			logFileStream.on("finish", () => {
				logFileStream = null;
				logFilePath = null;
				resolve();
			});
			logFileStream.on("error", (err) => {
				logFileStream = null;
				logFilePath = null;
				reject(err);
			});
			logFileStream.end();
		} else {
			resolve(); // Resolve immediately if no stream exists
		}
	});
}

export function formatDate(
	date: Date | string | number,
	format: string = "yyyy-mm-dd",
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

// Enhanced logging function with structured output and optional context
export function log(
	prefix: string,
	message: string,
	level: "log" | "error" | "warn" | "info" = "log",
	context?: object,
): void {
	// Validate inputs
	if (!prefix || typeof prefix !== "string") {
		console.error(`[LOG ERROR] Invalid prefix: ${prefix}`, new Error().stack);
		return;
	}

	if (!message || typeof message !== "string") {
		console.error(
			`[LOG ERROR] Invalid message for prefix ${prefix}`,
			new Error().stack,
		);
		return;
	}

	// Allow disabling color with NO_COLOR or ASTROEX_NO_COLOR
	const useColor = !process.env.NO_COLOR && !process.env.ASTROEX_NO_COLOR;

	const timestamp = new Date().toISOString(); // Use ISO string for structured logging
	const levelTag = level.toUpperCase();
	const prefixTag = prefix;

	// Merge optional context into message for file output (kept simple to avoid breaking format)
	let contextualMessage = message;
	if (context && Object.keys(context).length) {
		try {
			contextualMessage = `${message} ${JSON.stringify(context)}`;
		} catch (jsonError) {
			contextualMessage = `${message} [Context serialization failed: ${jsonError}]`;
		}
	}

	// Console output (gradient for readability)
	const colorizedTimestamp = useColor
		? chalk.dim(formatDate(new Date(), "yyyy-MM-dd HH:mm:ss"))
		: formatDate(new Date(), "yyyy-MM-dd HH:mm:ss");
	let colorizedLevel = `[${levelTag}]`;
	let colorizedPrefix = `[${prefixTag}]`;
	let colorizedMessage = contextualMessage;

	if (useColor) {
		switch (level) {
			case "error":
				colorizedLevel = applyGradientText(
					colorizedLevel,
					paletteError,
					useColor,
				);
				colorizedMessage = applyGradientText(
					contextualMessage,
					paletteError,
					useColor,
				);
				break;
			case "warn":
				colorizedLevel = applyGradientText(
					colorizedLevel,
					paletteWarn,
					useColor,
				);
				colorizedMessage = applyGradientText(
					contextualMessage,
					paletteWarn,
					useColor,
				);
				break;
			case "info":
				colorizedLevel = applyGradientText(
					colorizedLevel,
					paletteInfo,
					useColor,
				);
				colorizedMessage = applyGradientText(
					contextualMessage,
					paletteInfo,
					useColor,
				);
				break;
			default:
				colorizedLevel = applyRainbowText(colorizedLevel, 0, useColor);
				colorizedMessage = applyRainbowText(contextualMessage, 0.15, useColor);
				break;
		}
		colorizedPrefix = useColor ? chalk.white(colorizedPrefix) : colorizedPrefix;
	}

	const consoleOutput = `${colorizedTimestamp} ${colorizedPrefix} ${colorizedLevel} ${colorizedMessage}`;

	try {
		console.log(consoleOutput);
	} catch (consoleError) {
		console.error(
			`[CONSOLE LOG ERROR] Failed to output to console: ${consoleError}`,
		);
		console.error(`Original log: [${prefixTag}] ${levelTag} ${message}`);
	}

	// File output (plain, no color)
	const fileOutput = `${timestamp} ${prefixTag} ${levelTag} ${contextualMessage}`;
	if (logFileStream) {
		try {
			logFileStream.write(`${fileOutput}\n`);
		} catch (fileError) {
			console.error(
				`[FILE LOG ERROR] Failed to write to log file: ${fileError}`,
			);
		}
	}
}

/**
 * Enhanced error logging with stack trace and context
 * @param prefix Log prefix for error categorization
 * @param error Error object or error message string
 * @param context Additional context for debugging
 * @param logLevel Log level (error or warn)
 */
export function logError(
	prefix: string,
	error: Error | string,
	context?: object,
	logLevel: "error" | "warn" = "error",
): void {
	const errorMessage = error instanceof Error ? error.message : error;
	const stackTrace = error instanceof Error ? error.stack : undefined;
	const errorType =
		error instanceof Error ? error.constructor.name : typeof error;

	// Create enhanced error context
	const errorContext = {
		...context,
		stackTrace: stackTrace,
		errorType,
		errorMessage,
		timestamp: new Date().toISOString(),
		...(process.env.NODE_ENV === "development" && {
			stackTrace: stackTrace,
		}),
	};

	log(prefix, `Error: ${errorMessage}`, logLevel, errorContext);

	// In development mode, also log to stderr for better visibility
	if (process.env.NODE_ENV === "development" && stackTrace) {
		console.error(`\n[${prefix}] Error Details:\n${stackTrace}\n`);
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
	errorCode: string = "ASYNC_ERROR",
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
	errorMessage: string = "Operation failed",
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
	maxRetries: number = 3,
	initialDelay: number = 1000,
	prefix: string = "Retry",
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

// New duration formatting function
export function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	const remainingMilliseconds = milliseconds % 1000;

	const parts: string[] = [];
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (remainingSeconds > 0 || minutes === 0) {
		// Include seconds if there are no minutes or if there are remaining seconds
		parts.push(`${remainingSeconds}s`);
	}
	if (remainingMilliseconds > 0 && minutes === 0 && remainingSeconds === 0) {
		// Include milliseconds only if less than a second
		parts.push(`${remainingMilliseconds}ms`);
	}

	return parts.join(" ");
}

function _describe(jsHandle: unknown) {
	// Be defensive about the shape of jsHandle; use unknown and narrow with casts in one safe spot
	return (
		jsHandle as unknown as {
			executionContext: () => {
				evaluate: (fn: (o: unknown) => string, handle: unknown) => unknown;
			};
		}
	)
		.executionContext()
		.evaluate((obj: unknown) => {
			// serialize |obj| however you want
			return `beautiful object of type ${typeof obj}`;
		}, jsHandle);
}

export function pageAddLogs(page: puppeteer.Page, pageId: string): void {
	/*
    See: https://github.com/puppeteer/puppeteer/issues/2083
    page.on('console', async msg => {
        const args = await Promise.all(msg.args().map(arg => describe(arg)));
        console.log(msg.text(), ...args);
      });
    */

	page
		.on("console", (message) => {
			if (message.type() === "warn") {
				// Use the new log function for warnings
				log(`Puppeteer:${pageId}`, message.text(), "warn");
				return;
			}
			const rawType = message.type().toLowerCase();
			const type = (rawType === "warning" ? "warn" : rawType) as
				| "log"
				| "error"
				| "warn"
				| "info";
			// Use the new log function for other console messages
			log(`Puppeteer:${pageId}`, `${message.text()}`, type);
		})
		// Use the new log function for page errors and request failures
		.on("pageerror", (error) =>
			log(`Puppeteer:${pageId}`, `pageerror: ${error}`, "error"),
		)
		// .on('response', response => log(`Puppeteer:${pageId}`, `response: ${response.status()} ${response.url()}`))
		// .on('request', request => log(`Puppeteer:${pageId}`, `request: ${request.url()} headers: ${JSON.stringify(request.headers())} response: ${request.response()}`))
		.on("requestfailed", (request) =>
			log(
				`Puppeteer:${pageId}`,
				`requestfailed: ${request?.failure()?.errorText} ${request.url()}`,
				"error",
			),
		);
}

// Export enhanced logging utilities
export * from "./utils/enhancedLogging";
