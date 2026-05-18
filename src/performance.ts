/**
 * Performance monitoring and optimization utilities for AstroEX
 */

import { log } from "./utils";

export interface PerformanceMetrics {
	operation: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	memoryUsage?: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
	};
	error?: unknown;
}

const performanceMetrics: Map<string, PerformanceMetrics> = new Map();

/**
 * Start monitoring performance for an operation
 */
export function startPerformanceMonitoring(operation: string): string {
	const id = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	const metrics: PerformanceMetrics = {
		operation,
		startTime: performance.now(),
	};

	performanceMetrics.set(id, metrics);
	log("Performance", `Started monitoring: ${operation}`, "info", { id });

	return id;
}

/**
 * End monitoring and log performance metrics
 */
export function endPerformanceMonitoring(
	id: string,
	additionalInfo?: Record<string, unknown>,
): void {
	const metrics = performanceMetrics.get(id);
	if (!metrics) {
		log("Performance", `No performance metrics found for id: ${id}`, "warn");
		return;
	}

	metrics.endTime = performance.now();
	metrics.duration = metrics.endTime - metrics.startTime;

	// Get memory usage if available
	if (process.memoryUsage) {
		metrics.memoryUsage = process.memoryUsage();
	}

	performanceMetrics.delete(id);

	const logData = {
		id,
		operation: metrics.operation,
		duration: formatDuration(metrics.duration),
		memoryUsage: metrics.memoryUsage,
		...(additionalInfo ?? {}),
	};

	log(
		"Performance",
		`Completed: ${metrics.operation} in ${formatDuration(metrics.duration)}`,
		"info",
		logData,
	);
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	const remainingMilliseconds = milliseconds % 1000;

	const parts: string[] = [];
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (remainingSeconds > 0 || minutes === 0) {
		parts.push(`${remainingSeconds}s`);
	}
	if (remainingMilliseconds > 0 && minutes === 0 && remainingSeconds === 0) {
		parts.push(`${remainingMilliseconds}ms`);
	}

	return parts.join(" ");
}

/**
 * Memory usage formatter
 */
export function formatMemoryUsage(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Get current memory usage summary
 */
export function getMemoryUsageSummary(): string {
	if (!process.memoryUsage) {
		return "Memory usage information not available";
	}

	const memory = process.memoryUsage();
	return [
		`RSS: ${formatMemoryUsage(memory.rss)}`,
		`Heap Total: ${formatMemoryUsage(memory.heapTotal)}`,
		`Heap Used: ${formatMemoryUsage(memory.heapUsed)}`,
		`External: ${formatMemoryUsage(memory.external)}`,
	].join(" | ");
}

/**
 * Performance wrapper for async operations
 */
export async function withPerformanceMonitoring<T>(
	operation: string,
	asyncOperation: () => Promise<T>,
	additionalInfo?: Record<string, unknown>,
): Promise<T> {
	const id = startPerformanceMonitoring(operation);

	try {
		const result = await asyncOperation();
		endPerformanceMonitoring(id, { success: true, ...(additionalInfo ?? {}) });
		return result;
	} catch (error) {
		endPerformanceMonitoring(id, {
			success: false,
			error,
			...(additionalInfo ?? {}),
		});
		throw error;
	}
}

/**
 * Batch processing with performance monitoring
 */
export async function processBatchWithPerformance<T, R>(
	items: T[],
	processor: (item: T) => Promise<R>,
	batchSize: number = 10,
	operationName: string = "batch processing",
): Promise<R[]> {
	const results: R[] = [];
	const totalBatches = Math.ceil(items.length / batchSize);

	log(
		"Performance",
		`Starting ${operationName}: ${items.length} items in ${totalBatches} batches`,
		"info",
	);

	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		const batchId = startPerformanceMonitoring(
			`${operationName}_batch_${Math.floor(i / batchSize) + 1}`,
		);

		try {
			const batchResults = await Promise.all(batch.map(processor));
			results.push(...batchResults);
			endPerformanceMonitoring(batchId, {
				batchSize: batch.length,
				totalItems: items.length,
				completedItems: Math.min(i + batchSize, items.length),
			});
		} catch (error) {
			endPerformanceMonitoring(batchId, {
				error,
				batchStart: i,
				batchSize: batch.length,
			});
			throw error;
		}
	}

	log(
		"Performance",
		`Completed ${operationName}: ${results.length} results`,
		"info",
	);
	return results;
}
