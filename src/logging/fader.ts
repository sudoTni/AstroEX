/**
 * AstroEX Logging System - HSV Terminal Color Fader
 *
 * Full-featured HSV terminal gradient generator with truecolor 24-bit ANSI rendering,
 * intentional gradient profiles per event category, multi-stop and directional interpolation,
 * Unicode safety, ANSI escape preservation, and stateful streaming support.
 */

export interface HsvColor {
	h: number; // Hue [0, 1)
	s: number; // Saturation [0, 1]
	v: number; // Value/Brightness [0, 1]
}

export type RgbColor = [number, number, number];

export type GradientDirection = "forward" | "reverse" | "shortest" | "longest";

export type GradientMode = "continuous" | "per-line" | "symmetrical";

export interface GradientStop {
	offset: number; // 0.0 to 1.0
	h: number;
	s?: number;
	v?: number;
}

export interface GradientProfile {
	name?: string;
	startHue: number;
	endHue: number;
	saturation?: number; // Default: 0.85
	value?: number; // Default: 0.95
	direction?: GradientDirection; // Default: "shortest"
	mode?: GradientMode; // Default: "continuous"
	stops?: GradientStop[];
	phase?: number; // Phase offset [0, 1)
	cycle?: number; // Number of cycles across the span
}

export interface FadeOptions {
	useColor?: boolean;
	direction?: GradientDirection;
	mode?: GradientMode;
	phase?: number;
	cycle?: number;
	skipWhitespace?: boolean;
	bold?: boolean;
	dim?: boolean;
}

export interface StreamFaderOptions extends FadeOptions {
	cycleLength?: number; // Number of visible characters to complete one full cycle (default: 80)
}

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";

const ANSI_ESCAPE_REGEX = new RegExp(
	`^${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`,
);
const ANSI_COLOR_TOKEN_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[38;2;\\d+;\\d+;\\d+m.${String.fromCharCode(27)}\\[0m`,
	"g",
);
const ANSI_RGB_FOREGROUND_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[38;2;(\\d+;\\d+;\\d+)m`,
);
const ANSI_LIGHT_BANNER_BACKGROUND = "\x1b[48;2;216;216;216m";
const ANSI_BLACK_BANNER_FOREGROUND = "\x1b[38;2;24;24;24m";

/**
 * Convert HSV to RGB accurately with clamping.
 *
 * @param h Hue in [0, 1)
 * @param s Saturation in [0, 1]
 * @param v Value in [0, 1]
 * @returns [r, g, b] in [0, 255]
 */
export function hsvToRgb(h: number, s: number, v: number): RgbColor {
	let normalizedH = h % 1.0;
	if (normalizedH < 0) {
		normalizedH += 1.0;
	}

	const clampedS = Math.max(0, Math.min(1, s));
	const clampedV = Math.max(0, Math.min(1, v));

	let r = 0;
	let g = 0;
	let b = 0;
	const i = Math.floor(normalizedH * 6);
	const f = normalizedH * 6 - i;
	const p = clampedV * (1 - clampedS);
	const q = clampedV * (1 - clampedS * f);
	const t = clampedV * (1 - clampedS * (1 - f));

	switch (i % 6) {
		case 0:
			r = clampedV;
			g = t;
			b = p;
			break;
		case 1:
			r = q;
			g = clampedV;
			b = p;
			break;
		case 2:
			r = p;
			g = clampedV;
			b = t;
			break;
		case 3:
			r = p;
			g = q;
			b = clampedV;
			break;
		case 4:
			r = t;
			g = p;
			b = clampedV;
			break;
		case 5:
			r = clampedV;
			g = p;
			b = q;
			break;
	}

	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Generate 24-bit ANSI foreground color escape sequence.
 */
export function rgbToAnsi(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Generate 24-bit ANSI background color escape sequence.
 */
export function rgbToBgAnsi(r: number, g: number, b: number): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Strip all ANSI escape sequences from text.
 */
export function stripAnsi(text: string): string {
	return text.replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"),
		"",
	);
}

/**
 * Detect whether terminal color is currently enabled.
 */
export function isColorSupported(): boolean {
	if (process.env.NO_COLOR || process.env.ASTROEX_NO_COLOR === "1") {
		return false;
	}
	if (process.env.FORCE_COLOR === "0") {
		return false;
	}
	if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true") {
		return true;
	}
	return Boolean(process.stdout?.isTTY);
}

/**
 * Interpolate hue between h1 and h2 along the specified direction.
 */
export function interpolateHue(
	h1: number,
	h2: number,
	t: number,
	direction: GradientDirection = "shortest",
): number {
	const start = ((h1 % 1.0) + 1.0) % 1.0;
	const end = ((h2 % 1.0) + 1.0) % 1.0;

	if (direction === "forward") {
		const diff = (((end - start) % 1.0) + 1.0) % 1.0;
		return (start + diff * t) % 1.0;
	}

	if (direction === "reverse") {
		const diff = (((start - end) % 1.0) + 1.0) % 1.0;
		return (((start - diff * t) % 1.0) + 1.0) % 1.0;
	}

	if (direction === "longest") {
		const shortDiff = ((end - start + 1.5) % 1.0) - 0.5;
		const longDiff = shortDiff >= 0 ? shortDiff - 1.0 : shortDiff + 1.0;
		return (((start + longDiff * t) % 1.0) + 1.0) % 1.0;
	}

	// Default: "shortest"
	const diff = ((end - start + 1.5) % 1.0) - 0.5;
	return (((start + diff * t) % 1.0) + 1.0) % 1.0;
}

/**
 * Centralized registry of intentional gradient profiles.
 * Distinguishable at a glance with intentional palettes and directions.
 */
export const LOG_GRADIENTS = {
	// Log severity profiles
	trace: {
		name: "trace",
		startHue: 0.68, // Lavender
		endHue: 0.58, // Subdued slate-blue
		saturation: 0.5,
		value: 0.78,
		direction: "shortest",
	},
	debug: {
		name: "debug",
		startHue: 0.5, // Cyan
		endHue: 0.62, // Blue
		saturation: 0.8,
		value: 0.92,
		direction: "forward",
	},
	info: {
		name: "info",
		startHue: 0.58, // Blue
		endHue: 0.76, // Violet
		saturation: 0.85,
		value: 0.98,
		direction: "forward",
	},
	success: {
		name: "success",
		startHue: 0.33, // Green
		endHue: 0.48, // Cyan
		saturation: 0.88,
		value: 0.98,
		direction: "forward",
	},
	warn: {
		name: "warn",
		startHue: 0.14, // Gold / Yellow
		endHue: 0.07, // Amber / Orange
		saturation: 0.92,
		value: 0.98,
		direction: "reverse",
	},
	error: {
		name: "error",
		startHue: 0.08, // Orange
		endHue: 0.0, // Red
		saturation: 0.92,
		value: 0.98,
		direction: "reverse",
	},
	fatal: {
		name: "fatal",
		startHue: 0.0, // Deep Red
		endHue: 0.85, // Magenta
		saturation: 0.95,
		value: 1.0,
		direction: "reverse",
	},

	// LLM Diagnostic & Event Profiles
	request: {
		name: "request",
		startHue: 0.5, // Cyan
		endHue: 0.78, // Violet
		saturation: 0.85,
		value: 0.98,
		direction: "forward",
	},
	response: {
		name: "response",
		startHue: 0.78, // Violet
		endHue: 0.5, // Cyan
		saturation: 0.85,
		value: 0.98,
		direction: "reverse",
	},
	reasoning: {
		name: "reasoning",
		startHue: 0.72, // Indigo
		endHue: 0.88, // Magenta
		saturation: 0.85,
		value: 0.98,
		direction: "forward",
	},
	toolCall: {
		name: "toolCall",
		startHue: 0.46, // Teal
		endHue: 0.6, // Sky Blue
		saturation: 0.85,
		value: 0.96,
		direction: "forward",
	},
	toolResult: {
		name: "toolResult",
		startHue: 0.6, // Sky Blue
		endHue: 0.35, // Mint Green
		saturation: 0.85,
		value: 0.96,
		direction: "reverse",
	},
	streaming: {
		name: "streaming",
		startHue: 0.52, // Cyan
		endHue: 0.8, // Purple
		saturation: 0.85,
		value: 0.98,
		direction: "forward",
	},
	payload: {
		name: "payload",
		startHue: 0.55, // Slate
		endHue: 0.45, // Soft teal
		saturation: 0.65,
		value: 0.88,
		direction: "reverse",
	},
	lifecycle: {
		name: "lifecycle",
		startHue: 0.76, // Purple
		endHue: 0.6, // Deep Blue
		saturation: 0.82,
		value: 0.96,
		direction: "reverse",
	},
	banner: {
		name: "banner",
		startHue: 0.0,
		endHue: 1.0,
		saturation: 0.8,
		value: 0.98,
		direction: "forward",
	},
} as const satisfies Record<string, GradientProfile>;

export type LogGradientKey = keyof typeof LOG_GRADIENTS;

/**
 * Interpolate color for a progress value t in [0, 1] using a GradientProfile.
 */
export function interpolateHsv(
	profile: GradientProfile,
	t: number,
	options: FadeOptions = {},
): RgbColor {
	const clampedT = Math.max(0, Math.min(1, t));
	const mode = options.mode ?? profile.mode ?? "continuous";
	const cycle = options.cycle ?? profile.cycle ?? 1;
	const phase = options.phase ?? profile.phase ?? 0;
	const direction = options.direction ?? profile.direction ?? "shortest";

	// Handle cycling
	let progress = (clampedT * cycle) % 1.0;
	if (clampedT === 1 && (cycle === 1 || progress === 0)) {
		progress = 1.0;
	}

	// Handle symmetrical mode
	if (mode === "symmetrical") {
		progress = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
	}

	// Default saturation and value
	const defaultSat = profile.saturation ?? 0.85;
	const defaultVal = profile.value ?? 0.95;

	let finalHue: number;
	let finalSat = defaultSat;
	let finalVal = defaultVal;

	if (profile.stops && profile.stops.length >= 2) {
		const stops = [...profile.stops].sort((a, b) => a.offset - b.offset);
		if (progress <= stops[0].offset) {
			finalHue = stops[0].h;
			finalSat = stops[0].s ?? defaultSat;
			finalVal = stops[0].v ?? defaultVal;
		} else if (progress >= stops[stops.length - 1].offset) {
			const last = stops[stops.length - 1];
			finalHue = last.h;
			finalSat = last.s ?? defaultSat;
			finalVal = last.v ?? defaultVal;
		} else {
			let i = 0;
			while (i < stops.length - 1 && stops[i + 1].offset < progress) {
				i++;
			}
			const s1 = stops[i];
			const s2 = stops[i + 1];
			const segmentSpan = s2.offset - s1.offset;
			const localT = segmentSpan > 0 ? (progress - s1.offset) / segmentSpan : 0;
			finalHue = interpolateHue(s1.h, s2.h, localT, direction);
			finalSat =
				(s1.s ?? defaultSat) +
				((s2.s ?? defaultSat) - (s1.s ?? defaultSat)) * localT;
			finalVal =
				(s1.v ?? defaultVal) +
				((s2.v ?? defaultVal) - (s1.v ?? defaultVal)) * localT;
		}
	} else {
		finalHue = interpolateHue(
			profile.startHue,
			profile.endHue,
			progress,
			direction,
		);
	}

	if (phase) {
		finalHue = (((finalHue + phase) % 1.0) + 1.0) % 1.0;
	}

	return hsvToRgb(finalHue, finalSat, finalVal);
}

/**
 * Apply HSV gradient coloring to a string.
 *
 * @param text The input text to colorize
 * @param profile Profile object or key in LOG_GRADIENTS
 * @param options Color and formatting options
 * @returns Colored string with ANSI escape codes (or original text if color is disabled)
 */
export function applyHsvFade(
	text: string,
	profile: GradientProfile | LogGradientKey,
	options: FadeOptions = {},
): string {
	const useColor = options.useColor ?? isColorSupported();
	if (!useColor || !text) {
		return text;
	}

	const resolvedProfile: GradientProfile =
		typeof profile === "string"
			? LOG_GRADIENTS[profile] || LOG_GRADIENTS.info
			: profile;

	const mode = options.mode ?? resolvedProfile.mode ?? "continuous";

	if (mode === "per-line") {
		const lines = text.split("\n");
		return lines
			.map((line) =>
				applyHsvFadeToChars(
					line,
					resolvedProfile,
					{ ...options, mode: "continuous" },
					line.length,
				),
			)
			.join("\n");
	}

	return applyHsvFadeToChars(text, resolvedProfile, options);
}

function applyHsvFadeToChars(
	text: string,
	profile: GradientProfile,
	options: FadeOptions,
	spanOverride?: number,
): string {
	const chars = [...text];
	const totalLen = spanOverride ?? Math.max(1, chars.length);
	let out = "";
	let pos = 0;

	const stylePrefix =
		(options.bold ? ANSI_BOLD : "") + (options.dim ? ANSI_DIM : "");

	let i = 0;
	let charOffset = 0;
	while (i < chars.length) {
		// Check for existing ANSI sequence
		const remainder = text.slice(charOffset);
		const ansiMatch = remainder.match(ANSI_ESCAPE_REGEX);
		if (ansiMatch) {
			out += ansiMatch[0];
			charOffset += ansiMatch[0].length;
			i += [...ansiMatch[0]].length;
			continue;
		}

		const char = chars[i];
		charOffset += char.length;
		// Skip coloring whitespace / newlines
		if (char.trim() && char.charCodeAt(0) !== 27) {
			const t = totalLen <= 1 ? 0 : pos / (totalLen - 1);
			const [r, g, b] = interpolateHsv(profile, t, options);
			out += `${stylePrefix}${rgbToAnsi(r, g, b)}${char}${ANSI_RESET}`;
			pos++;
		} else {
			out += char;
			if (options.skipWhitespace === false && char !== "\n" && char !== "\r") {
				pos++;
			}
		}
		i++;
	}

	return out;
}

/**
 * Stateful fader for streaming outputs (preserves gradient continuity across chunks).
 */
export class StreamFader {
	private position = 0;
	private readonly cycleLength: number;
	private readonly profile: GradientProfile;
	private readonly options: FadeOptions;

	constructor(
		profile: GradientProfile | LogGradientKey,
		options: StreamFaderOptions = {},
	) {
		this.profile =
			typeof profile === "string"
				? LOG_GRADIENTS[profile] || LOG_GRADIENTS.streaming
				: profile;
		this.cycleLength = options.cycleLength ?? 80;
		this.options = options;
	}

	/**
	 * Fade a stream chunk with continuous gradient progression.
	 * Preserves smooth color transitions over long texts by ping-ponging
	 * between start and end hues without abrupt resets at cycle boundaries.
	 */
	fadeChunk(chunk: string, useColor?: boolean): string {
		const enabled = useColor ?? this.options.useColor ?? isColorSupported();
		if (!enabled || !chunk) {
			return chunk;
		}

		const chars = [...chunk];
		let out = "";
		const stylePrefix =
			(this.options.bold ? ANSI_BOLD : "") + (this.options.dim ? ANSI_DIM : "");

		const cycleLength = Math.max(1, this.cycleLength);
		const mode = this.options.mode ?? this.profile.mode ?? "continuous";
		const isCircular =
			(Math.abs(this.profile.startHue - this.profile.endHue) === 1 ||
				this.profile.startHue % 1.0 === this.profile.endHue % 1.0) &&
			(this.profile.direction === "forward" ||
				this.profile.direction === "reverse");

		let i = 0;
		let charOffset = 0;
		while (i < chars.length) {
			// Check for existing ANSI sequence
			const remainder = chunk.slice(charOffset);
			const ansiMatch = remainder.match(ANSI_ESCAPE_REGEX);
			if (ansiMatch) {
				out += ansiMatch[0];
				charOffset += ansiMatch[0].length;
				i += [...ansiMatch[0]].length;
				continue;
			}

			const char = chars[i];
			charOffset += char.length;
			if (char.trim() && char.charCodeAt(0) !== 27) {
				let t: number;
				if (mode === "symmetrical") {
					const halfCycle = Math.max(0.5, cycleLength / 2);
					const phase = (this.position % cycleLength) / halfCycle;
					t = phase <= 1 ? phase : 2 - phase;
				} else if (isCircular) {
					t = (this.position % cycleLength) / cycleLength;
				} else {
					// Continuous oscillation (ping-pong) prevents harsh jumps across cycle boundaries
					const cycleSpan = cycleLength * 2;
					const phase = (this.position % cycleSpan) / cycleLength;
					t = phase <= 1 ? phase : 2 - phase;
				}

				const [r, g, b] = interpolateHsv(this.profile, t, {
					...this.options,
					mode: "continuous",
					cycle: 1,
				});
				out += `${stylePrefix}${rgbToAnsi(r, g, b)}${char}${ANSI_RESET}`;
				this.position++;
			} else {
				out += char;
			}
			i++;
		}

		return out;
	}

	/**
	 * Alias for fadeChunk.
	 */
	write(chunk: string, useColor?: boolean): string {
		return this.fadeChunk(chunk, useColor);
	}

	/**
	 * Reset position for a new stream session.
	 */
	reset(): void {
		this.position = 0;
	}

	/**
	 * Current position counter.
	 */
	getPosition(): number {
		return this.position;
	}
}

/**
 * Factory for StreamFader.
 */
export function createStreamFader(
	profile: GradientProfile | LogGradientKey = "streaming",
	options: StreamFaderOptions = {},
): StreamFader {
	return new StreamFader(profile, options);
}

/**
 * Apply a rainbow gradient to a string, coloring each visible character.
 * Retains exact backward compatibility with test/banner.test.js.
 */
export function applyRainbowText(
	text: string,
	startHue = 0,
	useColor = true,
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
 * Rebuild one banner row so its fader progresses over visible glyphs.
 * Retains exact backward compatibility with test/banner.test.js.
 */
export function applyBannerRainbow(
	line: string,
	useColor = true,
	faderWidth = line.length,
): string {
	if (!useColor) return line;

	const visibleGlyphs = line.replace(/ /g, "");
	const faderInput = visibleGlyphs.padEnd(
		Math.max(visibleGlyphs.length, faderWidth),
		" ",
	);
	const fadedGlyphs =
		applyRainbowText(faderInput, 0, useColor).match(ANSI_COLOR_TOKEN_PATTERN) ??
		[];
	let glyphIndex = 0;

	const renderedLine = line.replace(/\S/g, (char) => {
		const fadedGlyph = fadedGlyphs[glyphIndex++] ?? char;
		const rainbowBackground = fadedGlyph.match(
			ANSI_RGB_FOREGROUND_PATTERN,
		)?.[1];
		if (!rainbowBackground) return char;

		return `\x1b[48;2;${rainbowBackground}m${ANSI_BLACK_BANNER_FOREGROUND}${char}${ANSI_RESET}${ANSI_LIGHT_BANNER_BACKGROUND}`;
	});
	return `${ANSI_LIGHT_BANNER_BACKGROUND}${renderedLine}${ANSI_RESET}`;
}
