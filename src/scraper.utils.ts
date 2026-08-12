import type { Page } from "puppeteer";
import { type Observable, defer, throwError, timer } from "rxjs";
import { fromPromise } from "rxjs/internal-compatibility";
import { finalize, mergeMap } from "rxjs/operators";
import { log } from "./utils";

export const genericRetryStrategy =
	({
		maxRetryAttempts = 3,
		scalingDuration = 1000,
		excludedStatusCodes = [],
	}: {
		maxRetryAttempts?: number;
		scalingDuration?: number;
		excludedStatusCodes?: number[];
	} = {}) =>
	(attempts: Observable<unknown>) => {
		return attempts.pipe(
			mergeMap((error, i) => {
				const retryAttempt = i + 1;
				// if maximum number of retries have been met
				// or response is a status code we don't wish to retry, throw error
				if (retryAttempt > maxRetryAttempts) {
					return throwError(error);
				}
				// If excluded status codes provided and error has numeric .status, do not retry
				if (
					excludedStatusCodes.length > 0 &&
					typeof error === "object" &&
					error !== null &&
					"status" in (error as { status?: unknown }) &&
					typeof (error as { status?: unknown }).status === "number" &&
					excludedStatusCodes.find(
						(e) => e === (error as { status?: number }).status,
					)
				) {
					return throwError(error);
				}
				log("Retry", "Scheduling retry", "warn", {
					attempt: retryAttempt,
					delayMs: retryAttempt * scalingDuration,
				});
				// retry after 1s, 2s, etc...
				return timer(retryAttempt * scalingDuration);
			}),
			finalize(() => log("Retry", "Retry sequence finished", "debug")),
		);
	};

export const retryStrategyByCondition =
	({
		maxRetryAttempts = 3,
		scalingDuration = 1000,
		retryConditionFn = (_error) => true,
	}: {
		maxRetryAttempts?: number;
		scalingDuration?: number;
		retryConditionFn?: (error: unknown) => boolean;
	} = {}) =>
	(attempts: Observable<unknown>) => {
		return attempts.pipe(
			mergeMap((error, i) => {
				const retryAttempt = i + 1;
				if (
					retryAttempt > maxRetryAttempts ||
					(retryConditionFn && !retryConditionFn(error))
				) {
					return throwError(error);
				}
				log("Retry", "Scheduling conditional retry", "warn", {
					attempt: retryAttempt,
					delayMs: retryAttempt * scalingDuration,
				});
				// retry after 1s, 2s, etc...
				return timer(retryAttempt * scalingDuration);
			}),
			finalize(() =>
				log("Retry", "Conditional retry sequence finished", "debug"),
			),
		);
	};

export function getPageLocationOperator(page: Page): Observable<string> {
	return defer(() =>
		fromPromise(page.evaluate(() => Promise.resolve(location.href))),
	);
}
