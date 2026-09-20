import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripAnsi } from "./fader";
import { LLM_PAYLOAD_LOG_DIRECTORIES } from "./payloadLogs";

type WritableStream = NodeJS.WriteStream;
type WriteMethod = NodeJS.WriteStream["write"];

function safeIdentifier(value: string): string {
	const sanitized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "command";
}

function timestampForFile(date = new Date()): string {
	return date.toISOString().replace(/[-:.]/g, "");
}

function commandIdentifier(args: string[]): string {
	return safeIdentifier(
		args.find((argument) => !argument.startsWith("-")) ?? "cli",
	);
}

function chunkToString(
	chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
): string {
	if (typeof chunk === "string") return chunk;
	const encoding =
		typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
	return Buffer.from(chunk).toString(encoding);
}

/**
 * Mirrors stdout and stderr to one execution-scoped, ANSI-free file without
 * changing the bytes, return values, or callbacks seen by either console stream.
 */
export class ExecutionLog {
	private fileDescriptor: number | undefined;
	private filePath: string | undefined;
	private originalStdoutWrite: WriteMethod | undefined;
	private originalStderrWrite: WriteMethod | undefined;

	initialize(logDirectory: string, args = process.argv.slice(2)): string {
		if (this.fileDescriptor !== undefined && this.filePath)
			return this.filePath;

		const resolvedDirectory = path.resolve(logDirectory);
		fs.mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
		for (const subdirectory of Object.values(LLM_PAYLOAD_LOG_DIRECTORIES)) {
			fs.mkdirSync(path.join(resolvedDirectory, subdirectory), {
				recursive: true,
				mode: 0o700,
			});
		}
		const fileName = [
			"astroex",
			commandIdentifier(args),
			timestampForFile(),
			`p${process.pid}`,
			crypto.randomUUID(),
		].join("_");
		this.filePath = path.join(resolvedDirectory, `${fileName}.log`);
		this.fileDescriptor = fs.openSync(this.filePath, "wx", 0o600);

		this.originalStdoutWrite = process.stdout.write;
		this.originalStderrWrite = process.stderr.write;
		process.stdout.write = this.createMirroredWrite(
			process.stdout,
			this.originalStdoutWrite,
		);
		process.stderr.write = this.createMirroredWrite(
			process.stderr,
			this.originalStderrWrite,
		);

		return this.filePath;
	}

	getFilePath(): string | undefined {
		return this.filePath;
	}

	close(): void {
		if (this.originalStdoutWrite) {
			process.stdout.write = this.originalStdoutWrite;
			this.originalStdoutWrite = undefined;
		}
		if (this.originalStderrWrite) {
			process.stderr.write = this.originalStderrWrite;
			this.originalStderrWrite = undefined;
		}
		if (this.fileDescriptor !== undefined) {
			const fileDescriptor = this.fileDescriptor;
			try {
				if (this.filePath) {
					const contents = fs.readFileSync(this.filePath, "utf8");
					const plainText = stripAnsi(contents);
					if (plainText !== contents) {
						fs.ftruncateSync(fileDescriptor, 0);
						fs.writeSync(fileDescriptor, plainText, 0, "utf8");
					}
				}
				fs.fsyncSync(fileDescriptor);
			} finally {
				fs.closeSync(fileDescriptor);
				this.fileDescriptor = undefined;
			}
		}
		this.filePath = undefined;
	}

	private createMirroredWrite(
		stream: WritableStream,
		originalWrite: WriteMethod,
	): WriteMethod {
		return ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			if (this.fileDescriptor !== undefined) {
				try {
					const plainText = stripAnsi(chunkToString(chunk, encodingOrCallback));
					if (plainText) fs.writeSync(this.fileDescriptor, plainText);
				} catch {
					// File failures must never alter or suppress the original console write.
				}
			}
			return originalWrite.call(
				stream,
				chunk as never,
				encodingOrCallback as never,
				callback as never,
			);
		}) as WriteMethod;
	}
}

const executionLog = new ExecutionLog();

export function initializeExecutionLog(
	logDirectory: string,
	args?: string[],
): string {
	return executionLog.initialize(logDirectory, args);
}

export function getExecutionLogFilePath(): string | undefined {
	return executionLog.getFilePath();
}

export function closeExecutionLog(): void {
	executionLog.close();
}
