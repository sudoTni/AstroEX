//! Faithful Rust port of Turndown (v7) configured with `headingStyle: "atx"`
//! and `codeBlockStyle: "fenced"` — the exact options AstroEX uses in
//! `src/acquisition/jobspy/http.ts` (`new TurndownService({...})`) followed by
//! `.turndown(html).trim()`.
//!
//! The original mutates the parsed DOM during its `collapseWhitespace`
//! preprocessing, so this port builds an owned, mutable arena from the
//! `scraper`/html5ever DOM and mirrors Turndown's traversal, whitespace
//! handling, rule ordering, and escaping byte-for-byte.

use scraper::{Html, Node, Selector};

const BLOCK_ELEMENTS: &[&str] = &[
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "AUDIO",
    "BLOCKQUOTE",
    "BODY",
    "CANVAS",
    "CENTER",
    "DD",
    "DIR",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "FRAMESET",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "HTML",
    "ISINDEX",
    "LI",
    "MAIN",
    "MENU",
    "NAV",
    "NOFRAMES",
    "NOSCRIPT",
    "OL",
    "OUTPUT",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
];

const VOID_ELEMENTS: &[&str] = &[
    "AREA", "BASE", "BR", "COL", "COMMAND", "EMBED", "HR", "IMG", "INPUT", "KEYGEN", "LINK",
    "META", "PARAM", "SOURCE", "TRACK", "WBR",
];

const MEANINGFUL_WHEN_BLANK: &[&str] = &[
    "A", "TABLE", "THEAD", "TBODY", "TFOOT", "TH", "TD", "IFRAME", "SCRIPT", "AUDIO", "VIDEO",
];

fn is_block(name: &str) -> bool {
    BLOCK_ELEMENTS.contains(&name)
}

fn is_void(name: &str) -> bool {
    VOID_ELEMENTS.contains(&name)
}

fn is_meaningful_when_blank(name: &str) -> bool {
    MEANINGFUL_WHEN_BLANK.contains(&name)
}

#[derive(Clone)]
enum Kind {
    Element {
        name: String,
        attrs: Vec<(String, String)>,
    },
    Text(String),
}

struct Dom {
    kinds: Vec<Kind>,
    parents: Vec<Option<usize>>,
    children: Vec<Vec<usize>>,
}

impl Dom {
    fn new() -> Self {
        Self {
            kinds: Vec::new(),
            parents: Vec::new(),
            children: Vec::new(),
        }
    }

    fn push_element(
        &mut self,
        parent: Option<usize>,
        name: String,
        attrs: Vec<(String, String)>,
    ) -> usize {
        let id = self.kinds.len();
        self.kinds.push(Kind::Element { name, attrs });
        self.parents.push(parent);
        self.children.push(Vec::new());
        if let Some(parent) = parent {
            self.children[parent].push(id);
        }
        id
    }

    fn push_text(&mut self, parent: usize, text: String) -> usize {
        let id = self.kinds.len();
        self.kinds.push(Kind::Text(text));
        self.parents.push(Some(parent));
        self.children.push(Vec::new());
        self.children[parent].push(id);
        id
    }

    fn is_text(&self, node: usize) -> bool {
        matches!(self.kinds[node], Kind::Text(_))
    }

    fn is_element(&self, node: usize) -> bool {
        matches!(self.kinds[node], Kind::Element { .. })
    }

    fn name(&self, node: usize) -> Option<&str> {
        match &self.kinds[node] {
            Kind::Element { name, .. } => Some(name),
            Kind::Text(_) => None,
        }
    }

    fn text(&self, node: usize) -> &str {
        match &self.kinds[node] {
            Kind::Text(text) => text,
            _ => "",
        }
    }

    fn set_text(&mut self, node: usize, value: String) {
        if let Kind::Text(text) = &mut self.kinds[node] {
            *text = value;
        }
    }

    fn attr(&self, node: usize, name: &str) -> Option<&str> {
        match &self.kinds[node] {
            Kind::Element { attrs, .. } => attrs
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str()),
            Kind::Text(_) => None,
        }
    }

    fn first_child(&self, node: usize) -> Option<usize> {
        self.children[node].first().copied()
    }

    fn next_sibling(&self, node: usize) -> Option<usize> {
        let parent = self.parents[node]?;
        let siblings = &self.children[parent];
        let index = siblings.iter().position(|&child| child == node)?;
        siblings.get(index + 1).copied()
    }

    fn prev_sibling(&self, node: usize) -> Option<usize> {
        let parent = self.parents[node]?;
        let siblings = &self.children[parent];
        let index = siblings.iter().position(|&child| child == node)?;
        if index == 0 {
            None
        } else {
            Some(siblings[index - 1])
        }
    }

    fn detach(&mut self, node: usize) {
        if let Some(parent) = self.parents[node] {
            self.children[parent].retain(|&child| child != node);
        }
        self.parents[node] = None;
    }

    fn text_content(&self, node: usize) -> String {
        let mut out = String::new();
        self.collect_text(node, &mut out);
        out
    }

    fn collect_text(&self, node: usize, out: &mut String) {
        for &child in &self.children[node] {
            match &self.kinds[child] {
                Kind::Text(text) => out.push_str(text),
                Kind::Element { .. } => self.collect_text(child, out),
            }
        }
    }

    fn has_tag(&self, node: usize, names: &[&str]) -> bool {
        if !self.is_element(node) {
            return false;
        }
        for &child in &self.children[node] {
            if let Kind::Element { name, .. } = &self.kinds[child] {
                if names.contains(&name.as_str()) {
                    return true;
                }
                if self.has_tag(child, names) {
                    return true;
                }
            }
        }
        false
    }

    fn element_children(&self, node: usize) -> Vec<usize> {
        self.children[node]
            .iter()
            .copied()
            .filter(|&child| self.is_element(child))
            .collect()
    }
}

fn clone_children(dom: &mut Dom, parent: usize, element: scraper::ElementRef<'_>) {
    for child in element.children() {
        match child.value() {
            Node::Text(text) => {
                dom.push_text(parent, text.text.to_string());
            }
            Node::Element(node_element) => {
                let name = node_element.name().to_ascii_uppercase();
                let attrs = node_element
                    .attrs()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect();
                let id = dom.push_element(Some(parent), name, attrs);
                if let Some(child_element) = scraper::ElementRef::wrap(child) {
                    clone_children(dom, id, child_element);
                }
            }
            _ => {}
        }
    }
}

fn next_node(dom: &Dom, prev: Option<usize>, current: usize) -> Option<usize> {
    let prev_is_parent = prev.is_some_and(|p| dom.parents[p] == Some(current));
    let is_pre = dom.name(current) == Some("PRE");
    if prev_is_parent || is_pre {
        dom.next_sibling(current).or(dom.parents[current])
    } else {
        dom.first_child(current)
            .or_else(|| dom.next_sibling(current))
            .or(dom.parents[current])
    }
}

fn remove(dom: &mut Dom, node: usize) -> Option<usize> {
    let next = dom.next_sibling(node).or(dom.parents[node]);
    dom.detach(node);
    next
}

fn collapse_ws_runs(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_ws = false;
    for ch in input.chars() {
        if ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t' {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    out
}

/// Turndown `collapseWhitespace`.
fn collapse_whitespace(dom: &mut Dom, element: usize) {
    if dom.children[element].is_empty() {
        return;
    }
    if dom.name(element) == Some("PRE") {
        return;
    }
    let mut prev_text: Option<usize> = None;
    let mut keep_leading_ws = false;
    let mut prev: Option<usize> = None;
    let mut node = next_node(dom, prev, element);
    while node != Some(element) {
        let Some(current) = node else { break };
        if dom.is_text(current) {
            let mut text = collapse_ws_runs(dom.text(current));
            let prev_ends_space = prev_text.is_some_and(|p| dom.text(p).ends_with(' '));
            if (!prev_text.is_some() || prev_ends_space)
                && !keep_leading_ws
                && text.starts_with(' ')
            {
                text.remove(0);
            }
            if text.is_empty() {
                node = remove(dom, current);
                continue;
            }
            dom.set_text(current, text);
            prev_text = Some(current);
        } else if dom.is_element(current) {
            let name = dom.name(current).unwrap_or("").to_string();
            if is_block(&name) || name == "BR" {
                if let Some(p) = prev_text {
                    let trimmed = trim_trailing_single_space(dom.text(p));
                    dom.set_text(p, trimmed);
                }
                prev_text = None;
                keep_leading_ws = false;
            } else if is_void(&name) || name == "PRE" {
                prev_text = None;
                keep_leading_ws = true;
            } else if prev_text.is_some() {
                keep_leading_ws = false;
            }
        } else {
            node = remove(dom, current);
            continue;
        }
        let next = next_node(dom, prev, current);
        prev = Some(current);
        node = next;
    }
    if let Some(p) = prev_text {
        let trimmed = trim_trailing_single_space(dom.text(p));
        dom.set_text(p, trimmed);
        if dom.text(p).is_empty() {
            remove(dom, p);
        }
    }
}

fn trim_trailing_single_space(value: &str) -> String {
    match value.strip_suffix(' ') {
        Some(stripped) => stripped.to_string(),
        None => value.to_string(),
    }
}

fn is_code(dom: &Dom, node: usize) -> bool {
    if dom.name(node) == Some("CODE") {
        return true;
    }
    match dom.parents[node] {
        Some(parent) => is_code(dom, parent),
        None => false,
    }
}

fn is_blank(dom: &Dom, node: usize) -> bool {
    if let Some(name) = dom.name(node) {
        if is_void(name) || is_meaningful_when_blank(name) {
            return false;
        }
    }
    let text = dom.text_content(node);
    if !text.chars().all(char::is_whitespace) {
        return false;
    }
    if dom.has_tag(node, VOID_ELEMENTS) {
        return false;
    }
    if dom.has_tag(node, MEANINGFUL_WHEN_BLANK) {
        return false;
    }
    true
}

struct Edges {
    leading: String,
    leading_ascii: String,
    leading_non_ascii: String,
    trailing: String,
    trailing_non_ascii: String,
    trailing_ascii: String,
}

fn is_ascii_ws(ch: char) -> bool {
    ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n'
}

fn edge_whitespace(value: &str) -> Edges {
    let chars: Vec<char> = value.chars().collect();
    let first_non = chars.iter().position(|&c| !c.is_whitespace());
    let last_non = chars.iter().rposition(|&c| !c.is_whitespace());
    match (first_non, last_non) {
        (None, _) => {
            let leading: String = chars.iter().collect();
            let ascii_len = chars.iter().take_while(|&&c| is_ascii_ws(c)).count();
            let leading_ascii: String = chars[..ascii_len].iter().collect();
            let leading_non_ascii: String = chars[ascii_len..].iter().collect();
            Edges {
                leading,
                leading_ascii,
                leading_non_ascii,
                trailing: String::new(),
                trailing_non_ascii: String::new(),
                trailing_ascii: String::new(),
            }
        }
        (Some(first), Some(last)) => {
            let ascii_len = chars[..first]
                .iter()
                .take_while(|&&c| is_ascii_ws(c))
                .count();
            let leading: String = chars[..first].iter().collect();
            let leading_ascii: String = chars[..ascii_len].iter().collect();
            let leading_non_ascii: String = chars[ascii_len..first].iter().collect();
            let trailing: String = chars[last + 1..].iter().collect();
            let tail = &chars[last + 1..];
            let ascii_tail = tail.iter().rev().take_while(|&&c| is_ascii_ws(c)).count();
            let split = tail.len() - ascii_tail;
            let trailing_ascii: String = tail[split..].iter().collect();
            let trailing_non_ascii: String = tail[..split].iter().collect();
            Edges {
                leading,
                leading_ascii,
                leading_non_ascii,
                trailing,
                trailing_non_ascii,
                trailing_ascii,
            }
        }
        (Some(_), None) => unreachable!("first non-whitespace without a last"),
    }
}

fn is_flanked_by_whitespace(dom: &Dom, side_left: bool, node: usize) -> bool {
    let sibling = if side_left {
        dom.prev_sibling(node)
    } else {
        dom.next_sibling(node)
    };
    let Some(sibling) = sibling else {
        return false;
    };
    let test = |value: &str| {
        if side_left {
            value.ends_with(' ')
        } else {
            value.starts_with(' ')
        }
    };
    if dom.is_text(sibling) {
        test(dom.text(sibling))
    } else if dom.is_element(sibling) {
        let name = dom.name(sibling).unwrap_or("");
        if !is_block(name) {
            test(&dom.text_content(sibling))
        } else {
            false
        }
    } else {
        false
    }
}

fn flanking_whitespace(dom: &Dom, node: usize) -> (String, String) {
    if dom.name(node).map(is_block).unwrap_or(false) {
        return (String::new(), String::new());
    }
    let edges = edge_whitespace(&dom.text_content(node));
    let mut leading = edges.leading.clone();
    let mut trailing = edges.trailing.clone();
    if !edges.leading_ascii.is_empty() && is_flanked_by_whitespace(dom, true, node) {
        leading = edges.leading_non_ascii.clone();
    }
    if !edges.trailing_ascii.is_empty() && is_flanked_by_whitespace(dom, false, node) {
        trailing = edges.trailing_non_ascii.clone();
    }
    (leading, trailing)
}

fn escape_markdown(input: &str) -> String {
    let mut value = input.replace('\\', "\\\\");
    value = value.replace('*', "\\*");
    if value.starts_with('-') {
        value.insert(0, '\\');
    }
    if value.starts_with("+ ") {
        value.insert(0, '\\');
    }
    if value.starts_with('=') {
        value.insert(0, '\\');
    }
    let hashes = value.chars().take_while(|&ch| ch == '#').count();
    if (1..=6).contains(&hashes) && value.chars().nth(hashes) == Some(' ') {
        value.insert(0, '\\');
    }
    value = value.replace('`', "\\`");
    if value.starts_with("~~~") {
        value.insert(0, '\\');
    }
    value = value.replace('[', "\\[");
    value = value.replace(']', "\\]");
    if value.starts_with('>') {
        value.insert(0, '\\');
    }
    value = value.replace('_', "\\_");
    let digits = value.chars().take_while(char::is_ascii_digit).count();
    if digits >= 1 && value[digits..].starts_with(". ") {
        value.insert(digits, '\\');
    }
    value
}

fn clean_attribute(value: Option<&str>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if value.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\n' {
            while chars.peek().is_some_and(|next| next.is_whitespace()) {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

fn escape_link_destination(destination: &str) -> String {
    let mut escaped = String::with_capacity(destination.len());
    for ch in destination.chars() {
        if matches!(ch, '<' | '>' | '(' | ')') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    if escaped.contains(' ') {
        format!("<{escaped}>")
    } else {
        escaped
    }
}

fn escape_link_title(title: &str) -> String {
    title.replace('"', "\\\"")
}

fn trim_leading_newlines(value: &str) -> &str {
    value.trim_start_matches('\n')
}

fn trim_trailing_newlines(value: &str) -> &str {
    value.trim_end_matches('\n')
}

fn trim_newlines(value: &str) -> &str {
    trim_trailing_newlines(trim_leading_newlines(value))
}

fn join(output: &str, replacement: &str) -> String {
    let s1 = trim_trailing_newlines(output);
    let s2 = trim_leading_newlines(replacement);
    let nls = std::cmp::max(output.len() - s1.len(), replacement.len() - s2.len());
    let separator: String = "\n\n".chars().take(nls).collect();
    format!("{s1}{separator}{s2}")
}

fn process(dom: &Dom, parent: usize) -> String {
    let mut output = String::new();
    for &child in &dom.children[parent] {
        let replacement = if dom.is_text(child) {
            let data = dom.text(child).to_string();
            if is_code(dom, child) {
                data
            } else {
                escape_markdown(&data)
            }
        } else if dom.is_element(child) {
            replacement_for_node(dom, child)
        } else {
            String::new()
        };
        output = join(&output, &replacement);
    }
    output
}

fn replacement_for_node(dom: &Dom, node: usize) -> String {
    let content = process(dom, node);
    let (leading, trailing) = flanking_whitespace(dom, node);
    let content = if !leading.is_empty() || !trailing.is_empty() {
        content.trim().to_string()
    } else {
        content
    };
    let replacement = if is_blank(dom, node) {
        if dom.name(node).map(is_block).unwrap_or(false) {
            "\n\n".to_string()
        } else {
            String::new()
        }
    } else {
        rule_replacement(dom, node, &content)
    };
    format!("{leading}{replacement}{trailing}")
}

fn rule_replacement(dom: &Dom, node: usize, content: &str) -> String {
    let name = dom.name(node).unwrap_or("");
    match name {
        "P" => format!("\n\n{content}\n\n"),
        "BR" => "  \n".to_string(),
        "H1" | "H2" | "H3" | "H4" | "H5" | "H6" => {
            let level = name[1..].parse::<usize>().unwrap_or(1);
            format!("\n\n{} {content}\n\n", "#".repeat(level))
        }
        "BLOCKQUOTE" => format!("\n\n{}\n\n", blockquote(content)),
        "UL" | "OL" => {
            if parent_is_li_last_element(dom, node) {
                format!("\n{content}")
            } else {
                format!("\n\n{content}\n\n")
            }
        }
        "LI" => list_item(dom, node, content),
        "PRE" if first_child_is_code(dom, node) => fenced_code_block(dom, node),
        "HR" => "\n\n* * *\n\n".to_string(),
        "A" if has_truthy_href(dom, node) => inline_link(dom, node, content),
        "EM" | "I" => {
            if content.trim().is_empty() {
                String::new()
            } else {
                format!("_{content}_")
            }
        }
        "STRONG" | "B" => {
            if content.trim().is_empty() {
                String::new()
            } else {
                format!("**{content}**")
            }
        }
        "CODE" if is_code_span(dom, node) => code_span(content),
        "IMG" => image(dom, node),
        _ => {
            if is_block(name) {
                format!("\n\n{content}\n\n")
            } else {
                content.to_string()
            }
        }
    }
}

fn parent_is_li_last_element(dom: &Dom, node: usize) -> bool {
    let Some(parent) = dom.parents[node] else {
        return false;
    };
    if dom.name(parent) != Some("LI") {
        return false;
    }
    dom.element_children(parent).last().copied() == Some(node)
}

fn list_item(dom: &Dom, node: usize, content: &str) -> String {
    let mut prefix = "*   ".to_string();
    if let Some(parent) = dom.parents[node] {
        if dom.name(parent) == Some("OL") {
            let index = dom
                .element_children(parent)
                .iter()
                .position(|&child| child == node)
                .unwrap_or(0);
            let number = dom
                .attr(parent, "start")
                .and_then(|start| start.trim().parse::<i64>().ok())
                .map(|start| start + index as i64)
                .unwrap_or(index as i64 + 1);
            prefix = format!("{number}.  ");
        }
    }
    let is_paragraph = content.ends_with('\n');
    let mut body = trim_newlines(content).to_string();
    if is_paragraph {
        body.push('\n');
    }
    let indent = " ".repeat(prefix.len());
    body = body.replace('\n', &format!("\n{indent}"));
    let trailing = if dom.next_sibling(node).is_some() {
        "\n"
    } else {
        ""
    };
    format!("{prefix}{body}{trailing}")
}

fn first_child_is_code(dom: &Dom, node: usize) -> bool {
    dom.first_child(node)
        .is_some_and(|child| dom.name(child) == Some("CODE"))
}

fn parse_language(class_name: &str) -> String {
    if let Some(position) = class_name.find("language-") {
        let rest = &class_name[position + "language-".len()..];
        rest.chars().take_while(|ch| !ch.is_whitespace()).collect()
    } else {
        String::new()
    }
}

fn fenced_code_block(dom: &Dom, node: usize) -> String {
    let Some(first) = dom.first_child(node) else {
        return String::new();
    };
    let class_name = dom.attr(first, "class").unwrap_or("");
    let language = parse_language(class_name);
    let code = dom.text_content(first);
    let mut fence_size = 3usize;
    for line in code.split('\n') {
        let count = line.chars().take_while(|&ch| ch == '`').count();
        if count >= 3 && count >= fence_size {
            fence_size = count + 1;
        }
    }
    let fence = "`".repeat(fence_size);
    let code = code.strip_suffix('\n').unwrap_or(&code);
    format!("\n\n{fence}{language}\n{code}\n{fence}\n\n")
}

fn has_truthy_href(dom: &Dom, node: usize) -> bool {
    dom.attr(node, "href").is_some_and(|href| !href.is_empty())
}

fn inline_link(dom: &Dom, node: usize, content: &str) -> String {
    let href = escape_link_destination(dom.attr(node, "href").unwrap_or(""));
    let title = escape_link_title(&clean_attribute(dom.attr(node, "title")));
    let title_part = if title.is_empty() {
        String::new()
    } else {
        format!(" \"{title}\"")
    };
    format!("[{content}]({href}{title_part})")
}

fn is_code_span(dom: &Dom, node: usize) -> bool {
    let has_siblings = dom.prev_sibling(node).is_some() || dom.next_sibling(node).is_some();
    let is_code_block =
        dom.parents[node].is_some_and(|parent| dom.name(parent) == Some("PRE")) && !has_siblings;
    !is_code_block
}

fn backtick_run_lengths(value: &str) -> Vec<usize> {
    let mut runs = Vec::new();
    let mut current = 0usize;
    for ch in value.chars() {
        if ch == '`' {
            current += 1;
        } else if current > 0 {
            runs.push(current);
            current = 0;
        }
    }
    if current > 0 {
        runs.push(current);
    }
    runs
}

fn code_span(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    let value = content.replace("\r\n", " ").replace(['\n', '\r'], " ");
    let inner = &value;
    let special = inner.starts_with(' ')
        && inner.ends_with(' ')
        && inner.len() >= 3
        && inner[1..inner.len() - 1]
            .chars()
            .any(|ch| !ch.is_whitespace());
    let extra_space = if inner.starts_with('`') || special || inner.ends_with('`') {
        " "
    } else {
        ""
    };
    let mut delimiter = "`".to_string();
    loop {
        let runs = backtick_run_lengths(inner);
        if runs.contains(&delimiter.len()) {
            delimiter.push('`');
        } else {
            break;
        }
    }
    format!("{delimiter}{extra_space}{inner}{extra_space}{delimiter}")
}

fn image(dom: &Dom, node: usize) -> String {
    let alt = escape_markdown(&clean_attribute(dom.attr(node, "alt")));
    let src = escape_link_destination(dom.attr(node, "src").unwrap_or(""));
    if src.is_empty() {
        return String::new();
    }
    let title = clean_attribute(dom.attr(node, "title"));
    let title_part = if title.is_empty() {
        String::new()
    } else {
        format!(" \"{}\"", escape_link_title(&title))
    };
    format!("![{alt}]({src}{title_part})")
}

fn blockquote(content: &str) -> String {
    let trimmed = trim_newlines(content);
    if trimmed.is_empty() {
        return "> ".to_string();
    }
    trimmed
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn post_process(output: &str) -> String {
    let output = output.trim_start_matches(['\t', '\r', '\n']);
    output.trim_end_matches(char::is_whitespace).to_string()
}

/// Turndown `turndown(html).trim()` with the AstroEX options.
pub fn html_to_markdown(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let wrapped = format!("<x-turndown id=\"turndown-root\">{html}</x-turndown>");
    let document = Html::parse_document(&wrapped);
    let selector = Selector::parse("#turndown-root").expect("valid selector");
    let Some(root_element) = document.select(&selector).next() else {
        return String::new();
    };
    let mut dom = Dom::new();
    let root = dom.push_element(None, "X-TURNDOWN".to_string(), Vec::new());
    clone_children(&mut dom, root, root_element);
    collapse_whitespace(&mut dom, root);
    let output = process(&dom, root);
    let output = post_process(&output);
    output.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings() {
        assert_eq!(
            html_to_markdown("<h1>Title</h1><h3>Sub</h3>"),
            "# Title\n\n### Sub"
        );
    }

    #[test]
    fn bold_italics_code() {
        assert_eq!(
            html_to_markdown("<p><strong>bold</strong> and <em>it</em> and <code>x = 1</code></p>"),
            "**bold** and _it_ and `x = 1`"
        );
    }

    #[test]
    fn links_and_images() {
        assert_eq!(
            html_to_markdown(
                "<p><a href=\"https://ex.com\">Example</a> <img alt=\"logo\" src=\"https://ex.com/l.png\"></p>"
            ),
            "[Example](https://ex.com) ![logo](https://ex.com/l.png)"
        );
    }

    #[test]
    fn line_breaks() {
        assert_eq!(
            html_to_markdown("<p>line one<br>line two</p><p>second para</p>"),
            "line one  \nline two\n\nsecond para"
        );
    }

    #[test]
    fn lists() {
        assert_eq!(
            html_to_markdown("<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>"),
            "*   one\n*   two\n    *   nested"
        );
        assert_eq!(
            html_to_markdown("<ol><li>first</li><li>second</li></ol>"),
            "1.  first\n2.  second"
        );
        assert_eq!(
            html_to_markdown("<ol start=\"3\"><li>c</li><li>d</li></ol>"),
            "3.  c\n4.  d"
        );
    }

    #[test]
    fn empty_link_renders_text() {
        assert_eq!(html_to_markdown("<a href=''>empty href</a>"), "empty href");
    }

    #[test]
    fn fenced_code() {
        assert_eq!(
            html_to_markdown("<pre><code>const x = 1;\n</code></pre>"),
            "```\nconst x = 1;\n```"
        );
    }

    #[test]
    fn entities() {
        assert_eq!(
            html_to_markdown("<p>Tom &amp; Jerry &lt;3 &gt;. &nbsp; done</p>"),
            "Tom & Jerry <3 >. \u{a0} done"
        );
    }
}
