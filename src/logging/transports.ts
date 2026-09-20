/**
 * AstroEX Logging System - Transports
 *
 * Console output transport.
 */

import type { LogRecord } from "./types";

export interface Transport {
	write(record: LogRecord, formatted: string): void;
}

export class ConsoleTransport implements Transport {
	write(record: LogRecord, formatted: string): void {
		try {
			if (
				record.level === "error" ||
				record.level === "fatal" ||
				record.level === "warn"
			) {
				process.stderr.write(`${formatted}\n`);
			} else {
				process.stdout.write(`${formatted}\n`);
			}
		} catch {
			// Fail-safe fallback to standard console
			if (record.level === "error" || record.level === "fatal") {
				console.error(formatted);
			} else if (record.level === "warn") {
				console.warn(formatted);
			} else {
				console.log(formatted);
			}
		}
	}
}
