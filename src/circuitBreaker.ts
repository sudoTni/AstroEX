/**
 * Enhanced Circuit Breaker Implementation
 *
 * Provides fault tolerance for external API calls with intelligent
 * failure detection and recovery mechanisms.
 *
 * Features:
 * - Configurable failure thresholds and timeouts
 * - Automatic recovery and state transitions
 * - Performance monitoring and metrics
 * - Graceful degradation for service unavailable scenarios
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import { AppError, log, logError } from "./utils";

/**
 * Circuit breaker states
 */
enum CircuitState {
	CLOSED = "CLOSED", // Normal operation, requests are passed through
	OPEN = "OPEN", // Circuit is open, requests are immediately failed
	HALF_OPEN = "HALF_OPEN", // Testing if service has recovered
}

/**
 * Circuit breaker configuration
 */
interface CircuitBreakerConfig {
	failureThreshold?: number; // Number of failures before opening circuit
	timeout?: number; // Timeout for individual requests (ms)
	recoveryTimeout?: number; // Time to wait before trying recovery (ms)
	expectedException?: ErrorConstructor[];
	monitoringPeriod?: number; // Period to reset failure count (ms)
	halfOpenMaxRequests?: number; // Max requests in half-open state
}

/**
 * Circuit breaker metrics for monitoring
 */
interface CircuitBreakerMetrics {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	circuitOpenCount: number;
	circuitOpenDuration: number;
	averageResponseTime: number;
}

/**
 * Enhanced circuit breaker for fault tolerance
 */
export class CircuitBreaker {
	private config: Required<CircuitBreakerConfig>;
	private state: CircuitState = CircuitState.CLOSED;
	private failureCount = 0;
	private lastFailureTime = 0;
	private nextAttemptTime = 0;
	private halfOpenRequestCount = 0;
	private metrics: CircuitBreakerMetrics;
	private requestTimes: number[] = [];
	private readonly maxRequestTimes = 100;

	constructor(
		private readonly name: string,
		config: CircuitBreakerConfig = {},
	) {
		this.config = {
			failureThreshold: config.failureThreshold ?? 5,
			timeout: config.timeout ?? 30000,
			recoveryTimeout: config.recoveryTimeout ?? 60000,
			expectedException: config.expectedException ?? [Error],
			monitoringPeriod: config.monitoringPeriod ?? 60000,
			halfOpenMaxRequests: config.halfOpenMaxRequests ?? 3,
		};

		this.metrics = {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			circuitOpenCount: 0,
			circuitOpenDuration: 0,
			averageResponseTime: 0,
		};
	}

	/**
	 * Execute a function with circuit breaker protection
	 * @param operationName Name of the operation for logging
	 * @param operation Async function to execute
	 * @param context Additional context for logging
	 * @returns Promise<T> The result of the operation
	 * @throws AppError if operation fails or circuit is open
	 */
	async execute<T>(
		operationName: string,
		operation: () => Promise<T>,
		_context?: Record<string, unknown>,
	): Promise<T> {
		this.metrics.totalRequests++;
		const startTime = performance.now();

		try {
			// Check if circuit should allow the request
			if (!this.shouldAllowRequest()) {
				throw this.createCircuitOpenError(operationName);
			}

			// Execute the operation with timeout
			const result = await this.executeWithTimeout(operation);

			// Record success
			this.recordSuccess(startTime);
			return result;
		} catch (error) {
			// Record failure
			this.recordFailure(error, operationName, startTime);
			throw error;
		}
	}

	/**
	 * Check if the circuit should allow the request
	 */
	private shouldAllowRequest(): boolean {
		const now = Date.now();

		// Reset failure count if monitoring period has passed
		if (
			this.state === CircuitState.CLOSED &&
			now - this.lastFailureTime > this.config.monitoringPeriod
		) {
			this.failureCount = 0;
		}

		switch (this.state) {
			case CircuitState.CLOSED:
				return true;

			case CircuitState.OPEN:
				// Check if we should attempt recovery
				if (now >= this.nextAttemptTime) {
					this.transitionToHalfOpen();
					return true;
				}
				return false;

			case CircuitState.HALF_OPEN:
				// Allow limited requests in half-open state
				if (this.halfOpenRequestCount < this.config.halfOpenMaxRequests) {
					return true;
				}
				return false;

			default:
				return false;
		}
	}

	/**
	 * Execute operation with timeout
	 */
	private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
		let timeoutId: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(
					new AppError(
						"TIMEOUT",
						408,
						`Operation timed out after ${this.config.timeout}ms`,
						{ timeout: this.config.timeout },
					),
				);
			}, this.config.timeout);
		});

		try {
			const result = await Promise.race([operation(), timeoutPromise]);
			if (timeoutId) clearTimeout(timeoutId);
			return result;
		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			throw error;
		}
	}

	/**
	 * Record successful operation
	 */
	private recordSuccess(startTime: number): void {
		const responseTime = performance.now() - startTime;
		this.recordResponseTime(responseTime);

		if (this.state === CircuitState.HALF_OPEN) {
			// Success in half-open state means recovery
			this.transitionToClosed();
			this.halfOpenRequestCount = 0;
		}

		this.metrics.successfulRequests++;
		this.failureCount = 0; // Reset failure count on success

		log("CircuitBreaker", `Operation ${this.name} succeeded`, "info", {
			state: this.state,
			responseTime,
			successRate: this.getSuccessRate(),
			metrics: this.metrics,
		});
	}

	/**
	 * Record failed operation
	 */
	private recordFailure(
		error: unknown,
		operationName: string,
		startTime: number,
	): void {
		const responseTime = performance.now() - startTime;
		this.recordResponseTime(responseTime);

		this.metrics.failedRequests++;

		// Check if this is an expected exception
		const isExpectedException = this.isExpectedException(error);

		if (this.state === CircuitState.HALF_OPEN || isExpectedException) {
			// Failure in half-open state or expected exception means circuit should stay open
			this.transitionToOpen();
			this.halfOpenRequestCount = 0;
		} else if (this.state === CircuitState.CLOSED) {
			// Increment failure count
			this.failureCount++;
			this.lastFailureTime = Date.now();

			// Check if we should open the circuit
			if (this.failureCount >= this.config.failureThreshold) {
				this.transitionToOpen();
			}
		}

		logError(
			"CircuitBreaker",
			error instanceof Error ? error : new Error(String(error)),
			{
				operation: operationName,
				state: this.state,
				failureCount: this.failureCount,
				threshold: this.config.failureThreshold,
				responseTime,
				successRate: this.getSuccessRate(),
				isExpectedException,
				metrics: this.metrics,
			},
		);
	}

	/**
	 * Record response time for performance monitoring
	 */
	private recordResponseTime(responseTime: number): void {
		this.requestTimes.push(responseTime);

		// Keep only recent request times
		if (this.requestTimes.length > this.maxRequestTimes) {
			this.requestTimes.shift();
		}

		// Update average response time
		this.metrics.averageResponseTime =
			this.requestTimes.reduce((sum, time) => sum + time, 0) /
			this.requestTimes.length;
	}

	/**
	 * Transition circuit to open state
	 */
	private transitionToOpen(): void {
		if (this.state !== CircuitState.OPEN) {
			this.state = CircuitState.OPEN;
			this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
			this.metrics.circuitOpenCount++;

			log("CircuitBreaker", `Circuit breaker '${this.name}' opened`, "warn", {
				failureCount: this.failureCount,
				threshold: this.config.failureThreshold,
				recoveryTimeout: this.config.recoveryTimeout,
				nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
				...this.metrics,
			});
		}
	}

	/**
	 * Transition circuit to half-open state
	 */
	private transitionToHalfOpen(): void {
		this.state = CircuitState.HALF_OPEN;
		this.halfOpenRequestCount = 0;

		log(
			"CircuitBreaker",
			`Circuit breaker '${this.name}' transitioning to half-open`,
			"info",
			{
				...this.metrics,
			},
		);
	}

	/**
	 * Transition circuit to closed state
	 */
	private transitionToClosed(): void {
		this.state = CircuitState.CLOSED;
		this.failureCount = 0;

		log("CircuitBreaker", `Circuit breaker '${this.name}' closed`, "info", {
			...this.metrics,
		});
	}

	/**
	 * Check if error is an expected exception
	 */
	private isExpectedException(error: unknown): boolean {
		if (error instanceof Error) {
			return this.config.expectedException.some(
				(ExceptionClass) => error instanceof ExceptionClass,
			);
		}
		return false;
	}

	/**
	 * Create circuit open error
	 */
	private createCircuitOpenError(operationName: string): AppError {
		return new AppError(
			"CIRCUIT_OPEN",
			503,
			`Circuit breaker '${this.name}' is open. Operation '${operationName}' not allowed.`,
			{
				state: this.state,
				failureCount: this.failureCount,
				threshold: this.config.failureThreshold,
				nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
				...this.metrics,
			},
		);
	}

	/**
	 * Get current circuit state
	 */
	getState(): CircuitState {
		return this.state;
	}

	/**
	 * Get circuit breaker metrics
	 */
	getMetrics(): CircuitBreakerMetrics {
		return { ...this.metrics };
	}

	/**
	 * Get success rate
	 */
	getSuccessRate(): number {
		if (this.metrics.totalRequests === 0) {
			return 0;
		}
		return (this.metrics.successfulRequests / this.metrics.totalRequests) * 100;
	}

	/**
	 * Reset circuit breaker to closed state
	 */
	reset(): void {
		this.state = CircuitState.CLOSED;
		this.failureCount = 0;
		this.lastFailureTime = 0;
		this.nextAttemptTime = 0;
		this.halfOpenRequestCount = 0;
		this.requestTimes = [];

		log("CircuitBreaker", `Circuit breaker '${this.name}' reset`, "info");
	}

	/**
	 * Force open the circuit breaker
	 */
	forceOpen(): void {
		this.transitionToOpen();
	}

	/**
	 * Force close the circuit breaker
	 */
	forceClose(): void {
		this.transitionToClosed();
	}

	/**
	 * Get time until next attempt
	 */
	getTimeUntilNextAttempt(): number {
		if (this.state !== CircuitState.OPEN) {
			return 0;
		}
		return Math.max(0, this.nextAttemptTime - Date.now());
	}
}

/**
 * Circuit breaker factory for consistent configuration
 */
export const CircuitBreakerFactory = {
	defaultConfig: {
		failureThreshold: 5,
		timeout: 30000,
		recoveryTimeout: 60000,
		expectedException: [Error],
		monitoringPeriod: 60000,
		halfOpenMaxRequests: 3,
	},

	/**
	 * Create a circuit breaker with default configuration
	 */
	create(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
		return new CircuitBreaker(name, {
			...CircuitBreakerFactory.defaultConfig,
			...config,
		});
	},

	/**
	 * Create circuit breakers for common services
	 */
	createForService(
		serviceName: "openai" | "gemini" | "mistral" | "openrouter",
		config?: CircuitBreakerConfig,
	): CircuitBreaker {
		const serviceConfigs: Record<string, CircuitBreakerConfig> = {
			openai: {
				failureThreshold: 3,
				timeout: 45000,
				recoveryTimeout: 120000,
				...config,
			},
			gemini: {
				failureThreshold: 4,
				timeout: 30000,
				recoveryTimeout: 90000,
				...config,
			},
			mistral: {
				failureThreshold: 5,
				timeout: 30000,
				recoveryTimeout: 60000,
				...config,
			},
			openrouter: {
				failureThreshold: 3,
				timeout: 60000,
				recoveryTimeout: 180000,
				...config,
			},
		};

		return CircuitBreakerFactory.create(
			serviceName,
			serviceConfigs[serviceName],
		);
	},
};
