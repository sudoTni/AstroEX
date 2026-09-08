/**
 * AstroEX Logging System - Transports
 *
 * Console and File output transports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { clearActiveSpinnerLine } from "../utils/spinner";
import type { LogRecord } from "./types";

export interface Transport {
	write(record: LogRecord, formatted: string): void;
}

export class ConsoleTransport implements Transport {
	write(record: LogRecord, formatted: string): void {
		try {
			clearActiveSpinnerLine();
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

export class FileTransport implements Transport {
	private stream: fs.WriteStream | null = null;
	private filePath: string | null = null;

	initialize(logDir: string, fileName: string, commandName?: string): string {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
			this.filePath = null;
		}

		const fullLogDir = path.resolve(logDir);
		if (!fs.existsSync(fullLogDir)) {
			fs.mkdirSync(fullLogDir, { recursive: true });
		}

		const finalFileName = commandName ? `${commandName}_${fileName}` : fileName;
		this.filePath = path.join(fullLogDir, finalFileName);
		this.stream = fs.createWriteStream(this.filePath, {
			flags: "a",
			mode: 0o600,
		});

		this.stream.on("error", (err) => {
			process.stderr.write(
				`[AstroEX] Error writing to log file ${this.filePath}: ${String(err)}\n`,
			);
		});

		return this.filePath;
	}

	getFilePath(): string | null {
		return this.filePath;
	}

	write(_record: LogRecord, jsonLine: string): void {
		if (this.stream?.writable) {
			try {
				this.stream.write(`${jsonLine}\n`);
			} catch (err) {
				process.stderr.write(
					`[AstroEX] Failed to write file log: ${String(err)}\n`,
				);
			}
		}
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.stream) {
				const currentStream = this.stream;
				this.stream = null;
				this.filePath = null;

				currentStream.on("finish", () => {
					resolve();
				});
				currentStream.on("error", (err) => {
					reject(err);
				});
				currentStream.end();
			} else {
				resolve();
			}
		});
	}
}
