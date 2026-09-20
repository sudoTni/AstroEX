import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogsDirectory } from "../runtimePaths";

export type LlmPayloadLogStage =
	| "jobCloth"
	| "remoteEval"
	| "jobJudge"
	| "makeMaterials";

export const LLM_PAYLOAD_LOG_DIRECTORIES: Record<LlmPayloadLogStage, string> = {
	jobCloth: "jc_payload_logs",
	remoteEval: "re_payload_logs",
	jobJudge: "jj_payload_logs",
	makeMaterials: "mm_payload_logs",
};

const STAGE_PREFIXES: Record<LlmPayloadLogStage, string> = {
	jobCloth: "jc_payload",
	remoteEval: "re_payload",
	jobJudge: "jj_payload",
	makeMaterials: "mm_payload",
};

let payloadSequence = 0;

function timestampForFile(date = new Date()): string {
	return date.toISOString().replace(/[-:.]/g, "");
}

/** Persists the already-assembled JSON body for one outbound LLM API request. */
export async function writeLlmPayloadLog(
	stage: LlmPayloadLogStage,
	payload: unknown,
): Promise<string> {
	const serializedPayload = JSON.stringify(payload, null, 2);
	if (serializedPayload === undefined) {
		throw new TypeError("LLM request payload is not JSON-serializable");
	}
	const directory = path.join(
		getLogsDirectory(),
		LLM_PAYLOAD_LOG_DIRECTORIES[stage],
	);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	payloadSequence += 1;
	const fileName = [
		STAGE_PREFIXES[stage],
		timestampForFile(),
		`p${process.pid}`,
		`c${String(payloadSequence).padStart(6, "0")}`,
		crypto.randomUUID(),
	].join("_");
	const filePath = path.join(directory, `${fileName}.json`);
	await fs.writeFile(filePath, serializedPayload, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	return filePath;
}
