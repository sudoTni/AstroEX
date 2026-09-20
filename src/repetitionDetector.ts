/**
 * AstroEX - Stream Repetition Detector
 *
 * Incrementally inspects streamed text (specifically reasoning tokens / chain-of-thought)
 * for pathological periodic repetition loops to abort runaway model generations early.
 *
 * @author tjenkel
 * @license MIT
 */

import { AppError } from "./utils";

export interface RepetitionDetectorOptions {
	/** Maximum number of recent characters to retain in the sliding window. Default: 1024 */
	maxWindowChars?: number;
	/** Maximum repeating period (in characters) to test for. Default: 128 */
	maxPeriod?: number;
	/** Minimum total repeated characters required to declare a loop. Default: 64 */
	minTotalChars?: number;
}

export interface RepetitionMatch {
	detected: boolean;
	period: number;
	repeats: number;
	repeatedText: string;
	totalChars: number;
}

export interface RepetitionErrorDetails {
	provider: string;
	model: string;
	period: number;
	repeats: number;
	repeatedText: string;
	totalChars: number;
	attempt?: number;
}

export class PathologicalReasoningRepetitionError extends AppError {
	readonly isRetryable = true;

	constructor(
		public readonly details: RepetitionErrorDetails,
		options?: ErrorOptions,
	) {
		const snippet = details.repeatedText.replace(/\n/g, "\\n");
		super(
			"PATHOLOGICAL_REASONING_REPETITION",
			500,
			`Pathological reasoning repetition detected for ${details.provider}/${details.model}: "${snippet}" repeated ${details.repeats} times (period=${details.period}, chars=${details.totalChars}).`,
			details,
		);
		this.name = "PathologicalReasoningRepetitionError";
	}

	get period(): number {
		return this.details.period;
	}

	get repeats(): number {
		return this.details.repeats;
	}

	get repeatedText(): string {
		return this.details.repeatedText;
	}

	get totalChars(): number {
		return this.details.totalChars;
	}

	get attempt(): number | undefined {
		return this.details.attempt;
	}
}

export class StreamRepetitionDetector {
	private buffer = "";
	private readonly maxWindowChars: number;
	private readonly maxPeriod: number;
	private readonly minTotalChars: number;
	private totalCharsSeen = 0;

	private lastMatch?: RepetitionMatch;

	constructor(options: RepetitionDetectorOptions = {}) {
		this.maxWindowChars = options.maxWindowChars ?? 1024;
		this.maxPeriod = options.maxPeriod ?? 128;
		this.minTotalChars = options.minTotalChars ?? 64;
	}

	/** Reset state for a new request or stream attempt */
	reset(): void {
		this.buffer = "";
		this.totalCharsSeen = 0;
		this.lastMatch = undefined;
	}

	/** Total characters processed across all chunks in this stream session */
	get totalObserved(): number {
		return this.totalCharsSeen;
	}

	/** Current buffered text length in the sliding window */
	get bufferedLength(): number {
		return this.buffer.length;
	}

	/** The last detected repetition match, if any */
	get currentMatch(): RepetitionMatch | undefined {
		return this.lastMatch;
	}

	/**
	 * Creates a PathologicalReasoningRepetitionError based on the latest detected repetition.
	 */
	createError(
		provider: string,
		model: string,
		attempt?: number,
	): PathologicalReasoningRepetitionError {
		const match = this.lastMatch ?? {
			period: 0,
			repeats: 0,
			repeatedText: "",
			totalChars: 0,
		};
		return new PathologicalReasoningRepetitionError({
			provider,
			model,
			period: match.period,
			repeats: match.repeats,
			repeatedText: match.repeatedText,
			totalChars: match.totalChars,
			attempt,
		});
	}

	/**
	 * Feed a new text chunk and check for pathological repetition.
	 * Returns a RepetitionMatch with detected=true if a periodic loop is found.
	 */
	feed(chunk: string): RepetitionMatch {
		if (!chunk) {
			return {
				detected: false,
				period: 0,
				repeats: 0,
				repeatedText: "",
				totalChars: 0,
			};
		}

		this.totalCharsSeen += chunk.length;
		this.buffer += chunk;
		if (this.buffer.length > this.maxWindowChars) {
			this.buffer = this.buffer.slice(-this.maxWindowChars);
		}

		const bufLen = this.buffer.length;
		const maxP = Math.min(this.maxPeriod, Math.floor(bufLen / 2));

		// Scan candidate periods from smallest to largest to find the fundamental period first
		for (let p = 1; p <= maxP; p++) {
			// Fast path check: do the characters at the boundary even match?
			if (
				this.buffer.charCodeAt(bufLen - 1) !==
				this.buffer.charCodeAt(bufLen - 1 - p)
			) {
				continue;
			}

			// Count consecutive matching characters backwards from the end
			let matchedChars = 0;
			const maxLookback = bufLen - p;
			for (let i = 0; i < maxLookback; i++) {
				if (
					this.buffer.charCodeAt(bufLen - 1 - i) ===
					this.buffer.charCodeAt(bufLen - 1 - p - i)
				) {
					matchedChars++;
				} else {
					break;
				}
			}

			const totalChars = matchedChars + p;
			const repeats = Math.floor(totalChars / p);
			const pattern = this.buffer.slice(bufLen - p);

			// Check against period-specific pathological thresholds
			if (this.isPathological(p, repeats, totalChars, pattern)) {
				const match = {
					detected: true,
					period: p,
					repeats,
					repeatedText: pattern,
					totalChars,
				};
				this.lastMatch = match;
				return match;
			}
		}

		return {
			detected: false,
			period: 0,
			repeats: 0,
			repeatedText: "",
			totalChars: 0,
		};
	}

	private isPathological(
		period: number,
		repeats: number,
		totalChars: number,
		pattern: string,
	): boolean {
		if (period === 1) {
			const ch = pattern[0];
			// Pure whitespace (spaces, tabs, newlines)
			if (/\s/.test(ch)) {
				return repeats >= 80;
			}
			// Punctuation / markdown divider symbols (hyphens, equals, asterisks, etc.)
			if (!/[a-zA-Z0-9]/.test(ch)) {
				return repeats >= 80;
			}
			// Alphanumeric letters or digits (e.g. 'aaaa...')
			return repeats >= 40;
		}

		if (period === 2) {
			// e.g. "..", "=-", "ab"
			return repeats >= 24 && totalChars >= 48;
		}

		// Minimum total characters requirement (overall floor for p >= 3)
		if (totalChars < this.minTotalChars) {
			return false;
		}

		if (period >= 3 && period <= 8) {
			// e.g. "lock" (p=4), "word " (p=5), "thinking" (p=8)
			// For "lock": repeats >= 8 && totalChars >= 64 -> triggers at 16 repeats (64 chars)
			return repeats >= 8 && totalChars >= 64;
		}

		if (period >= 9 && period <= 32) {
			// e.g. "let me verify " (p=14), "the candidate has " (p=18)
			return repeats >= 4 && totalChars >= 72;
		}

		// period >= 33 (long phrases, sentences, or structured clauses)
		return repeats >= 3 && totalChars >= 120;
	}
}
