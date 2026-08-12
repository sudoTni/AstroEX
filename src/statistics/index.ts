/**
 * Statistics Module Index
 *
 * This file exports all statistics-related components for easy importing
 * across the AstroEX codebase.
 */

import type { StatisticsSummary, Timer } from "./StatisticsCollector";
import {
	createStatisticsCollector,
	StatisticsCollector,
} from "./StatisticsCollector";

// Export convenience functions for common statistics operations
export function createStatisticsForCommand(command: string) {
	return createStatisticsCollector(command);
}

// Export all components
export { StatisticsCollector, createStatisticsCollector };
export type { StatisticsSummary, Timer };

// Export default instance for convenience
export default StatisticsCollector;
