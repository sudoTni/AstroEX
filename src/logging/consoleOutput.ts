/**
 * Explicit exceptions to formatted log output.
 *
 * JSON results are a machine-readable CLI contract and intentionally remain
 * uncoloured. Internal failures use the HSV error profile and always reset.
 */

import { applyHsvFade, isColorSupported } from "./fader";

export function writeMachineJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeInternalConsoleFailure(message: string): void {
	process.stderr.write(
		`${applyHsvFade(message, "error", {
			useColor: isColorSupported(),
			mode: "per-line",
		})}\n`,
	);
}

/** Re-emit a child process stream without letting it bypass terminal styling. */
export function writeExternalCommandOutput(
	output: string | Buffer | undefined,
	stream: "stdout" | "stderr",
): void {
	if (!output) return;
	const text = String(output);
	if (!text) return;
	const formatted = applyHsvFade(
		text,
		stream === "stderr" ? "error" : "activity",
		{ useColor: isColorSupported(), mode: "per-line" },
	);
	process[stream].write(formatted);
}
