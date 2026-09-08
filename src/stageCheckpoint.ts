import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JOB_DB_RETENTION_MS } from "./constants";
import { JobRepository, type StageCheckpointRecord } from "./jobRepository";
import { getDataDirectory } from "./runtimePaths";
import { createLogger } from "./utils";

const logger = createLogger("StageCheckpoint");

export async function computeFileHash(filePath: string): Promise<string> {
	try {
		const content = await fs.readFile(filePath);
		return crypto.createHash("sha256").update(content).digest("hex");
	} catch (error) {
		throw new Error(
			`Failed to compute hash for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function computeContentHash(content: string | Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

let repositoryInstance: JobRepository | undefined;

export async function getSharedJobRepository(): Promise<JobRepository> {
	if (repositoryInstance) return repositoryInstance;
	repositoryInstance = new JobRepository({
		dbFilePath: path.join(getDataDirectory(), "jobDB.sqlite"),
		defaultExpirationMs: JOB_DB_RETENTION_MS,
		enableJobDB: true,
	});
	await repositoryInstance.initialize();
	return repositoryInstance;
}

export interface CheckpointMatch {
	hasMatchingWork: boolean;
	isCompleted: boolean;
	inputHash: string;
	outputHash?: string;
	processedJobIds: Set<string>;
	checkpoint?: StageCheckpointRecord;
}

/**
 * Checks if matching work exists in JobRepository for the given stage, input artifact, preset, and model.
 */
export async function checkStageCheckpoint(
	stage: "jobCloth" | "jobJudge" | "makeMaterials" | string,
	inputPath: string,
	outputPath: string,
	preset: string,
	model: string,
	repository?: JobRepository,
): Promise<CheckpointMatch> {
	const repo = repository ?? (await getSharedJobRepository());
	let inputHash: string;
	try {
		inputHash = await computeFileHash(inputPath);
	} catch (error) {
		return {
			hasMatchingWork: false,
			isCompleted: false,
			inputHash: "",
			processedJobIds: new Set(),
		};
	}

	const existing = repo.getStageCheckpoint(stage, inputHash, preset, model);
	if (!existing) {
		return {
			hasMatchingWork: false,
			isCompleted: false,
			inputHash,
			processedJobIds: new Set(),
		};
	}

	const processedJobIds = new Set(existing.processedJobIds);

	// Check if completed and output file still exists with matching hash
	if (existing.status === "completed" && existing.outputHash) {
		try {
			const currentOutputHash = await computeFileHash(
				existing.outputPath || outputPath,
			);
			if (currentOutputHash === existing.outputHash) {
				logger.debug("Durable checkpoint match found", {
					stage,
					preset,
					model,
					completed: true,
				});
				return {
					hasMatchingWork: true,
					isCompleted: true,
					inputHash,
					outputHash: existing.outputHash,
					processedJobIds,
					checkpoint: existing,
				};
			}
		} catch {
			// Output file was deleted or cannot be hashed
		}
	}

	return {
		hasMatchingWork: processedJobIds.size > 0,
		isCompleted: false,
		inputHash,
		processedJobIds,
		checkpoint: existing,
	};
}

/**
 * Initializes or updates an in-progress stage checkpoint.
 */
export async function initStageCheckpoint(
	stage: "jobCloth" | "jobJudge" | "makeMaterials" | string,
	inputPath: string,
	inputHash: string,
	outputPath: string,
	preset: string,
	model: string,
	totalJobs: number,
	processedJobIds: string[] = [],
	repository?: JobRepository,
): Promise<void> {
	const repo = repository ?? (await getSharedJobRepository());
	const now = Date.now();
	repo.saveStageCheckpoint({
		stage,
		inputPath,
		inputHash,
		outputPath,
		preset,
		model,
		status: "in_progress",
		processedJobIds,
		completedJobs: processedJobIds.length,
		totalJobs,
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Marks a stage checkpoint as fully completed and saves output hash.
 */
export async function completeStageCheckpoint(
	stage: "jobCloth" | "jobJudge" | "makeMaterials" | string,
	inputHash: string,
	outputPath: string,
	preset: string,
	model: string,
	completedJobs: number,
	repository?: JobRepository,
): Promise<void> {
	const repo = repository ?? (await getSharedJobRepository());
	let outputHash: string | undefined;
	try {
		outputHash = await computeFileHash(outputPath);
	} catch {
		outputHash = undefined;
	}
	if (outputHash) {
		repo.completeStageCheckpoint(
			stage,
			inputHash,
			preset,
			model,
			outputHash,
			completedJobs,
		);
	}
}
