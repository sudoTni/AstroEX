const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let activeSpinnerCount = 0;

export interface SpinnerOptions {
	enabled?: boolean;
	intervalMs?: number;
	addNewline?: boolean;
}

/**
 * Clears an active spinner before another message is written to stdout.
 * The spinner's next frame will be rendered below that message.
 */
export function clearActiveSpinnerLine(): void {
	if (activeSpinnerCount > 0 && process.stdout.isTTY === true) {
		process.stdout.write("\r\x1b[2K");
	}
}

/**
 * Runs an asynchronous operation while displaying a single-line terminal spinner.
 * Animation is disabled when stdout is redirected or live LLM streaming is enabled.
 */
export async function withSpinner<T>(
	message: string,
	operation: () => Promise<T>,
	options: SpinnerOptions = {},
): Promise<T> {
	// Start the operation first so any synchronous request logging is printed before
	// the spinner begins rendering on the current terminal line.
	const pendingOperation = operation();
	const canAnimate = options.enabled !== false && process.stdout.isTTY === true;

	if (!canAnimate) {
		return await pendingOperation;
	}

	const intervalMs = options.intervalMs ?? 80;
	const normalizedMessage = message.replace(/\s+/g, " ").trim();
	let frameIndex = 0;

	const render = () => {
		const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
		frameIndex++;
		process.stdout.write(`\r\x1b[2K${frame} ${normalizedMessage}`);
	};

	activeSpinnerCount++;
	render();
	const timer = setInterval(render, intervalMs);

	try {
		return await pendingOperation;
	} finally {
		clearInterval(timer);
		activeSpinnerCount--;
		process.stdout.write("\r\x1b[2K");
		if (options.addNewline) {
			process.stdout.write("\n");
		}
	}
}
