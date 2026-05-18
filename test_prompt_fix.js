const { loadAndReplacePromptTemplate } = require("./src/presets.ts");

async function testPromptLoading() {
	try {
		const placeholderData = {
			targJD: '{"title": "Test Job", "description": "Test description"}',
			myResume: "Test resume content",
			myTestimonials: "Test testimonials",
		};

		const userMessageContent = await loadAndReplacePromptTemplate(
			"./prompts/jep_q3-235b-a22b.txt",
			placeholderData,
		);

		console.log("✅ Prompt template loaded successfully!");
		console.log("First 200 characters:", userMessageContent.substring(0, 200));
		console.log(
			"Contains placeholders:",
			userMessageContent.includes("{targJD}"),
		);
		console.log(
			"Is NOT a file path:",
			!userMessageContent.includes("./prompts/"),
		);
	} catch (error) {
		console.error("❌ Error loading prompt template:", error.message);
	}
}

testPromptLoading();
