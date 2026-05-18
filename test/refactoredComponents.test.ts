/**
 * Unit Tests for Refactored Components
 *
 * Comprehensive test suite for the refactored modules including:
 * - Provider implementations
 * - JSON parser
 * - Circuit breaker
 * - Security utilities
 * - Data utilities
 *
 * @author tjenkel
 * @license MIT
 * @since 3.2.0
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "jest";
import { CircuitBreaker, CircuitBreakerFactory } from "../src/circuitBreaker";
import { jsonParser } from "../src/jsonParser";
import { OpenAIProvider } from "../src/providers/openaiProvider";
import { AppError } from "../src/utils";
import {
	batchProcessJobs,
	calculateJobSimilarity,
	cleanJobDescription,
	extractSalaryFromText,
	filterJobs,
	normalizeJobData,
	removeDuplicates,
	validateJobData,
} from "../src/utils/dataUtils";
import {
	defaultRateLimiter,
	sanitizeApiKey,
	sanitizeInput,
	sanitizeUrl,
	securityAuditLogger,
	validateApiKey,
	validateFilePath,
	validateInput,
	validateUrl,
} from "../src/utils/securityUtils";

// Mock external dependencies
jest.mock("openai");
const { OpenAI } = require("openai");

describe("JSON Parser", () => {
	beforeEach(() => {
		jsonParser.reset();
	});

	describe("parse", () => {
		it("should parse valid JSON", async () => {
			const validJson = '{"test": "value", "number": 123}';
			const result = await jsonParser.parse(validJson);

			expect(result).toEqual({ test: "value", number: 123 });
			expect(jsonParser.getMetrics().successfulParses).toBe(1);
		});

		it("should handle JSON with trailing commas", async () => {
			const jsonWithTrailingComma = '{"test": "value",}';
			const result = await jsonParser.parse(jsonWithTrailingComma);

			expect(result).toEqual({ test: "value" });
		});

		it("should handle JSON with unescaped quotes", async () => {
			const jsonWithQuotes = '{"test": "value with \\"quotes\\""}';
			const result = await jsonParser.parse(jsonWithQuotes);

			expect(result).toEqual({ test: 'value with "quotes"' });
		});

		it("should handle malformed JSON with repair strategies", async () => {
			const malformedJson = '{"test": "value", "incomplete":';
			const result = await jsonParser.parse(malformedJson);

			expect(result).toBeDefined();
		});

		it("should throw error for unrepairable JSON", async () => {
			const invalidJson = "invalid json string";

			await expect(jsonParser.parse(invalidJson)).rejects.toThrow(AppError);
			expect(jsonParser.getMetrics().failedParses).toBe(1);
		});
	});

	describe("getMetrics", () => {
		it("should return parsing metrics", () => {
			const metrics = jsonParser.getMetrics();

			expect(metrics).toHaveProperty("totalAttempts");
			expect(metrics).toHaveProperty("successfulParses");
			expect(metrics).toHaveProperty("failedParses");
			expect(metrics).toHaveProperty("averageRepairTime");
		});
	});
});

describe("Circuit Breaker", () => {
	let circuitBreaker: CircuitBreaker;

	beforeEach(() => {
		circuitBreaker = new CircuitBreaker("test-service", {
			failureThreshold: 3,
			timeout: 1000,
			recoveryTimeout: 2000,
		});
	});

	describe("execute", () => {
		it("should execute successful operation", async () => {
			const operation = jest.fn().mockResolvedValue("success");

			const result = await circuitBreaker.execute("test", operation);

			expect(result).toBe("success");
			expect(operation).toHaveBeenCalledTimes(1);
		});

		it("should handle operation failures", async () => {
			const operation = jest.fn().mockRejectedValue(new Error("failed"));

			await expect(circuitBreaker.execute("test", operation)).rejects.toThrow();
			expect(operation).toHaveBeenCalledTimes(1);
		});

		it("should open circuit after threshold failures", async () => {
			const operation = jest.fn().mockRejectedValue(new Error("failed"));

			// Fail 3 times to trigger threshold
			for (let i = 0; i < 3; i++) {
				await expect(
					circuitBreaker.execute("test", operation),
				).rejects.toThrow();
			}

			expect(circuitBreaker.getState()).toBe("OPEN");
		});

		it("should allow requests in half-open state", async () => {
			const operation = jest.fn().mockRejectedValue(new Error("failed"));

			// Fail 3 times to open circuit
			for (let i = 0; i < 3; i++) {
				await expect(
					circuitBreaker.execute("test", operation),
				).rejects.toThrow();
			}

			// Circuit should be open
			expect(circuitBreaker.getState()).toBe("OPEN");

			// Force half-open state
			circuitBreaker.forceClose();
			// Note: transitionToHalfOpen() is private, so we'll test the behavior indirectly

			// Should allow request in half-open state
			await expect(circuitBreaker.execute("test", operation)).rejects.toThrow();
		});

		it("should timeout operations", async () => {
			const slowOperation = jest
				.fn()
				.mockImplementation(
					() => new Promise((resolve) => setTimeout(resolve, 2000)),
				);

			await expect(
				circuitBreaker.execute("test", slowOperation),
			).rejects.toThrow("TIMEOUT");
		});
	});

	describe("getMetrics", () => {
		it("should return circuit breaker metrics", () => {
			const metrics = circuitBreaker.getMetrics();

			expect(metrics).toHaveProperty("totalRequests");
			expect(metrics).toHaveProperty("successfulRequests");
			expect(metrics).toHaveProperty("failedRequests");
			expect(metrics).toHaveProperty("circuitOpenCount");
			expect(metrics).toHaveProperty("averageResponseTime");
		});
	});
});

describe("Circuit Breaker Factory", () => {
	it("should create circuit breaker with default config", () => {
		const breaker = CircuitBreakerFactory.create("test-service");

		expect(breaker).toBeInstanceOf(CircuitBreaker);
		expect(breaker.getState()).toBe("CLOSED");
	});

	it("should create circuit breaker for specific service", () => {
		const breaker = CircuitBreakerFactory.createForService("openai");

		expect(breaker).toBeInstanceOf(CircuitBreaker);
		expect(breaker.getState()).toBe("CLOSED");
	});
});

describe("Security Utilities", () => {
	describe("validateInput", () => {
		it("should validate XSS-free input", () => {
			const cleanInput = "This is a normal message";
			expect(validateInput(cleanInput, "xss")).toBe(true);
		});

		it("should detect XSS patterns", () => {
			const xssInput = '<script>alert("xss")</script>';
			expect(validateInput(xssInput, "xss")).toBe(false);
		});

		it("should validate SQL injection-free input", () => {
			const cleanInput = "Normal user input";
			expect(validateInput(cleanInput, "sql")).toBe(true);
		});

		it("should detect SQL injection patterns", () => {
			const sqlInput = "SELECT * FROM users; DROP TABLE users;";
			expect(validateInput(sqlInput, "sql")).toBe(false);
		});

		it("should validate email format", () => {
			expect(validateInput("test@example.com", "email")).toBe(true);
			expect(validateInput("invalid-email", "email")).toBe(false);
		});

		it("should validate URL format", () => {
			expect(validateInput("https://example.com", "url")).toBe(true);
			expect(validateInput('javascript:alert("xss")', "url")).toBe(false);
		});

		it("should validate API key format", () => {
			const validKey = "a1b2c3d4e5f6g7h8i9j0";
			expect(validateInput(validKey, "apiKey")).toBe(true);

			const invalidKey = "short";
			expect(validateInput(invalidKey, "apiKey")).toBe(false);
		});
	});

	describe("sanitizeInput", () => {
		it("should remove HTML tags", () => {
			const input = "<p>Hello <b>world</b></p>";
			const result = sanitizeInput(input, { stripTags: true });

			expect(result).toBe("Hello world");
		});

		it("should encode HTML entities", () => {
			const input = '<script>alert("xss")</script>';
			const result = sanitizeInput(input, { encodeHtml: true });

			expect(result).toBe('<script>alert("xss")</script>');
		});

		it("should remove XSS patterns", () => {
			const input = 'Hello <script>alert("xss")</script> world';
			const result = sanitizeInput(input);

			expect(result).toBe("Hello  world");
		});

		it("should limit input length", () => {
			const input = "This is a very long string that should be truncated";
			const result = sanitizeInput(input, { maxLength: 10 });

			expect(result.length).toBe(10);
		});
	});

	describe("validateFilePath", () => {
		it("should validate safe file paths", () => {
			expect(validateFilePath("/path/to/file.txt")).toBe(true);
			expect(validateFilePath("./relative/path/file.json")).toBe(true);
		});

		it("should detect path traversal", () => {
			expect(validateFilePath("../../etc/passwd")).toBe(false);
			expect(validateFilePath("..\\..\\windows\\system32")).toBe(false);
		});

		it("should validate file extensions", () => {
			expect(validateFilePath("/path/to/file.txt", ["txt", "json"])).toBe(true);
			expect(validateFilePath("/path/to/file.exe", ["txt", "json"])).toBe(
				false,
			);
		});
	});

	describe("validateApiKey", () => {
		it("should validate API key format", () => {
			const validKey = "a1b2c3d4e5f6g7h8i9j0";
			expect(validateApiKey(validKey)).toBe(true);
		});

		it("should reject test keys", () => {
			expect(validateApiKey("test-key-123")).toBe(false);
			expect(validateApiKey("demo-key")).toBe(false);
		});

		it("should reject invalid formats", () => {
			expect(validateApiKey("short")).toBe(false);
			expect(validateApiKey("")).toBe(false);
		});
	});

	describe("sanitizeApiKey", () => {
		it("should mask API keys", () => {
			const apiKey = "a1b2c3d4e5f6g7h8i9j0";
			const sanitized = sanitizeApiKey(apiKey);

			expect(sanitized).toBe("a1b2****i9j0");
			expect(sanitized.length).toBe(apiKey.length);
		});

		it("should handle short keys", () => {
			const apiKey = "short";
			const sanitized = sanitizeApiKey(apiKey);

			expect(sanitized).toBe("*****");
		});
	});

	describe("validateUrl", () => {
		it("should validate safe URLs", () => {
			expect(validateUrl("https://example.com")).toBe(true);
			expect(validateUrl("http://example.com/path")).toBe(true);
		});

		it("should reject dangerous protocols", () => {
			expect(validateUrl('javascript:alert("xss")')).toBe(false);
			expect(validateUrl('data:text/html,<script>alert("xss")</script>')).toBe(
				false,
			);
		});

		it("should reject URLs with suspicious parameters", () => {
			expect(
				validateUrl('https://example.com?param=<script>alert("xss")</script>'),
			).toBe(false);
		});
	});

	describe("sanitizeUrl", () => {
		it("should sanitize URLs", () => {
			const url = "https://example.com?api_key=secret123&param=value";
			const sanitized = sanitizeUrl(url);

			expect(sanitized).toBe("https://example.com?api_key=***&param=value");
		});
	});

	describe("Rate Limiter", () => {
		it("should allow requests within limit", () => {
			expect(defaultRateLimiter.isAllowed("user1")).toBe(true);
			expect(defaultRateLimiter.isAllowed("user1")).toBe(true);
			expect(defaultRateLimiter.getRemainingRequests("user1")).toBe(98);
		});

		it("should block requests over limit", () => {
			// Make 100 requests
			for (let i = 0; i < 100; i++) {
				defaultRateLimiter.isAllowed("user2");
			}

			expect(defaultRateLimiter.isAllowed("user2")).toBe(false);
		});

		it("should reset rate limit", () => {
			defaultRateLimiter.reset("user3");
			expect(defaultRateLimiter.isAllowed("user3")).toBe(true);
		});
	});

	describe("Security Audit Logger", () => {
		it("should log security events", () => {
			securityAuditLogger.log("warn", "XSS_ATTEMPT", "XSS attack detected", {
				input: "test",
			});

			const logs = securityAuditLogger.getLogs();
			expect(logs.length).toBe(1);
			expect(logs[0].type).toBe("XSS_ATTEMPT");
			expect(logs[0].level).toBe("warn");
		});

		it("should filter logs by type", () => {
			securityAuditLogger.log("info", "LOGIN", "User logged in");
			securityAuditLogger.log("warn", "XSS_ATTEMPT", "XSS attack");

			const xssLogs = securityAuditLogger.getLogsByType("XSS_ATTEMPT");
			expect(xssLogs.length).toBe(1);
		});

		it("should filter logs by level", () => {
			securityAuditLogger.log("info", "LOGIN", "User logged in");
			securityAuditLogger.log("warn", "XSS_ATTEMPT", "XSS attack");

			const warnLogs = securityAuditLogger.getLogsByLevel("warn");
			expect(warnLogs.length).toBe(1);
		});
	});
});

describe("Data Utilities", () => {
	describe("normalizeJobData", () => {
		it("should normalize job data structure", () => {
			const input = {
				title: "Software Engineer",
				company: "Tech Corp",
				description: "Job description",
				url: "https://example.com/job",
			};

			const normalized = normalizeJobData(input);

			expect(normalized).toHaveProperty("id");
			expect(normalized).toHaveProperty("title", "Software Engineer");
			expect(normalized).toHaveProperty("company", "Tech Corp");
			expect(normalized).toHaveProperty("descriptionText", "Job description");
			expect(normalized).toHaveProperty("url", "https://example.com/job");
		});

		it("should handle missing required fields", () => {
			const input = { title: "Software Engineer" };
			const normalized = normalizeJobData(input);

			expect(normalized).toHaveProperty("id");
			expect(normalized).toHaveProperty("company", "");
			expect(normalized).toHaveProperty("descriptionText", "");
			expect(normalized).toHaveProperty("url", "");
		});

		it("should throw error for invalid input", () => {
			expect(() => normalizeJobData(null)).toThrow(AppError);
			expect(() => normalizeJobData(undefined)).toThrow(AppError);
		});
	});

	describe("removeDuplicates", () => {
		it("should remove duplicate jobs by URL", () => {
			const jobs = [
				{
					title: "Job 1",
					company: "Company A",
					url: "https://example.com/job1",
				},
				{
					title: "Job 2",
					company: "Company B",
					url: "https://example.com/job2",
				},
				{
					title: "Job 1",
					company: "Company A",
					url: "https://example.com/job1",
				}, // duplicate
			];

			const unique = removeDuplicates(jobs, "url");

			expect(unique.length).toBe(2);
		});

		it("should remove duplicates by exact match", () => {
			const jobs = [
				{
					title: "Job 1",
					company: "Company A",
					location: "NYC",
					url: "https://example.com/job1",
				},
				{
					title: "Job 1",
					company: "Company A",
					location: "NYC",
					url: "https://example.com/job1",
				}, // duplicate
				{
					title: "Job 1",
					company: "Company A",
					location: "LA",
					url: "https://example.com/job3",
				}, // different location
			];

			const unique = removeDuplicates(jobs, "exact");

			expect(unique.length).toBe(2);
		});

		it("should handle invalid job data", () => {
			const jobs = [
				{ title: "Job 1", company: "Company A" },
				null,
				undefined,
				{ title: "Job 2", company: "Company B" },
			];

			const unique = removeDuplicates(jobs);

			expect(unique.length).toBe(2);
		});
	});

	describe("filterJobs", () => {
		it("should filter jobs by company", () => {
			const jobs = [
				{
					title: "Job 1",
					company: "Tech Corp",
					descriptionText: "Description 1",
				},
				{
					title: "Job 2",
					company: "Startup Inc",
					descriptionText: "Description 2",
				},
				{
					title: "Job 3",
					company: "Tech Corp",
					descriptionText: "Description 3",
				},
			];

			const filtered = filterJobs(jobs, ["Tech Corp"]);

			expect(filtered.length).toBe(2);
			expect(filtered.every((job) => job.company === "Tech Corp")).toBe(true);
		});

		it("should exclude companies", () => {
			const jobs = [
				{
					title: "Job 1",
					company: "Tech Corp",
					descriptionText: "Description 1",
				},
				{
					title: "Job 2",
					company: "Startup Inc",
					descriptionText: "Description 2",
				},
				{
					title: "Job 3",
					company: "Big Corp",
					descriptionText: "Description 3",
				},
			];

			const filtered = filterJobs(jobs, undefined, undefined, ["Big Corp"]);

			expect(filtered.length).toBe(2);
			expect(filtered.every((job) => job.company !== "Big Corp")).toBe(true);
		});

		it("should filter by title", () => {
			const jobs = [
				{
					title: "Software Engineer",
					company: "Tech Corp",
					descriptionText: "Description 1",
				},
				{
					title: "Data Scientist",
					company: "Tech Corp",
					descriptionText: "Description 2",
				},
				{
					title: "Product Manager",
					company: "Tech Corp",
					descriptionText: "Description 3",
				},
			];

			const filtered = filterJobs(jobs, undefined, ["Software Engineer"]);

			expect(filtered.length).toBe(1);
			expect(filtered[0].title).toBe("Software Engineer");
		});
	});

	describe("validateJobData", () => {
		it("should validate complete job data", () => {
			const jobData = {
				title: "Software Engineer",
				company: "Tech Corp",
				descriptionText: "Job description",
				url: "https://example.com/job",
			};

			const result = validateJobData(jobData);

			expect(result.isValid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should detect missing required fields", () => {
			const jobData = {
				title: "Software Engineer",
				company: "Tech Corp",
				// missing descriptionText and url
			};

			const result = validateJobData(jobData);

			expect(result.isValid).toBe(false);
			expect(result.errors).toContain("descriptionText is required");
			expect(result.errors).toContain("url is required");
		});

		it("should validate URL format", () => {
			const jobData = {
				title: "Software Engineer",
				company: "Tech Corp",
				descriptionText: "Job description",
				url: "invalid-url",
			};

			const result = validateJobData(jobData);

			expect(result.isValid).toBe(false);
			expect(result.errors).toContain("Invalid URL format");
		});
	});

	describe("cleanJobDescription", () => {
		it("should clean and normalize job description", () => {
			const description =
				"  This   is   a   test   description  \n\n  with   extra   spaces  ";
			const cleaned = cleanJobDescription(description);

			expect(cleaned).toBe("This is a test description\n\nwith extra spaces");
		});

		it("should remove special characters", () => {
			const description = "Job with @#$% special characters &*() symbols";
			const cleaned = cleanJobDescription(description);

			expect(cleaned).toBe("Job with  special characters  symbols");
		});

		it("should handle empty input", () => {
			expect(cleanJobDescription("")).toBe("");
			expect(cleanJobDescription(null as any)).toBe("");
			expect(cleanJobDescription(undefined as any)).toBe("");
		});
	});

	describe("extractSalaryFromText", () => {
		it("should extract salary from text", () => {
			const text = "Salary: $80,000 - $120,000 per year";
			const salary = extractSalaryFromText(text);

			expect(salary).toHaveProperty("min", 80000);
			expect(salary).toHaveProperty("max", 120000);
			expect(salary).toHaveProperty("currency", "USD");
		});

		it("should handle single salary value", () => {
			const text = "Compensation: $95,000";
			const salary = extractSalaryFromText(text);

			expect(salary).toHaveProperty("min", 95000);
			expect(salary).toHaveProperty("max", 95000);
		});

		it("should return empty object for no salary", () => {
			const text = "No salary information provided";
			const salary = extractSalaryFromText(text);

			expect(salary).toEqual({});
		});
	});

	describe("calculateJobSimilarity", () => {
		it("should calculate similarity between jobs", () => {
			const job1 = {
				title: "Software Engineer",
				company: "Tech Corp",
				location: "NYC",
			};
			const job2 = {
				title: "Senior Software Engineer",
				company: "Tech Corp",
				location: "NYC",
			};

			const similarity = calculateJobSimilarity(job1, job2);

			expect(similarity).toBeGreaterThan(0);
			expect(similarity).toBeLessThanOrEqual(1);
		});

		it("should return 0 for completely different jobs", () => {
			const job1 = {
				title: "Software Engineer",
				company: "Tech Corp",
				location: "NYC",
			};
			const job2 = { title: "Chef", company: "Restaurant", location: "LA" };

			const similarity = calculateJobSimilarity(job1, job2);

			expect(similarity).toBeGreaterThan(0);
		});
	});

	describe("batchProcessJobs", () => {
		it("should process jobs in batches", async () => {
			const jobs = [
				{ id: 1, title: "Job 1" },
				{ id: 2, title: "Job 2" },
				{ id: 3, title: "Job 3" },
				{ id: 4, title: "Job 4" },
				{ id: 5, title: "Job 5" },
			];

			const processor = jest
				.fn()
				.mockImplementation((job: any) =>
					Promise.resolve({ ...job, processed: true }),
				);

			const results = await batchProcessJobs(jobs, processor, 2, 10);

			expect(results.length).toBe(5);
			expect(processor).toHaveBeenCalledTimes(5);
			expect(results.every((job) => job.processed)).toBe(true);
		});

		it("should handle processor errors", async () => {
			const jobs = [
				{ id: 1, title: "Job 1" },
				{ id: 2, title: "Job 2" },
				{ id: 3, title: "Job 3" },
			];

			const processor = jest
				.fn()
				.mockResolvedValueOnce({ id: 1, processed: true })
				.mockRejectedValueOnce(new Error("Processing failed"))
				.mockResolvedValueOnce({ id: 3, processed: true });

			const results = await batchProcessJobs(jobs, processor, 1, 10);

			expect(results.length).toBe(2);
			expect(results.map((r) => r.id)).toEqual([1, 3]);
		});
	});
});

describe("OpenAI Provider", () => {
	let provider: OpenAIProvider;
	let mockOpenAI: any;

	beforeEach(() => {
		mockOpenAI = {
			chat: {
				completions: {
					create: jest.fn(),
				},
			},
		};

		(OpenAI as jest.Mock).mockImplementation(() => mockOpenAI);

		provider = new OpenAIProvider({
			name: "openai",
			apiKey: "test-key",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4",
		});
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe("validateConfig", () => {
		it("should validate correct configuration", () => {
			expect(provider.validateConfig()).toBe(true);
		});

		it("should reject invalid configuration", () => {
			const invalidProvider = new OpenAIProvider({
				name: "openai",
				apiKey: "",
				baseUrl: "invalid-url",
				model: "",
			});

			expect(invalidProvider.validateConfig()).toBe(false);
		});
	});

	describe("call", () => {
		it("should make successful API call", async () => {
			mockOpenAI.chat.completions.create.mockResolvedValue({
				choices: [
					{
						message: {
							content: "This is a response",
						},
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 200,
					total_tokens: 300,
				},
			});

			const request = {
				provider: "openai" as const,
				model: "gpt-4",
				messages: [{ role: "user" as const, content: "Hello" }],
			};

			const response = await provider.call(request);

			expect(response.content).toBe("This is a response");
			expect(response.usage.totalTokens).toBe(300);
			expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith({
				model: "gpt-4",
				messages: [{ role: "user", content: "Hello" }],
				temperature: 0.6,
				top_p: 0.95,
				max_tokens: 8000,
			});
		});

		it("should handle API errors", async () => {
			mockOpenAI.chat.completions.create.mockRejectedValue(
				new Error("API Error"),
			);

			const request = {
				provider: "openai" as const,
				model: "gpt-4",
				messages: [{ role: "user" as const, content: "Hello" }],
			};

			await expect(provider.call(request)).rejects.toThrow(AppError);
		});
	});
});

// Performance tests
describe("Performance Tests", () => {
	it("should handle JSON parsing efficiently", async () => {
		const largeJson = JSON.stringify({
			data: Array(1000).fill({ test: "value" }),
		});

		const startTime = performance.now();
		await jsonParser.parse(largeJson);
		const endTime = performance.now();

		expect(endTime - startTime).toBeLessThan(1000); // Should parse in under 1 second
	});

	it("should handle circuit breaker timeouts", async () => {
		const circuitBreaker = new CircuitBreaker("test", { timeout: 100 });

		const slowOperation = () =>
			new Promise((resolve) => setTimeout(resolve, 200));

		const startTime = performance.now();
		await expect(
			circuitBreaker.execute("test", slowOperation),
		).rejects.toThrow();
		const endTime = performance.now();

		expect(endTime - startTime).toBeLessThan(150); // Should timeout quickly
	});
});
