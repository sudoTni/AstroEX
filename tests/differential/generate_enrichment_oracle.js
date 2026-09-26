// Differential oracle generator for LinkedIn enrichment HTML parsing.
//
// Usage:
//   node tests/differential/generate_enrichment_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/enrichment_oracle.json
//
// Reproduces the pure (network-free) portion of Node's
// `fetchLinkedInJobDetails` using its real exported helpers.

const path = require("path");
const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_enrichment_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const cheerio = require(path.join(nodeRepo, "node_modules/cheerio"));
const {
  extractDirectUrl,
  parseLinkedInJobCriteria,
} = require(path.join(nodeRepo, "dist/acquisition/jobspy/linkedinEnrichment.js"));
const {
  descriptionToFormat,
} = require(path.join(nodeRepo, "dist/acquisition/jobspy/http.js"));

const htmls = [
  `
		<div class="show-more-less-html__markup">
			<h2>About the Role</h2>
			<p>We are seeking a <strong>senior security engineer</strong>.</p>
			<ul><li>Kubernetes</li><li>Terraform</li></ul>
		</div>
		<code id="applyUrl"><!--https://careers.acme.com/apply?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F987654--></code>
		<ul>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Seniority level</h3>
				<span class="description__job-criteria-text">Mid-Senior level</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Employment type</h3>
				<span class="description__job-criteria-text">Full-time</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Job function</h3>
				<span class="description__job-criteria-text">Engineering</span>
			</li>
			<li class="description__job-criteria-item">
				<h3 class="description__job-criteria-subheader">Industries</h3>
				<span class="description__job-criteria-text">Software Development</span>
			</li>
		</ul>
		<img class="artdeco-entity-image" data-ghost-url="https://media.licdn.com/co.png" />
	`,
  `<div class="show-more-less-html__markup"><script>bad()</script><style>.a{}</style><p>Real <b>description</b></p></div>`,
  `<div class="show-more-less-html__markup"><p>Only description, no criteria</p></div>`,
  `<p>No markup div at all</p>`,
  `<code id="applyUrl">https://careers.acme.com/apply?url=https%zz-bad</code>`,
  `<code id="applyUrl"><!--https://x/apply?url=https%3A%2F%2Flever.co%2Fco%2F123--></code><ul><li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Industries</h3><span class="description__job-criteria-text">IT Services and IT Consulting, Staffing and Recruiting</span></li></ul>`,
];

const formats = ["markdown", "plain", "html"];

const cases = [];
for (const html of htmls) {
  for (const format of formats) {
    const $ = cheerio.load(html);
    const markupDiv = $("div.show-more-less-html__markup").first();
    let description;
    let descriptionHtml;
    if (markupDiv.length) {
      markupDiv.find("script, style").remove();
      const rawHtml = markupDiv.html() ?? "";
      descriptionHtml = rawHtml;
      description = descriptionToFormat(rawHtml, format);
    }
    const directUrl = extractDirectUrl($);
    const criteria = parseLinkedInJobCriteria($);
    const logoImg = $("img.artdeco-entity-image").first();
    const companyLogo =
      logoImg.attr("data-delayed-url") ||
      logoImg.attr("data-ghost-url") ||
      logoImg.attr("src") ||
      undefined;
    cases.push({
      html,
      format,
      output: {
        description: description ?? null,
        descriptionHtml: descriptionHtml ?? null,
        directUrl: directUrl ?? null,
        seniorityLevel: criteria.seniorityLevel ?? null,
        employmentType: criteria.employmentType ?? null,
        jobFunction: criteria.jobFunction ?? null,
        industries: criteria.industries ?? null,
        img: companyLogo ?? null,
      },
    });
  }
}

console.log(JSON.stringify({ cases }, null, 2));
