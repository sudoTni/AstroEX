// Differential oracle generator for the HTML->Markdown parity suite.
//
// Usage:
//   node tests/differential/generate_markdown_oracle.js /path/to/AstroEX-node \
//     > tests/fixtures/markdown_oracle.json
//
// It runs the real AstroEX-node dependency stack (Turndown configured exactly
// as src/acquisition/jobspy/http.ts does, and Cheerio for plain text) over a
// fixed corpus and prints JSON goldens consumed by
// tests/markdown_differential.rs. This script is a development aid; the test
// itself never invokes Node.

const path = require("path");

const nodeRepo = process.argv[2];
if (!nodeRepo) {
  console.error("usage: node generate_markdown_oracle.js /path/to/AstroEX-node");
  process.exit(2);
}
const cheerio = require(path.join(nodeRepo, "node_modules/cheerio"));
const TurndownService = require(path.join(nodeRepo, "node_modules/turndown"));
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

const fixtures = [
  "<h1>Title</h1><h3>Sub</h3>",
  "<p><strong>bold</strong> and <em>it</em> and <code>x = 1</code></p>",
  '<p><a href="https://ex.com">Example</a> <img alt="logo" src="https://ex.com/l.png"></p>',
  "<p>line one<br>line two</p><p>second para</p>",
  "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>",
  "<ol><li>first</li><li>second</li></ol>",
  "<blockquote>quoted text</blockquote>",
  '<pre>fn main() {\n    println!("hi");\n}</pre>',
  "<div><p>a</p><div><p>b</p><p>c</p></div></div>",
  "<section><p>inside section</p></section>",
  "<p>Tom &amp; Jerry &lt;3 &gt;. &nbsp; done</p>",
  "<div>plain div</div>",
  "<p></p><p>after empty</p>",
  "<ul><li><p>para in li</p></li><li>tail</li></ul>",
  "<h2></h2><p>after empty heading</p>",
  "<p>a<span>b</span>c</p>",
  "<p>a <b>bold</b> c</p>",
  "<table><tr><td>cell1</td><td>cell2</td></tr></table>",
  "<hr><p>after rule</p>",
  "<div>Line1<br><br>Line2</div>",
  "<p>multi<br>line<br>text</p>",
  "<pre><code>const x = 1;\n</code></pre>",
  "<p>Trailing   spaces   collapse</p>",
  "<div><ul><li>a</li></ul><p>tail</p></div>",
  "<strong>standalone</strong>",
  "<a href=''>empty href</a>",
  "<p>Entity &#39;quote&#39; and &quot;dq&quot;</p>",
  "<ul><li>item with <a href=\"http://x\">link</a></li></ul>",
  "<h1><strong>Bold heading</strong></h1>",
  "<p>Text with <code>a < b</code> code</p>",
  "before<br>after",
  "<div>\n  <p>  spaced  </p>\n</div>",
  "<p>one</p><p>two</p><p>three</p>",
  "<ol start=\"3\"><li>c</li><li>d</li></ol>",
  "<p><em>nested <strong>bold</strong> em</em></p>",
  "<section><h2>Heading</h2><ul><li>x</li><li>y</li></ul></section>",
  `
		<div class="show-more-less-html__markup">
			<h2>About the Role</h2>
			<p>We are seeking a <strong>senior security engineer</strong> to secure our cloud infrastructure.</p>
			<ul>
				<li>5+ years Kubernetes experience</li>
				<li>Terraform knowledge</li>
			</ul>
		</div>
	`,
  "<p>* requirements: - deep _knowledge_ of [brackets] and > blockquotes</p>",
  "<p>Use <code>npm install</code> then <code>--force</code>.</p>",
  "<div><h3>Responsibilities</h3><ol><li>Design</li><li>Build<ul><li>APIs</li><li>UIs</li></ul></li><li>Ship</li></ol></div>",
  "<p>Contact <a href=\"mailto:jobs@acme.com\" title=\"Email us\">jobs@acme.com</a>.</p>",
  "<p>A link with spaces: <a href=\"http://example.com/a b\">click</a></p>",
  "<pre><code class=\"language-js\">const a = 1;\n</code></pre>",
  "<pre><code>code with ``` fence inside</code></pre>",
  "<p>Backtick <code>`tick`</code> content</p>",
  "<blockquote><p>First</p><p>Second</p></blockquote>",
  "<div>text before <ul><li>a</li><li>b</li></ul> text after</div>",
  "<h4>Deep heading</h4><h5>Deeper</h5><h6>Deepest</h6>",
  "<p>Unicode — em dash… and café</p>",
  "<p>   Leading spaces in text node</p>",
  "<div><img src=\"/rel/path.png\" alt=\"rel\"></div>",
  "<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>",
  "<p>Ends with &amp;</p>",
];

const out = fixtures.map((html) => ({
  html,
  markdown: turndown.turndown(html).trim(),
  plain: cheerio.load(html).text().replace(/\s+/g, " ").trim(),
}));
console.log(JSON.stringify(out, null, 2));
