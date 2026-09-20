import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { abortableDelay, throwIfCancelled } from "./pipelineCancellation";
import { createLogger } from "./utils";

export const DEFAULT_WATCHDOG_TARGET = "8.8.8.8";
export const WATCHDOG_INTERVAL_MS = 5_000;
export const WATCHDOG_PROBE_TIMEOUT_MS = 3_000;
export const WATCHDOG_FAILURE_THRESHOLD = 3;
export const WATCHDOG_STARTUP_ATTEMPTS = 3;
export const WATCHDOG_STARTUP_RETRY_DELAY_MS = 2_000;

const logger = createLogger("InternetWatchdog");

export class InternetWatchdogCapabilityError extends Error {
	readonly code = "INTERNET_WATCHDOG_UNAVAILABLE";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "InternetWatchdogCapabilityError";
	}
}

export class InternetWatchdogStartupError extends Error {
	readonly code = "INTERNET_WATCHDOG_STARTUP_FAILED";

	constructor(
		message: string,
		public readonly target: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "InternetWatchdogStartupError";
	}
}

export class InternetConnectivityLostError extends Error {
	readonly code = "INTERNET_WATCHDOG_CONNECTIVITY_LOST";

	constructor(
		public readonly target: string,
		public readonly consecutiveFailures: number,
		public readonly outageDurationMs: number,
		options?: ErrorOptions,
	) {
		super(
			`Internet watchdog lost contact with ${target} after ${consecutiveFailures} consecutive probe failures (${Math.ceil(outageDurationMs / 1000)}s).`,
			options,
		);
		this.name = "InternetConnectivityLostError";
	}
}

export interface ConnectivityProbe {
	probe(
		target: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<void>;
}

function isValidHostname(value: string): boolean {
	if (value.length > 253 || value.endsWith(".")) return false;
	const labels = value.split(".");
	return labels.every(
		(label) =>
			label.length >= 1 &&
			label.length <= 63 &&
			/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
	);
}

export function validateAndNormalizeProbeTarget(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("--internet-watchdog must be an IP address or hostname");
	}
	const target = value.trim();
	if (!target || /\s/.test(target) || target.startsWith("-")) {
		throw new Error(
			"--internet-watchdog must be a valid IP address or hostname",
		);
	}
	if (isIP(target)) return target.toLowerCase();
	if (target.includes(":") || target.includes("/") || target.includes("?")) {
		throw new Error(
			"--internet-watchdog accepts a hostname or IP address, not a URL or host:port value",
		);
	}
	const ascii = domainToASCII(target).toLowerCase();
	if (!ascii || !isValidHostname(ascii)) {
		throw new Error(
			`Invalid internet watchdog target: ${JSON.stringify(value)}`,
		);
	}
	return ascii;
}

function pingInvocation(target: string): { command: string; args: string[] } {
	if (process.platform === "win32") {
		return { command: "ping", args: ["-n", "1", target] };
	}
	if (process.platform === "darwin" && isIP(target) === 6) {
		return { command: "ping6", args: ["-c", "1", target] };
	}
	return {
		command: "ping",
		args: [...(isIP(target) === 6 ? ["-6"] : []), "-c", "1", target],
	};
}

export class SystemPingProbe implements ConnectivityProbe {
	async probe(
		target: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<void> {
		throwIfCancelled(options.signal);
		const invocation = pingInvocation(target);

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let forcedError: Error | undefined;
			const timeoutRef: { current?: NodeJS.Timeout } = {};
			const complete = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (timeoutRef.current) clearTimeout(timeoutRef.current);
				options.signal?.removeEventListener("abort", onAbort);
				callback();
			};
			const child = execFile(
				invocation.command,
				invocation.args,
				{ windowsHide: true, maxBuffer: 64 * 1024 },
				(error) => {
					if (forcedError) {
						return complete(() => reject(forcedError));
					}
					if (!error) return complete(resolve);
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
						return complete(() =>
							reject(
								new InternetWatchdogCapabilityError(
									`Internet watchdog cannot execute ${invocation.command}: ${error.message}`,
									{ cause: error },
								),
							),
						);
					}
					complete(() => reject(error));
				},
			);
			const onAbort = () => {
				if (settled) return;
				forcedError =
					options.signal?.reason instanceof Error
						? options.signal.reason
						: new Error("Internet watchdog probe cancelled");
				child.kill();
			};
			timeoutRef.current = setTimeout(() => {
				forcedError = new Error(
					`Probe to ${target} timed out after ${options.timeoutMs}ms`,
				);
				child.kill();
			}, options.timeoutMs);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();
		});
	}
}

export interface InternetWatchdogOptions {
	target: string;
	intervalMs?: number;
	probeTimeoutMs?: number;
	failureThreshold?: number;
	startupAttempts?: number;
	startupRetryDelayMs?: number;
	probe?: ConnectivityProbe;
	onConnectivityLost: (error: InternetConnectivityLostError) => void;
}

export class InternetWatchdog {
	private readonly target: string;
	private readonly intervalMs: number;
	private readonly probeTimeoutMs: number;
	private readonly failureThreshold: number;
	private readonly startupAttempts: number;
	private readonly startupRetryDelayMs: number;
	private readonly probe: ConnectivityProbe;
	private readonly onConnectivityLost: InternetWatchdogOptions["onConnectivityLost"];
	private readonly stopController = new AbortController();
	private loopPromise?: Promise<void>;
	private stopped = false;

	constructor(options: InternetWatchdogOptions) {
		this.target = validateAndNormalizeProbeTarget(options.target);
		this.intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
		this.probeTimeoutMs = options.probeTimeoutMs ?? WATCHDOG_PROBE_TIMEOUT_MS;
		this.failureThreshold =
			options.failureThreshold ?? WATCHDOG_FAILURE_THRESHOLD;
		this.startupAttempts = options.startupAttempts ?? WATCHDOG_STARTUP_ATTEMPTS;
		this.startupRetryDelayMs =
			options.startupRetryDelayMs ?? WATCHDOG_STARTUP_RETRY_DELAY_MS;
		this.probe = options.probe ?? new SystemPingProbe();
		this.onConnectivityLost = options.onConnectivityLost;
	}

	async validateStartup(signal?: AbortSignal): Promise<void> {
		for (let attempt = 1; attempt <= this.startupAttempts; attempt++) {
			throwIfCancelled(signal);
			try {
				await this.probe.probe(this.target, {
					timeoutMs: this.probeTimeoutMs,
					signal,
				});
				logger.info(`Internet watchdog activated for ${this.target}.`, {
					target: this.target,
					probeIntervalMs: this.intervalMs,
					probeTimeoutMs: this.probeTimeoutMs,
					failureThreshold: this.failureThreshold,
				});
				return;
			} catch (error) {
				throwIfCancelled(signal);
				if (error instanceof InternetWatchdogCapabilityError) throw error;
				logger.warn(
					`Initial internet watchdog probe ${attempt}/${this.startupAttempts} failed for ${this.target}.`,
					{ target: this.target, attempt, error: String(error) },
				);
				if (attempt < this.startupAttempts) {
					await abortableDelay(this.startupRetryDelayMs, signal);
				}
			}
		}
		throw new InternetWatchdogStartupError(
			`Internet watchdog target ${this.target} was unreachable during startup after ${this.startupAttempts} attempts.`,
			this.target,
		);
	}

	start(signal?: AbortSignal): void {
		if (this.loopPromise || this.stopped) return;
		this.loopPromise = this.runLoop(signal);
	}

	private async runLoop(signal?: AbortSignal): Promise<void> {
		let consecutiveFailures = 0;
		let outageStartedAt = 0;
		while (!this.stopped && !signal?.aborted) {
			try {
				await abortableDelay(this.intervalMs, this.stopController.signal);
				throwIfCancelled(signal);
				await this.probe.probe(this.target, {
					timeoutMs: this.probeTimeoutMs,
					signal: this.stopController.signal,
				});
				if (consecutiveFailures > 0) {
					logger.info(
						`Internet watchdog connectivity restored for ${this.target}.`,
						{
							target: this.target,
							failedProbes: consecutiveFailures,
							outageDurationMs: Date.now() - outageStartedAt,
						},
					);
				}
				consecutiveFailures = 0;
				outageStartedAt = 0;
			} catch (error) {
				if (
					this.stopped ||
					this.stopController.signal.aborted ||
					signal?.aborted
				) {
					return;
				}
				if (outageStartedAt === 0) outageStartedAt = Date.now();
				consecutiveFailures++;
				logger.warn(
					`Internet watchdog probe failed for ${this.target} (${consecutiveFailures}/${this.failureThreshold}).`,
					{ target: this.target, consecutiveFailures, error: String(error) },
				);
				if (
					error instanceof InternetWatchdogCapabilityError ||
					consecutiveFailures >= this.failureThreshold
				) {
					const connectivityError = new InternetConnectivityLostError(
						this.target,
						consecutiveFailures,
						Date.now() - outageStartedAt,
						{ cause: error },
					);
					logger.error(connectivityError.message, connectivityError);
					this.onConnectivityLost(connectivityError);
					return;
				}
			}
		}
	}

	async stop(): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.stopController.abort(new Error("Internet watchdog stopped"));
		}
		await this.loopPromise;
	}
}
