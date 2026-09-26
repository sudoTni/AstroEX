//! Shared helpers for integration tests. Every test runs the real `astroom`
//! binary against an isolated temp sandbox.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_astroom"))
}

pub struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    pub fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("temp dir"),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn sub(&self, name: &str) -> PathBuf {
        let path = self.path().join(name);
        std::fs::create_dir_all(&path).expect("create subdir");
        path
    }

    /// Runs the binary with `args` in the sandbox cwd and the inherited env.
    pub fn run(&self, args: &[&str]) -> Output {
        Command::new(bin())
            .args(args)
            .current_dir(self.path())
            .output()
            .expect("run astroom")
    }

    /// Runs the binary with only OS-level variables present (no app config).
    pub fn run_scrubbed(&self, args: &[&str]) -> Output {
        let mut command = Command::new(bin());
        command
            .args(args)
            .current_dir(self.path())
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.path())
            .env("USERPROFILE", self.path())
            .env("TMPDIR", std::env::temp_dir());
        command.output().expect("run astroom")
    }
}

impl Default for Sandbox {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(unix)]
pub fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).expect("metadata").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).expect("chmod");
}

#[cfg(not(unix))]
pub fn set_executable(_path: &Path) {
    // No-op on Windows
}

#[cfg(unix)]
pub fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(not(unix))]
pub fn mode_of(_path: &Path) -> u32 {
    0o600
}

pub fn find_file_starting_with(dir: &Path, prefix: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix))
        })
}

/// Writes the two profile files the run-pipeline preflight requires.
pub fn populate_profile(profile: &Path) {
    std::fs::create_dir_all(profile).expect("profile dir");
    std::fs::write(profile.join("search_terms.txt"), "engineer\n").expect("search terms");
    std::fs::write(profile.join("my_resume.txt"), "resume body\n").expect("resume");
}

/// A minimal offline OpenAI-compatible HTTP server for pipeline tests. It
/// answers every `POST /chat/completions` with a JSON chat completion whose
/// content is selected from the request body (jobCloth / jobJudge /
/// makeMaterials), and it records every raw request body.
pub struct MockLlmServer {
    pub base_url: String,
    pub request_bodies: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl MockLlmServer {
    pub fn start() -> Self {
        Self::start_with_materials(false)
    }

    /// Starts the mock server. When `fail_materials` is set, makeMaterials
    /// requests receive a response with no parseable markdown sections, which
    /// the stage surfaces as an error (swallowed by the pipeline in Node).
    pub fn start_with_materials(fail_materials: bool) -> Self {
        Self::start_inner(fail_materials, 0)
    }

    /// Starts the mock server with a fixed delay before each response. Used by
    /// the signal tests so a request is reliably in flight when the signal is
    /// delivered.
    pub fn start_slow(delay_ms: u64) -> Self {
        Self::start_inner(false, delay_ms)
    }

    fn start_inner(fail_materials: bool, delay_ms: u64) -> Self {
        use std::io::Write as _;
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock llm server");
        let addr = listener.local_addr().expect("mock llm addr");
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let bodies_for_thread = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let body = read_http_request(&mut stream);
                bodies_for_thread
                    .lock()
                    .expect("mock llm bodies")
                    .push(body.clone());
                if delay_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
                let content = if fail_materials
                    && (body.contains("ROP v2.1") || body.contains("Resume Writer"))
                {
                    "no parseable sections here".to_string()
                } else {
                    mock_content_for(&body)
                };
                let payload = serde_json::json!({
                    "id": "mock-completion",
                    "model": "mock-model",
                    "choices": [{
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop"
                    }],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 10,
                        "total_tokens": 20,
                        "cost": 0.0
                    }
                })
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        Self {
            base_url: format!("http://{addr}"),
            request_bodies: bodies,
        }
    }

    pub fn calls(&self) -> usize {
        self.request_bodies.lock().expect("mock llm bodies").len()
    }
}

fn read_http_request(stream: &mut std::net::TcpStream) -> String {
    use std::io::Read as _;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .ok();
    let mut buffer = Vec::new();
    let mut temp = [0u8; 8192];
    loop {
        if let Some(position) = find_subslice(&buffer, b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&buffer[..position]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            if buffer.len() >= position + 4 + content_length {
                return String::from_utf8_lossy(&buffer[position + 4..]).to_string();
            }
        }
        match stream.read(&mut temp) {
            Ok(0) => return String::new(),
            Ok(n) => buffer.extend_from_slice(&temp[..n]),
            Err(_) => return String::new(),
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn mock_content_for(body: &str) -> String {
    if body.contains("TITLE-LEVEL SCREENING") || body.contains("job-title screening engine") {
        serde_json::json!([
            {
                "jobTitle": "Cloud Security Engineer",
                "isVeryHighlyAligned": true,
                "rationale": "Strong alignment with security profile.",
                "confidence": 0.95
            },
            {
                "jobTitle": "Sales Associate",
                "isVeryHighlyAligned": false,
                "rationale": "Not aligned.",
                "confidence": 0.1
            }
        ])
        .to_string()
    } else if body.contains("ROP v2.1") || body.contains("Resume Writer") {
        "# Resume Filename\nSample_Candidate_Materials_Cloud_Security_Engineer.txt\n\n\
         # Cover Letter Filename\nSample_Candidate_Cover_Letter_Acme_Security.txt\n\n\
         # Optimized & Tailored Professional Title\nLead Cloud Security Engineer\n\n\
         # Optimized & Tailored Professional Summary\nHigh-impact Security Engineer specialized in cloud infrastructure and DevSecOps.\n\n\
         # Optimized & Tailored Key Skills\n- Cloud Security Architecture\n- DevSecOps & CI/CD Security\n- IAM & Zero Trust\n\n\
         # Optimized & Tailored Cover Letter\nDear Hiring Team at Acme Security,\n\nI am thrilled to apply for the Cloud Security Engineer role..."
            .to_string()
    } else {
        serde_json::json!([
            {
                "jobTitle": "Cloud Security Engineer",
                "isVeryHighlyAligned": true,
                "rationale": "Candidate has deep cloud security experience.",
                "confidence": 0.96
            }
        ])
        .to_string()
    }
}

/// Writes the full set of profile files the stage tests expect.
pub fn populate_full_profile(profile: &Path) {
    populate_profile(profile);
    let files = [
        ("company_filters.txt", "BlocklistCorp\n"),
        ("title_filters.txt", "Intern\n"),
        ("my_professional_title.txt", "Cloud Security Engineer\n"),
        (
            "my_professional_summary.txt",
            "Expert in cloud security and zero trust architectures.\n",
        ),
        (
            "my_key_skills.txt",
            "Cloud Security, DevSecOps, Kubernetes, IAM\n",
        ),
        (
            "my_testimonials.txt",
            "The candidate is a top-tier security professional.\n",
        ),
    ];
    for (name, contents) in files {
        std::fs::write(profile.join(name), contents).expect("profile file");
    }
}
