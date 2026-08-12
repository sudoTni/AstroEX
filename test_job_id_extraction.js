const fs = require("node:fs");

async function testJobIdExtraction() {
	try {
		const filePath = "./data/scraped_jobs_20250813_192041.json";
		console.log("Testing job ID extraction for file:", filePath);

		const fileContent = await fs.promises.readFile(filePath, "utf-8");

		const jobs = [];
		const lines = fileContent.split("\n").filter((line) => line.trim());
		let currentJobJson = "";

		for (const line of lines) {
			currentJobJson += `${line}\n`;

			try {
				const jobData = JSON.parse(currentJobJson);
				if (jobData && typeof jobData === "object") {
					// Extract job ID from URL if not present
					let jobId = jobData.id;
					if (!jobId && jobData.url) {
						// Try to extract ID from URL pattern: /jobs/view/.../ID?position= or /jobs/view/.../ID&position=
						const urlMatch = jobData.url.match(
							/\/jobs\/view\/[^/]+\/(\d+)(\?|&)position=/,
						);
						if (urlMatch) {
							jobId = urlMatch[1];
						} else {
							const fallbackMatch = jobData.url.match(
								/\/jobs\/view\/[^/]+\/(\d+)/,
							);
							if (fallbackMatch) {
								jobId = fallbackMatch[1];
							}
						}
					}

					const jobWithId = { ...jobData, id: jobId };
					jobs.push(jobWithId);
					currentJobJson = "";
				}
			} catch (_lineError) {}
		}

		console.log("Total jobs processed:", jobs.length);
		console.log("\nSample job IDs:");
		for (let i = 0; i < Math.min(5, jobs.length); i++) {
			const job = jobs[i];
			console.log(`Job ${i + 1}:`);
			console.log(`  Title: ${job.title}`);
			console.log(`  Company: ${job.company}`);
			console.log(`  ID: ${job.id}`);
			console.log(`  URL: ${job.url}`);
			console.log("");
		}

		// Verify all jobs have IDs
		const jobsWithoutIds = jobs.filter((job) => !job.id);
		if (jobsWithoutIds.length === 0) {
			console.log("✅ All jobs have proper IDs extracted from URLs");
		} else {
			console.log(`❌ ${jobsWithoutIds.length} jobs are missing IDs:`);
			jobsWithoutIds.forEach((job, index) => {
				console.log(`  ${index + 1}. ${job.title} - ${job.url}`);
			});
		}
	} catch (error) {
		console.error("Error:", error.message);
	}
}

testJobIdExtraction();
