//! HTTP session layer. Port of AstroEX-node src/acquisition/jobspy/http.ts
//! (vendored ts-jobspy util.ts): rotating proxies, retry, and
//! description-format conversion.

use crate::acquisition::markdown;
use crate::acquisition::types::DescriptionFormat;
use crate::context::abortable_delay;
use crate::error::{AppError, Result};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_SECONDS: u64 = 30;
const RETRIES: u32 = 3;
const MAX_REDIRECTS: usize = 5;

fn client_builder(timeout: Duration, user_agent: &str) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .user_agent(user_agent)
}

/// Normalize a proxy string: `http(s)://` and `socks4/5://` pass through,
/// anything else is treated as a bare host and prefixed with `http://`.
fn normalize_proxy(proxy: &str) -> Option<String> {
    let trimmed = proxy.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("socks://")
        || lower.starts_with("socks4://")
        || lower.starts_with("socks5://")
    {
        Some(trimmed.to_string())
    } else {
        Some(format!("http://{trimmed}"))
    }
}

pub struct JobSpySession {
    client: reqwest::Client,
    proxies: Vec<String>,
    proxy_index: AtomicUsize,
    user_agent: String,
    timeout: Duration,
    has_retry: bool,
    retry_delay_seconds: u32,
}

impl JobSpySession {
    pub fn new(
        proxies: &[String],
        user_agent: Option<&str>,
        has_retry: bool,
        retry_delay_seconds: u32,
    ) -> Self {
        let user_agent = user_agent
            .filter(|ua| !ua.is_empty())
            .unwrap_or(DEFAULT_USER_AGENT)
            .to_string();
        let proxies = proxies
            .iter()
            .filter_map(|p| normalize_proxy(p))
            .collect::<Vec<_>>();
        let timeout = Duration::from_secs(REQUEST_TIMEOUT_SECONDS);
        let client = client_builder(timeout, &user_agent)
            .build()
            .unwrap_or_default();
        Self {
            client,
            proxies,
            proxy_index: AtomicUsize::new(0),
            user_agent,
            timeout,
            has_retry,
            retry_delay_seconds,
        }
    }

    /// Round-robin next proxy, or the direct client when no proxies exist.
    /// A per-request client is built so the proxy rotates on every call.
    fn next_client(&self) -> Result<reqwest::Client> {
        if self.proxies.is_empty() {
            return Ok(self.client.clone());
        }
        let index = self.proxy_index.fetch_add(1, Ordering::SeqCst) % self.proxies.len();
        let proxy_url = self.proxies[index].clone();
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| AppError::message(format!("invalid proxy {proxy_url}: {e}")))?;
        client_builder(self.timeout, &self.user_agent)
            .proxy(proxy)
            .build()
            .map_err(|e| AppError::message(format!("failed to build proxied client: {e}")))
    }

    pub async fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        token: &CancellationToken,
    ) -> Result<reqwest::Response> {
        self.execute(reqwest::Method::GET, url, headers, None, None, token)
            .await
    }

    pub async fn post(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
        token: &CancellationToken,
    ) -> Result<reqwest::Response> {
        self.execute(reqwest::Method::POST, url, headers, Some(body), None, token)
            .await
    }

    /// POST with a per-request timeout override (Indeed uses 10s).
    pub async fn post_with_timeout(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
        timeout: Duration,
        token: &CancellationToken,
    ) -> Result<reqwest::Response> {
        self.execute(
            reqwest::Method::POST,
            url,
            headers,
            Some(body),
            Some(timeout),
            token,
        )
        .await
    }

    async fn execute(
        &self,
        method: reqwest::Method,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
        timeout_override: Option<Duration>,
        token: &CancellationToken,
    ) -> Result<reqwest::Response> {
        let max_attempts = if self.has_retry { 1 + RETRIES } else { 1 };
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let client = self.next_client()?;
            let timeout = timeout_override.unwrap_or(self.timeout);
            let mut request = client.request(method.clone(), url).timeout(timeout);
            let has_user_agent = headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case("user-agent"));
            if !has_user_agent {
                request = request.header(reqwest::header::USER_AGENT, &self.user_agent);
            }
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            if let Some(body) = body {
                request = request.body(body.to_string());
            }
            let send = request.send();
            let result = tokio::select! {
                response = send => response,
                _ = token.cancelled() => {
                    return Err(AppError::message(
                        "Pipeline cancelled before operation started",
                    ));
                }
            };
            match result {
                Err(err) => {
                    if attempt < max_attempts {
                        abortable_delay(
                            attempt as u64 * self.retry_delay_seconds as u64 * 1000,
                            token,
                        )
                        .await?;
                        continue;
                    }
                    return Err(AppError::message(err.to_string()));
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    if (200..400).contains(&status) {
                        return Ok(response);
                    }
                    let error = AppError::new(
                        &format!("HTTP_{status}"),
                        status,
                        format!("Request failed with status code {status}"),
                    );
                    let retryable = matches!(status, 429 | 500 | 502 | 503 | 504);
                    if retryable && attempt < max_attempts {
                        abortable_delay(
                            attempt as u64 * self.retry_delay_seconds as u64 * 1000,
                            token,
                        )
                        .await?;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }
}

/// Port of descriptionToFormat: html as-is, plain via scraper text with
/// whitespace collapsed, markdown via the custom converter.
pub fn description_to_format(html: &str, format: DescriptionFormat) -> String {
    match format {
        DescriptionFormat::Html => html.to_string(),
        DescriptionFormat::Plain => {
            let text = fragment_text(html);
            collapse_whitespace(&text)
        }
        DescriptionFormat::Markdown => markdown::html_to_markdown(html),
    }
}

/// cheerio `.text()` equivalent: concatenated text of the whole fragment.
fn fragment_text(html: &str) -> String {
    let fragment = scraper::Html::parse_fragment(html);
    fragment.root_element().text().collect::<String>()
}

/// `.replace(/\s+/g, " ").trim()` equivalent.
pub(crate) fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_ws = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn redirect_server(final_hop: usize) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind redirect fixture");
        let address = listener.local_addr().expect("fixture address");
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = vec![0; 2048];
                let Ok(read) = stream.read(&mut request).await else {
                    continue;
                };
                let first_line = String::from_utf8_lossy(&request[..read])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let path = first_line.split_whitespace().nth(1).unwrap_or("/0");
                let hop = path.trim_start_matches('/').parse::<usize>().unwrap_or(0);
                let response = if hop < final_hop {
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: /{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        hop + 1
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                        .to_string()
                };
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{address}/0"), task)
    }

    #[test]
    fn normalize_proxy_variants() {
        assert_eq!(normalize_proxy("host:8080").unwrap(), "http://host:8080");
        assert_eq!(normalize_proxy("http://h:1").unwrap(), "http://h:1");
        assert_eq!(normalize_proxy("https://h:1").unwrap(), "https://h:1");
        assert_eq!(normalize_proxy("socks5://h:1").unwrap(), "socks5://h:1");
        assert!(normalize_proxy("  ").is_none());
    }

    #[test]
    fn description_plain_collapses_whitespace() {
        let html = "<div>Hello\n\n  world</div>\n<p>Foo   bar</p>";
        assert_eq!(
            description_to_format(html, DescriptionFormat::Plain),
            "Hello world Foo bar"
        );
    }

    #[test]
    fn description_html_passthrough() {
        let html = "<p>Hi</p>";
        assert_eq!(
            description_to_format(html, DescriptionFormat::Html),
            "<p>Hi</p>"
        );
    }

    #[tokio::test]
    async fn follows_at_most_five_redirects() {
        let token = CancellationToken::new();
        let session = JobSpySession::new(&[], None, false, 0);

        let (five_hops, five_hop_server) = redirect_server(MAX_REDIRECTS).await;
        let response = session
            .get(&five_hops, &[], &token)
            .await
            .expect("five redirects should be accepted");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert!(response.url().path().ends_with("/5"));
        five_hop_server.abort();

        let (six_hops, six_hop_server) = redirect_server(MAX_REDIRECTS + 1).await;
        let error = session
            .get(&six_hops, &[], &token)
            .await
            .expect_err("a sixth redirect must be rejected");
        assert!(
            error.message.to_ascii_lowercase().contains("redirect"),
            "unexpected redirect error: {}",
            error.message
        );
        six_hop_server.abort();
    }
}
