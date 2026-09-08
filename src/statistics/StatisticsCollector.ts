/**
 * Statistics Collector Interface
 *
 * This interface defines the contract for collecting and managing statistics
 * across all AstroEX commands. It provides methods for tracking performance,
 * success/failure rates, resource usage, and other metrics.
 */

import { PerformanceObserver } from "node:perf_hooks";
import { APP_VERSION } from "../constants";
import { log } from "../utils";

export interface StatisticsSummary {
	metadata: {
		command: string;
		startTime: Date;
		endTime: Date;
		duration: number;
		version: string;
		sessionId: string;
	};
	performance: {
		totalExecutionTime: number;
		operationTimes: Record<string, number>;
		memoryUsage: {
			peak: number;
			average: number;
			start: number;
			end: number;
			delta: number;
		};
		cpuTime: number;
		garbageCollections: number;
	};
	operations: {
		total: number;
		successful: number;
		failed: number;
		warnings: number;
		successRate: number;
	};
	resources: {
		files: {
			opened: number;
			read: number;
			written: number;
			deleted: number;
		};
		network: {
			connections: number;
			timeouts: number;
			retries: number;
		};
	};
	api: {
		totalCalls: number;
		successfulCalls: number;
		failedCalls: number;
		retries: number;
		circuitBreakerTrips: number;
		responseTimes: number[];
		averageResponseTime: number;
		errorRate: number;
	};
	data: {
		recordsProcessed: number;
		recordsFiltered: number;
		duplicatesRemoved: number;
		filesProcessed: number;
	};
	errors: {
		byCategory: Record<string, number>;
		details: Array<{
			timestamp: Date;
			category: string;
			message: string;
			context?: unknown;
		}>;
	};
	metrics: {
		counters: Record<string, number>;
		gauges: Record<string, number>;
		histograms: Record<
			string,
			{
				count: number;
				total: number;
				minimum: number;
				maximum: number;
				average: number;
			}
		>;
	};
}

export interface Timer {
	id: string;
	operation: string;
	startTime: number;
	endTime?: number;
	duration?: number;
}

export class StatisticsCollector {
	private metadata: {
		command: string;
		startTime: Date;
		endTime?: Date;
		duration?: number;
		sessionId: string;
	};

	private performance = {
		totalExecutionTime: 0,
		operationTimes: {} as Record<string, number>,
		memoryUsage: {
			peak: 0,
			average: 0,
			start: 0,
			end: 0,
			delta: 0,
		},
		cpuTime: 0,
		garbageCollections: 0,
	};

	private operations = {
		total: 0,
		successful: 0,
		failed: 0,
		warnings: 0,
		successRate: 0,
	};

	private resources = {
		files: {
			opened: 0,
			read: 0,
			written: 0,
			deleted: 0,
		},
		network: {
			connections: 0,
			timeouts: 0,
			retries: 0,
		},
	};

	private api = {
		totalCalls: 0,
		successfulCalls: 0,
		failedCalls: 0,
		retries: 0,
		circuitBreakerTrips: 0,
		responseTimes: [] as number[],
		errorRate: 0,
		averageResponseTime: 0,
	};

	private data = {
		recordsProcessed: 0,
		recordsFiltered: 0,
		duplicatesRemoved: 0,
		filesProcessed: 0,
	};

	private errors = {
		byCategory: {} as Record<string, number>,
		details: [] as Array<{
			timestamp: Date;
			category: string;
			message: string;
			context?: unknown;
		}>,
	};

	private timers = new Map<string, Timer>();
	private memorySamples: number[] = [];
	private metricCounters: Record<string, number> = {};
	private metricGauges: Record<string, number> = {};
	private metricHistograms: Record<string, number[]> = {};
	private cpuUsageStart?: NodeJS.CpuUsage;
	private garbageCollectionObserver?: PerformanceObserver;
	private isCollectionActive = false;
	private cleanupTasks: Array<() => void> = [];

	constructor(command: string) {
		this.metadata = {
			command,
			startTime: new Date(),
			sessionId: this.generateSessionId(),
		};

		// Record initial memory usage
		this.updateMemoryUsage();
	}

	/**
	 * Start collecting statistics for a command
	 */
	public startCollection(): void {
		if (this.isCollectionActive) {
			log("Statistics", "Collection already active", "warn");
			return;
		}

		this.isCollectionActive = true;
		this.metadata.endTime = undefined;
		this.metadata.duration = undefined;
		this.metadata.startTime = new Date();
		this.cpuUsageStart = process.cpuUsage();
		try {
			this.garbageCollectionObserver = new PerformanceObserver((entryList) => {
				this.performance.garbageCollections += entryList.getEntries().length;
			});
			this.garbageCollectionObserver.observe({ entryTypes: ["gc"] });
			this.addCleanupTask(() => {
				this.garbageCollectionObserver?.disconnect();
				this.garbageCollectionObserver = undefined;
			});
		} catch {
			// GC performance entries are not available in every Node runtime. The
			// counter remains zero in those runtimes rather than failing a command.
		}
		this.updateMemoryUsage();

		log(
			"Statistics",
			`Started collecting statistics for command: ${this.metadata.command}`,
			"info",
			{
				sessionId: this.metadata.sessionId,
			},
		);
	}

	/**
	 * End statistics collection and generate summary
	 */
	public endCollection(): StatisticsSummary {
		if (!this.isCollectionActive) {
			// Commands commonly request the summary in both their success path and
			// finally block. Returning the completed snapshot is intentionally
			// idempotent and avoids a misleading warning.
			return this.getSummary();
		}

		// Include timers that callers did not explicitly close (for example, when
		// an operation throws) instead of silently discarding their elapsed time.
		for (const timerId of [...this.timers.keys()]) {
			this.endTimer(timerId, { automaticallyClosed: true });
		}

		this.isCollectionActive = false;
		this.metadata.endTime = new Date();
		this.metadata.duration =
			this.metadata.endTime.getTime() - this.metadata.startTime.getTime();

		// Final memory update
		this.updateMemoryUsage();
		if (this.cpuUsageStart) {
			const cpuUsage = process.cpuUsage(this.cpuUsageStart);
			this.performance.cpuTime = (cpuUsage.user + cpuUsage.system) / 1000;
		}

		// Calculate final metrics
		this.calculateFinalMetrics();

		log(
			"Statistics",
			`Completed collecting statistics for command: ${this.metadata.command}`,
			"info",
			{
				duration: this.metadata.duration,
				totalOperations: this.operations.total,
				successRate: this.operations.successRate,
			},
		);

		const summary = this.getSummary();

		// Release transient resources only after taking the final snapshot. Metric
		// values remain available to getSummary() and export() after completion.
		this.performCleanup();
		return summary;
	}

	/**
	 * Perform cleanup of resources to prevent memory leaks
	 */
	private performCleanup(): void {
		// Clear timers
		this.timers.clear();

		// Clear memory samples
		this.memorySamples.length = 0;

		// Execute cleanup tasks
		for (const cleanup of this.cleanupTasks) {
			try {
				cleanup();
			} catch (error) {
				log("Statistics", `Cleanup task failed: ${error}`, "warn");
			}
		}
		this.cleanupTasks.length = 0;
	}

	/**
	 * Add a cleanup task to be executed when collection ends
	 */
	public addCleanupTask(task: () => void): void {
		this.cleanupTasks.push(task);
	}

	/**
	 * Force cleanup of all resources (emergency cleanup)
	 */
	public forceCleanup(): void {
		this.isCollectionActive = false;
		this.performCleanup();
		log("Statistics", "Forced cleanup completed", "info");
	}

	/**
	 * Start timing an operation
	 */
	public startTimer(operation: string): string {
		const id = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const timer: Timer = {
			id,
			operation,
			startTime: performance.now(),
		};

		this.timers.set(id, timer);
		return id;
	}

	/**
	 * End timing an operation
	 */
	public endTimer(id: string, additionalData?: unknown): void {
		if (!this.isCollectionActive) {
			log(
				"Statistics",
				`Collection not active, skipping timer end for id: ${id}`,
				"warn",
			);
			return;
		}

		const timer = this.timers.get(id);
		if (!timer) {
			log("Statistics", `No timer found with id: ${id}`, "warn");
			return;
		}

		timer.endTime = performance.now();
		timer.duration = timer.endTime - timer.startTime;

		// Store operation time
		this.performance.operationTimes[timer.operation] =
			(this.performance.operationTimes[timer.operation] || 0) + timer.duration;

		// Update total execution time
		this.performance.totalExecutionTime += timer.duration;

		this.timers.delete(id);

		log(
			"Statistics",
			`Operation ${timer.operation} completed in ${timer.duration}ms`,
			"debug",
			{
				id,
				duration: timer.duration,
				additionalData,
			},
		);
	}

	/**
	 * Increment a counter
	 */
	public incrementCounter(name: string, value = 1): void {
		this.metricCounters[name] = (this.metricCounters[name] || 0) + value;

		if (name === "operations.total") {
			this.operations.total += value;
		} else if (name === "operations.successful") {
			this.operations.successful += value;
		} else if (name === "operations.failed") {
			this.operations.failed += value;
		} else if (name === "operations.warnings") {
			this.operations.warnings += value;
		} else if (name.startsWith("files.")) {
			const fileOperation = name.split(
				".",
			)[1] as keyof typeof this.resources.files;
			if (fileOperation in this.resources.files) {
				this.resources.files[fileOperation] += value;
			}
		} else if (name.startsWith("network.")) {
			const networkOperation = name.split(
				".",
			)[1] as keyof typeof this.resources.network;
			if (networkOperation in this.resources.network) {
				this.resources.network[networkOperation] += value;
			}
		} else if (name.startsWith("api.")) {
			const apiOperation = name.split(".")[1];
			if (apiOperation === "totalCalls") {
				this.api.totalCalls += value;
			} else if (apiOperation === "successfulCalls") {
				this.api.successfulCalls += value;
			} else if (apiOperation === "failedCalls") {
				this.api.failedCalls += value;
			} else if (apiOperation === "retries") {
				this.api.retries += value;
			} else if (apiOperation === "circuitBreakerTrips") {
				this.api.circuitBreakerTrips += value;
			}
		} else if (name.startsWith("data.")) {
			const dataOperation = name.split(".")[1] as keyof typeof this.data;
			if (dataOperation in this.data) {
				this.data[dataOperation] += value;
			}
		} else if (name.startsWith("errors.")) {
			const errorCategory = name.split(".")[1];
			this.errors.byCategory[errorCategory] =
				(this.errors.byCategory[errorCategory] || 0) + value;
		}
	}

	/**
	 * Set a gauge value
	 */
	public setGauge(name: string, value: number): void {
		this.metricGauges[name] = value;

		if (name === "memoryUsage.peak") {
			this.performance.memoryUsage.peak = Math.max(
				this.performance.memoryUsage.peak,
				value,
			);
		} else if (name === "cpuTime") {
			this.performance.cpuTime = value;
		} else if (name === "garbageCollections") {
			this.performance.garbageCollections = value;
		}
	}

	/**
	 * Record a histogram value
	 */
	public recordHistogram(name: string, value: number): void {
		const values = this.metricHistograms[name] || [];
		values.push(value);
		this.metricHistograms[name] = values;

		if (name === "api.responseTime") {
			this.api.responseTimes.push(value);
		}
	}

	/**
	 * Record a success
	 */
	public recordSuccess(operation: string, context?: unknown): void {
		this.incrementCounter("operations.total");
		this.incrementCounter("operations.successful");

		log("Statistics", `Success recorded for operation: ${operation}`, "debug", {
			operation,
			context,
		});
	}

	/**
	 * Record an error
	 */
	public recordError(error: Error, context?: unknown): void {
		this.incrementCounter("operations.total");
		this.incrementCounter("operations.failed");

		const category = this.categorizeError(error);
		this.incrementCounter(`errors.${category}`);

		this.errors.details.push({
			timestamp: new Date(),
			category,
			message: error.message,
			context,
		});

		log("Statistics", `Error recorded: ${error.message}`, "error", {
			category,
			context,
		});
	}

	/**
	 * Record a warning
	 */
	public recordWarning(message: string, context?: unknown): void {
		this.incrementCounter("operations.warnings");

		log("Statistics", `Warning recorded: ${message}`, "warn", {
			message,
			context,
		});
	}

	/**
	 * Update memory usage tracking
	 */
	private updateMemoryUsage(): void {
		if (typeof process.memoryUsage === "function") {
			const memory = process.memoryUsage();
			const memoryBytes = memory.heapUsed;

			this.memorySamples.push(memoryBytes);

			this.performance.memoryUsage.start =
				this.performance.memoryUsage.start || memoryBytes;
			this.performance.memoryUsage.end = memoryBytes;
			this.performance.memoryUsage.peak = Math.max(
				this.performance.memoryUsage.peak,
				memoryBytes,
			);

			// Calculate average
			if (this.memorySamples.length > 0) {
				const sum = this.memorySamples.reduce((a, b) => a + b, 0);
				this.performance.memoryUsage.average = sum / this.memorySamples.length;
			}

			// Calculate delta
			this.performance.memoryUsage.delta =
				this.performance.memoryUsage.end - this.performance.memoryUsage.start;
		}
	}

	/**
	 * Calculate final metrics
	 */
	private calculateFinalMetrics(): void {
		// Calculate success rate
		this.operations.successRate =
			this.operations.total > 0
				? (this.operations.successful / this.operations.total) * 100
				: 0;

		// Calculate API error rate
		this.api.errorRate =
			this.api.totalCalls > 0
				? (this.api.failedCalls / this.api.totalCalls) * 100
				: 0;

		// Calculate average API response time
		if (this.api.responseTimes.length > 0) {
			const sum = this.api.responseTimes.reduce((a, b) => a + b, 0);
			this.api.averageResponseTime = sum / this.api.responseTimes.length;
		}
	}

	/**
	 * Categorize errors by type
	 */
	private categorizeError(error: Error): string {
		const message = error.message.toLowerCase();

		if (
			message.includes("network") ||
			message.includes("connection") ||
			message.includes("timeout")
		) {
			return "network";
		}
		if (
			message.includes("parsing") ||
			message.includes("json") ||
			message.includes("format")
		) {
			return "parsing";
		}
		if (message.includes("validation") || message.includes("invalid")) {
			return "validation";
		}
		if (
			message.includes("api") ||
			message.includes("rate") ||
			message.includes("limit")
		) {
			return "api";
		}
		if (
			message.includes("file") ||
			message.includes("disk") ||
			message.includes("io")
		) {
			return "file";
		}
		return "other";
	}

	/**
	 * Generate a unique session ID
	 */
	private generateSessionId(): string {
		return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Get current statistics summary
	 */
	public getSummary(): StatisticsSummary {
		// Derived rates stay accurate even if a caller records an error while
		// exporting or cleaning up after the collection has ended.
		this.calculateFinalMetrics();
		return {
			metadata: {
				command: this.metadata.command,
				startTime: this.metadata.startTime,
				endTime: this.metadata.endTime || new Date(),
				duration: this.metadata.duration || 0,
				version: APP_VERSION,
				sessionId: this.metadata.sessionId,
			},
			performance: {
				...this.performance,
				memoryUsage: {
					...this.performance.memoryUsage,
					average: this.performance.memoryUsage.average || 0,
				},
			},
			operations: {
				...this.operations,
				successRate: this.operations.successRate,
			},
			resources: {
				files: { ...this.resources.files },
				network: { ...this.resources.network },
			},
			api: {
				...this.api,
				responseTimes: [...this.api.responseTimes],
				averageResponseTime: this.api.averageResponseTime || 0,
				errorRate: this.api.errorRate,
			},
			data: {
				...this.data,
			},
			errors: {
				byCategory: { ...this.errors.byCategory },
				details: [...this.errors.details],
			},
			metrics: {
				counters: { ...this.metricCounters },
				gauges: { ...this.metricGauges },
				histograms: Object.fromEntries(
					Object.entries(this.metricHistograms).map(([name, values]) => {
						const total = values.reduce((sum, value) => sum + value, 0);
						return [
							name,
							{
								count: values.length,
								total,
								minimum: values.length > 0 ? Math.min(...values) : 0,
								maximum: values.length > 0 ? Math.max(...values) : 0,
								average: values.length > 0 ? total / values.length : 0,
							},
						];
					}),
				),
			},
		};
	}

	/**
	 * Export statistics in different formats
	 */
	public export(format: "json" | "csv" | "markdown"): string {
		const summary = this.getSummary();

		switch (format) {
			case "json":
				return JSON.stringify(summary, null, 2);

			case "csv":
				return this.exportToCSV(summary);

			case "markdown":
				return this.exportToMarkdown(summary);

			default:
				throw new Error(`Unsupported export format: ${format}`);
		}
	}

	/**
	 * Export statistics to CSV format
	 */
	private exportToCSV(summary: StatisticsSummary): string {
		const lines: string[] = [];

		// Header
		lines.push("Metric,Value");

		// Metadata
		lines.push(`Command,${summary.metadata.command}`);
		lines.push(`Session ID,${summary.metadata.sessionId}`);
		lines.push(`Start Time,${summary.metadata.startTime.toISOString()}`);
		lines.push(`End Time,${summary.metadata.endTime.toISOString()}`);
		lines.push(`Duration (ms),${summary.metadata.duration}`);

		// Performance
		lines.push(
			`Total Execution Time (ms),${summary.performance.totalExecutionTime}`,
		);
		lines.push(
			`Peak Memory Usage (bytes),${summary.performance.memoryUsage.peak}`,
		);
		lines.push(
			`Average Memory Usage (bytes),${summary.performance.memoryUsage.average}`,
		);
		lines.push(`Memory Delta (bytes),${summary.performance.memoryUsage.delta}`);
		lines.push(`CPU Time (ms),${summary.performance.cpuTime}`);
		lines.push(`Garbage Collections,${summary.performance.garbageCollections}`);

		// Operations
		lines.push(`Total Operations,${summary.operations.total}`);
		lines.push(`Successful Operations,${summary.operations.successful}`);
		lines.push(`Failed Operations,${summary.operations.failed}`);
		lines.push(`Warnings,${summary.operations.warnings}`);
		lines.push(`Success Rate (%),${summary.operations.successRate}`);

		// Resources
		lines.push(`Files Opened,${summary.resources.files.opened}`);
		lines.push(`Files Read,${summary.resources.files.read}`);
		lines.push(`Files Written,${summary.resources.files.written}`);
		lines.push(`Files Deleted,${summary.resources.files.deleted}`);
		lines.push(`Network Connections,${summary.resources.network.connections}`);
		lines.push(`Network Timeouts,${summary.resources.network.timeouts}`);
		lines.push(`Network Retries,${summary.resources.network.retries}`);

		// API
		lines.push(`API Total Calls,${summary.api.totalCalls}`);
		lines.push(`API Successful Calls,${summary.api.successfulCalls}`);
		lines.push(`API Failed Calls,${summary.api.failedCalls}`);
		lines.push(`API Retries,${summary.api.retries}`);
		lines.push(`API Circuit Breaker Trips,${summary.api.circuitBreakerTrips}`);
		lines.push(
			`API Average Response Time (ms),${summary.api.averageResponseTime}`,
		);
		lines.push(`API Error Rate (%),${summary.api.errorRate}`);

		// Data
		lines.push(`Records Processed,${summary.data.recordsProcessed}`);
		lines.push(`Records Filtered,${summary.data.recordsFiltered}`);
		lines.push(`Duplicates Removed,${summary.data.duplicatesRemoved}`);
		lines.push(`Files Processed,${summary.data.filesProcessed}`);

		// Errors by category
		for (const [category, count] of Object.entries(summary.errors.byCategory)) {
			lines.push(`Errors - ${category},${count}`);
		}

		for (const [name, value] of Object.entries(summary.metrics.counters)) {
			lines.push(`Counter - ${name},${value}`);
		}
		for (const [name, value] of Object.entries(summary.metrics.gauges)) {
			lines.push(`Gauge - ${name},${value}`);
		}
		for (const [name, values] of Object.entries(summary.metrics.histograms)) {
			lines.push(`Histogram - ${name} - Count,${values.count}`);
			lines.push(`Histogram - ${name} - Average,${values.average}`);
			lines.push(`Histogram - ${name} - Minimum,${values.minimum}`);
			lines.push(`Histogram - ${name} - Maximum,${values.maximum}`);
		}

		return lines.join("\n");
	}

	/**
	 * Export statistics to Markdown format
	 */
	private exportToMarkdown(summary: StatisticsSummary): string {
		let markdown = `# Statistics Report: ${summary.metadata.command}\n\n`;

		// Metadata
		markdown += "## Metadata\n\n";
		markdown += `- **Command**: ${summary.metadata.command}\n`;
		markdown += `- **Session ID**: ${summary.metadata.sessionId}\n`;
		markdown += `- **Start Time**: ${summary.metadata.startTime.toISOString()}\n`;
		markdown += `- **End Time**: ${summary.metadata.endTime.toISOString()}\n`;
		markdown += `- **Duration**: ${summary.metadata.duration}ms\n\n`;

		// Performance
		markdown += "## Performance\n\n";
		markdown += "| Metric | Value |\n";
		markdown += "|--------|-------|\n";
		markdown += `| Total Execution Time | ${summary.performance.totalExecutionTime}ms |\n`;
		markdown += `| Peak Memory Usage | ${this.formatBytes(summary.performance.memoryUsage.peak)} |\n`;
		markdown += `| Average Memory Usage | ${this.formatBytes(summary.performance.memoryUsage.average)} |\n`;
		markdown += `| Memory Delta | ${this.formatBytes(summary.performance.memoryUsage.delta)} |\n`;
		markdown += `| CPU Time | ${summary.performance.cpuTime}ms |\n`;
		markdown += `| Garbage Collections | ${summary.performance.garbageCollections} |\n\n`;

		// Operations
		markdown += "## Operations\n\n";
		markdown += "| Metric | Value |\n";
		markdown += "|--------|-------|\n";
		markdown += `| Total Operations | ${summary.operations.total} |\n`;
		markdown += `| Successful Operations | ${summary.operations.successful} |\n`;
		markdown += `| Failed Operations | ${summary.operations.failed} |\n`;
		markdown += `| Warnings | ${summary.operations.warnings} |\n`;
		markdown += `| Success Rate | ${summary.operations.successRate.toFixed(2)}% |\n\n`;

		// Resources
		markdown += "## Resources\n\n";
		markdown += "### Files\n\n";
		markdown += "| Operation | Count |\n";
		markdown += "|-----------|-------|\n";
		markdown += `| Opened | ${summary.resources.files.opened} |\n`;
		markdown += `| Read | ${summary.resources.files.read} |\n`;
		markdown += `| Written | ${summary.resources.files.written} |\n`;
		markdown += `| Deleted | ${summary.resources.files.deleted} |\n\n`;

		markdown += "### Network\n\n";
		markdown += "| Operation | Count |\n";
		markdown += "|-----------|-------|\n";
		markdown += `| Connections | ${summary.resources.network.connections} |\n`;
		markdown += `| Timeouts | ${summary.resources.network.timeouts} |\n`;
		markdown += `| Retries | ${summary.resources.network.retries} |\n\n`;

		// API
		markdown += "## API Usage\n\n";
		markdown += "| Metric | Value |\n";
		markdown += "|--------|-------|\n";
		markdown += `| Total Calls | ${summary.api.totalCalls} |\n`;
		markdown += `| Successful Calls | ${summary.api.successfulCalls} |\n`;
		markdown += `| Failed Calls | ${summary.api.failedCalls} |\n`;
		markdown += `| Retries | ${summary.api.retries} |\n`;
		markdown += `| Circuit Breaker Trips | ${summary.api.circuitBreakerTrips} |\n`;
		markdown += `| Average Response Time | ${summary.api.averageResponseTime.toFixed(2)}ms |\n`;
		markdown += `| Error Rate | ${summary.api.errorRate.toFixed(2)}% |\n\n`;

		// Data
		markdown += "## Data Processing\n\n";
		markdown += "| Metric | Value |\n";
		markdown += "|--------|-------|\n";
		markdown += `| Records Processed | ${summary.data.recordsProcessed} |\n`;
		markdown += `| Records Filtered | ${summary.data.recordsFiltered} |\n`;
		markdown += `| Duplicates Removed | ${summary.data.duplicatesRemoved} |\n`;
		markdown += `| Files Processed | ${summary.data.filesProcessed} |\n\n`;

		// Errors
		markdown += "## Errors\n\n";
		markdown += "### By Category\n\n";
		markdown += "| Category | Count |\n";
		markdown += "|----------|-------|\n";

		for (const [category, count] of Object.entries(summary.errors.byCategory)) {
			markdown += `| ${category} | ${count} |\n`;
		}

		markdown += "\n### Details\n\n";
		if (summary.errors.details.length > 0) {
			markdown += "| Timestamp | Category | Message |\n";
			markdown += "|-----------|----------|---------|\n";

			for (const error of summary.errors.details.slice(0, 10)) {
				markdown += `| ${error.timestamp.toISOString()} | ${error.category} | ${error.message} |\n`;
			}

			if (summary.errors.details.length > 10) {
				markdown += "| ... | ... | ... |\n";
				markdown += `| ${summary.errors.details.length} total errors |\n`;
			}
		} else {
			markdown += "No errors recorded.\n";
		}

		markdown += "\n## Custom Metrics\n\n";
		markdown += "| Type | Name | Value |\n";
		markdown += "|------|------|-------|\n";
		for (const [name, value] of Object.entries(summary.metrics.counters)) {
			markdown += `| Counter | ${name} | ${value} |\n`;
		}
		for (const [name, value] of Object.entries(summary.metrics.gauges)) {
			markdown += `| Gauge | ${name} | ${value} |\n`;
		}
		for (const [name, values] of Object.entries(summary.metrics.histograms)) {
			markdown += `| Histogram | ${name} | count=${values.count}, avg=${values.average.toFixed(2)}, min=${values.minimum}, max=${values.maximum} |\n`;
		}

		return markdown;
	}

	/**
	 * Format bytes to human readable format
	 */
	private formatBytes(bytes: number): string {
		const units = ["B", "KB", "MB", "GB"];
		let size = bytes;
		let unitIndex = 0;

		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}

		return `${size.toFixed(2)} ${units[unitIndex]}`;
	}
}

// Export singleton instance factory
export function createStatisticsCollector(
	command: string,
): StatisticsCollector {
	return new StatisticsCollector(command);
}

// Export default instance for convenience
export default StatisticsCollector;
