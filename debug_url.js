const fs = require("node:fs");

function debugUrlPattern() {
	const filePath = "./data/scraped_jobs_20250813_192041.json";
	const fileContent = fs.readFileSync(filePath, "utf-8");
	const lines = fileContent.split("\n").filter((line) => line.trim());

	console.log("Analyzing URL patterns...\n");

	for (let i = 0; i < Math.min(3, lines.length); i++) {
		const line = lines[i];
		try {
			const jobData = JSON.parse(line);
			const url = jobData.url;

			console.log(`Job ${i + 1}:`);
			console.log(`URL: ${url}`);
			console.log(`URL length: ${url.length}`);

			// Show different parts of the URL
			const parts = url.split("/");
			console.log(`URL parts:`, parts);

			// Look for the ID pattern - try different approaches
			console.log("Trying different regex patterns:");

			// Pattern 1: Look for digits before ?position=
			const pattern1 = url.match(/\/(\d+)\?position=/);
			console.log(
				`Pattern 1 (/\\(\\d+)\\?position=/): ${pattern1 ? pattern1[1] : "No match"}`,
			);

			// Pattern 2: Look for digits before &position=
			const pattern2 = url.match(/\/(\d+)&position=/);
			console.log(
				`Pattern 2 (/\\(\\d+)&position=/): ${pattern2 ? pattern2[1] : "No match"}`,
			);

			// Pattern 3: Look for digits after last /
			const pattern3 = url.match(/\/(\d+)(?=[^/]*$)/);
			console.log(
				`Pattern 3 (/\\(\\d+)(?=[^\\/]*$)/): ${pattern3 ? pattern3[1] : "No match"}`,
			);

			// Pattern 4: Extract all digits from the URL
			const pattern4 = url.match(/\d+/g);
			console.log(
				`Pattern 4 (all digits): ${pattern4 ? pattern4.join(", ") : "No match"}`,
			);

			console.log("---\n");
		} catch (error) {
			console.log(`Error parsing line ${i + 1}: ${error.message}`);
			console.log("Line content:", `${line.substring(0, 100)}...`);
			console.log("---\n");
		}
	}
}

debugUrlPattern();
