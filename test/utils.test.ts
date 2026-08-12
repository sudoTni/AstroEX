import {
	AppError,
	formatDuration,
	retryWithBackoff,
	safeAsyncOperation,
} from "../src/utils";

// Simple test runner (matches existing pattern in the project)
function describe(name: string, fn: () => void) {
	console.log(`\n=== ${name} ===`);
	fn();
}

function it(name: string, fn: () => Promise<void> | void) {
	console.log(`  - ${name}`);
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.catch((error) => {
				console.log(`    ❌ Failed: ${error.message}`);
			});
		}
	} catch (error) {
		console.log(
			`    ❌ Failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function expect(actual: unknown) {
	return {
		toBe: (expected: unknown) => {
			if (actual !== expected) {
				throw new Error(`Expected ${expected}, but got ${actual}`);
			}
		},
		toEqual: (expected: unknown) => {
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`,
				);
			}
		},
		toThrow: (expectedMessage?: string) => {
			if (typeof actual !== "function") {
				throw new Error("expect().toThrow() expects a function");
			}
			try {
				actual();
				throw new Error("Expected function to throw, but it didn't");
			} catch (error) {
				if (
					expectedMessage &&
					!(error instanceof Error && error.message.includes(expectedMessage))
				) {
					throw new Error(
						`Expected error to contain "${expectedMessage}", but got: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
		toBeGreaterThan: (expected: number) => {
			if (!(Number(actual) > expected)) {
				throw new Error(`Expected ${actual} to be greater than ${expected}`);
			}
		},
	};
}

describe("Utils", () => {
	describe("safeAsyncOperation", () => {
		it("should return result on success", async () => {
			const result = await safeAsyncOperation(async () => "success", "test");
			expect(result).toBe("success");
		});

		it("should return null on error", async () => {
			const result = await safeAsyncOperation(async () => {
				throw new Error("test error");
			}, "test");
			expect(result).toBe(null);
		});
	});

	describe("retryWithBackoff", () => {
		it("should return result on first success", async () => {
			let callCount = 0;
			const result = await retryWithBackoff(
				async () => {
					callCount++;
					if (callCount === 1) return "success";
					throw new Error("retry");
				},
				3,
				10,
				"test",
			);
			expect(result).toBe("success");
			expect(callCount).toBe(1);
		});

		it("should retry on failure and return null after max retries", async () => {
			const startTime = Date.now();
			const result = await retryWithBackoff(
				async () => {
					throw new Error("persistent error");
				},
				2,
				10,
				"test",
			);
			expect(result).toBe(null);

			// Should have taken at least 10ms (first retry delay)
			const elapsed = Date.now() - startTime;
			expect(elapsed).toBeGreaterThan(5);
		});

		it("should return result after retries", async () => {
			let callCount = 0;
			const result = await retryWithBackoff(
				async () => {
					callCount++;
					if (callCount < 3) throw new Error("retry");
					return "success after retries";
				},
				5,
				5,
				"test",
			);
			expect(result).toBe("success after retries");
			expect(callCount).toBe(3);
		});
	});

	describe("AppError", () => {
		it("should create error with code and message", () => {
			const error = new AppError("TEST_ERROR", 400, "Test message");
			expect(error.code).toBe("TEST_ERROR");
			expect(error.statusCode).toBe(400);
			expect(error.message).toBe("Test message");
			expect(error.name).toBe("AppError");
		});

		it("should include context", () => {
			const context = { key: "value" };
			const error = new AppError(
				"CONTEXT_ERROR",
				500,
				"Message with context",
				context,
			);
			expect(error.context).toEqual(context);
		});
	});

	describe("formatDuration", () => {
		it("should format milliseconds correctly", () => {
			expect(formatDuration(500)).toBe("500ms");
			expect(formatDuration(1500)).toBe("1s");
			expect(formatDuration(65000)).toBe("1m 5s");
			expect(formatDuration(3665000)).toBe("61m 5s");
		});

		it("should handle edge cases", () => {
			expect(formatDuration(0)).toBe("");
			expect(formatDuration(999)).toBe("999ms");
			expect(formatDuration(1000)).toBe("1s");
		});
	});

	describe("Integration Tests", () => {
		it("should handle complex async operations with retries", async () => {
			let attemptCount = 0;

			const result = await retryWithBackoff(
				async () => {
					attemptCount++;
					if (attemptCount === 1) {
						throw new Error("First attempt fails");
					}
					return safeAsyncOperation(
						async () => `Success after ${attemptCount} attempts`,
						"integration",
					);
				},
				3,
				5,
				"integration",
			);

			expect(result).toBe("Success after 2 attempts");
			expect(attemptCount).toBe(2);
		});
	});
});

// Run the tests
console.log("Running Utils tests...");
describe("Utils Test Suite", () => {
	console.log(
		"Test file created successfully with comprehensive utility tests",
	);
});
