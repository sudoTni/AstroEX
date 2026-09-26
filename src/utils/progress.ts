import type { LogContext, Logger } from "../logging";

const DEFAULT_MAX_PROGRESS_UPDATES = 12;

export interface ProgressReporterOptions {
	label: string;
	unitLabel: string;
	totalUnits?: number;
	phase?: string;
	maxUpdates?: number;
}

export interface ProgressCompletionOptions {
	level?: "info" | "warn";
	suffix?: string;
}

/**
 * Emit concise, completion-bound progress through the standard logger.
 *
 * A known total is throttled to preserve terminal readability; an unknown total
 * is reported incrementally without fabricating a percentage.
 */
export function createProgressReporter(
	logger: Logger,
	{
		label,
		unitLabel,
		totalUnits,
		phase = "progress",
		maxUpdates = DEFAULT_MAX_PROGRESS_UPDATES,
	}: ProgressReporterOptions,
) {
	const total =
		totalUnits === undefined ? undefined : Math.max(0, Math.floor(totalUnits));
	const hasKnownTotal = total !== undefined;
	const reportEvery =
		hasKnownTotal && total > 0 ? Math.max(1, Math.ceil(total / maxUpdates)) : 1;
	let started = false;
	let completed = 0;
	let lastReported = 0;

	const start = (context: LogContext = {}): void => {
		if (started) return;
		started = true;
		const description = hasKnownTotal
			? `${total} planned ${unitLabel}${total === 1 ? "" : "s"}`
			: `completed ${unitLabel}s; total is determined after eligibility checks`;
		logger.info(`${label} ${phase} initialized — tracking ${description}.`, {
			...(hasKnownTotal ? { totalUnits: total } : {}),
			unitLabel,
			...context,
		});
	};

	const complete = (
		context: LogContext = {},
		options: ProgressCompletionOptions = {},
	): void => {
		start();
		completed++;
		const shouldReport =
			!hasKnownTotal ||
			completed === 1 ||
			completed === total ||
			completed - lastReported >= reportEvery;
		if (!shouldReport) return;

		lastReported = completed;
		const percentComplete =
			hasKnownTotal && total > 0
				? Math.round((completed / total) * 100)
				: undefined;
		const suffix = options.suffix ? ` (${options.suffix})` : "";
		const message = hasKnownTotal
			? `${label} ${phase} — ${unitLabel} ${completed}/${total} complete (${percentComplete}%)${suffix}.`
			: `${label} ${phase} — ${unitLabel} ${completed} complete${suffix}.`;
		const logContext: LogContext = {
			completedUnits: completed,
			unitLabel,
			...(hasKnownTotal ? { totalUnits: total, percentComplete } : {}),
			...context,
		};
		if (options.level === "warn") logger.warn(message, logContext);
		else logger.info(message, logContext);
	};

	return { start, complete };
}
