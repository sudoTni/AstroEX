import { setTimeout as delay } from "node:timers/promises";

export type PipelineSignalName = "SIGINT" | "SIGTERM";

export type PipelineCancellationCause =
	| { kind: "watchdog"; error: Error }
	| { kind: "signal"; signal: PipelineSignalName; error: Error };

export class PipelineCancellationController {
	private readonly controller = new AbortController();
	private currentCause?: PipelineCancellationCause;
	private finished = false;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get cause(): PipelineCancellationCause | undefined {
		return this.currentCause;
	}

	cancel(cause: PipelineCancellationCause): boolean {
		if (this.finished || this.currentCause) return false;
		this.currentCause = cause;
		this.controller.abort(cause.error);
		return true;
	}

	finish(): void {
		this.finished = true;
	}
}

export function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new Error(String(signal.reason ?? "Operation cancelled"));
	}
}

export function rethrowIfCancelled(
	_error: unknown,
	signal?: AbortSignal,
): void {
	if (signal?.aborted) throwIfCancelled(signal);
}

export async function abortableDelay(
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	if (milliseconds <= 0) {
		throwIfCancelled(signal);
		return;
	}
	if (!signal) {
		await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
		return;
	}
	await delay(milliseconds, undefined, { signal });
}
