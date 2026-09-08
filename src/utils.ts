import {
	applyBannerRainbow,
	applyRainbowText,
	hsvToRgb,
	log,
	logError,
} from "./logging";

export { applyBannerRainbow, applyRainbowText, hsvToRgb };

// --- Rainbow/Gradient Color Utilities ---

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
	targetSteps = 50,
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
 * Apply a linear gradient from a palette to a string with smooth color transitions.
 * Handles empty strings and palette edge cases.
 */
export function applyGradientText(
	text: string,
	palette: [number, number, number][],
	useColor = true,
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

/** Print the AstroEX banner with the screenshot-matched block/fade effect. */
export function printBanner(useColor = true) {
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
