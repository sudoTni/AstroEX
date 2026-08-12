import { LLMService } from "../src/llmService";

// Sample malformed JSON that reproduces the error from the logs
const malformedJson = `[
  {
    "jobTitle": "IT Analyst",
    "isVeryHighlyAligned": false,
    "rationale": "The role is generic IT and does not specifically focus on cybersecurity, healthcare security, or the candidate's EDR/XDR expertise.",
    "confidence": 0.96
  },
  {
    "jobTitle": "Technical Implementation Integration Lead",
    "isVeryHighlyAligned": false,
    "rationale": "While implementation is relevant, the title lacks explicit cybersecurity or healthcare focus required for very high alignment.",
    "confidence": 0.85
  }
  // Missing closing bracket and brace here to simulate the error
`;

// Various malformed JSON samples for testing
const malformedJsonSamples = [
	{
		name: "Missing closing bracket",
		json: malformedJson,
		expectedSuccess: true,
	},
	{
		name: "Unquoted property names",
		json: `[{jobTitle: "Software Engineer", isVeryHighlyAligned: true}]`,
		expectedSuccess: true,
	},
	{
		name: "Missing commas",
		json: `{"jobTitle": "Developer" "isVeryHighlyAligned": true}`,
		expectedSuccess: true,
	},
	{
		name: "Trailing comma",
		json: `[{"jobTitle": "Developer", "isVeryHighlyAligned": true},]`,
		expectedSuccess: true,
	},
	{
		name: "Unterminated string",
		json: `[{"jobTitle": "Developer, "isVeryHighlyAligned": true}]`,
		expectedSuccess: false,
	},
	{
		name: "Invalid JSON structure",
		json: `{"jobTitle": "Developer" "isVeryHighlyAligned": true "confidence": 0.95}`,
		expectedSuccess: true,
	},
];

async function testJsonParsing() {
	const llmService = new LLMService();

	console.log("=== Enhanced JSON Parsing Retry Mechanism Test ===\n");

	let totalTests = 0;
	let successfulTests = 0;

	for (const sample of malformedJsonSamples) {
		totalTests++;
		console.log(
			`Test ${totalTests}/${malformedJsonSamples.length}: ${sample.name}`,
		);

		try {
			// Test the enhanced robustJsonParse method
			const result = await llmService.robustJsonParse(sample.json, {
				maxRetries: 3,
				initialDelay: 100,
				maxDelay: 1000,
				enableAggressiveRepairs: true,
			});

			if (sample.expectedSuccess) {
				console.log(
					`✅ SUCCESS: Parsed JSON successfully (${Array.isArray(result) ? result.length : 1} items)`,
				);
				successfulTests++;

				// Log the parsed result for verification
				if (Array.isArray(result) && result.length > 0) {
					console.log(`   First item: ${JSON.stringify(result[0])}`);
				}
			} else {
				console.log(
					`❌ UNEXPECTED SUCCESS: Expected failure but got result: ${JSON.stringify(result).substring(0, 100)}...`,
				);
			}
		} catch (error: unknown) {
			if (!sample.expectedSuccess) {
				console.log(
					`✅ EXPECTED FAILURE: ${error instanceof Error ? error.message : String(error)}`,
				);
				successfulTests++;
			} else {
				console.log(
					`❌ UNEXPECTED FAILURE: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		console.log(""); // Empty line for readability
	}

	console.log(`\n=== Test Results ===`);
	console.log(`Total tests: ${totalTests}`);
	console.log(`Successful tests: ${successfulTests}`);
	console.log(
		`Success rate: ${Math.round((successfulTests / totalTests) * 100)}%`,
	);

	if (successfulTests === totalTests) {
		console.log(
			"🎉 All tests passed! The enhanced retry mechanism is working correctly.",
		);
	} else {
		console.log(
			"⚠️  Some tests failed. The retry mechanism may need further refinement.",
		);
	}
}

// Run the test
testJsonParsing().catch(console.error);
