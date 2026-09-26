//! CLI entry. Parse once, construct RunContext once, then dispatch.
//! Clap normally uses exit code 2 for usage errors; AstroEX used 1, so errors
//! are printed manually and consistently mapped here.

pub mod commands;
pub mod global;

use clap::{error::ErrorKind, Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

use crate::commands as app_commands;
use crate::context::RunContext;
use crate::error::{AppError, Result};
use crate::pipeline::{config as pipeline_config, orchestration};
use crate::stages::acquire_jobs::{self, AcquireJobsOptions};
use crate::stages::enrich_jobs::{self, EnrichJobsOptions};
use crate::stages::job_cloth::{self, JobClothOptions};
use crate::stages::job_judge::{self, JobJudgeOptions};
use crate::stages::make_materials::{self, MakeMaterialsOptions};
use crate::stages::process_data::{self, ProcessDataOptions};
use crate::{acquisition::types::DescriptionFormat, acquisition::DescriptionMode};
use global::{parse_bool, GlobalArgs};

#[derive(Debug, Parser)]
#[command(
    name = "astroom",
    version,
    about = "AstroOM job acquisition, evaluation, and materials pipeline"
)]
struct Cli {
    #[command(flatten)]
    global: GlobalArgs,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Acquire jobs from Indeed and LinkedIn into canonical JSON artifacts.
    #[command(name = "acquire-jobs")]
    AcquireJobs(Box<AcquireJobsArgs>),
    /// Normalize and filter acquired job artifacts for downstream stages.
    #[command(name = "processData")]
    ProcessData(Box<ProcessDataArgs>),
    /// Classify processed job titles using the selected LLM preset.
    #[command(name = "jobCloth")]
    JobCloth(Box<JobClothArgs>),
    /// Fill missing descriptions and metadata for LinkedIn job records.
    #[command(name = "enrich-jobs")]
    EnrichJobs(Box<EnrichJobsArgs>),
    /// Evaluate full job descriptions and write pass/fail/duplicate artifacts.
    #[command(name = "jobJudge")]
    JobJudge(Box<JobJudgeArgs>),
    /// Generate tailored resume and cover-letter materials for passed jobs.
    #[command(name = "makeMaterials")]
    MakeMaterials(Box<MakeMaterialsArgs>),
    /// Orchestrate all eight pipeline stages in-process.
    #[command(name = "run-pipeline", args_override_self = true)]
    RunPipeline(Box<RunPipelineArgs>),
    /// Verify an artifact against its companion SHA-256 manifest.
    Artifact {
        #[command(subcommand)]
        command: ArtifactCommand,
    },
    /// Inspect, verify, back up, or rotate the SQLite job repository.
    Jobdb(JobDbArgs),
    /// Validate offline runtime prerequisites.
    Preflight(PreflightArgs),
}

#[derive(Debug, Args)]
struct AcquireJobsArgs {
    #[arg(long, visible_alias = "job-provider", default_value = "indeed")]
    sites: String,
    #[arg(long, default_value = "")]
    search_terms: String,
    #[arg(long, value_name = "PATH")]
    search_terms_file: Option<PathBuf>,
    #[arg(long, default_value = "")]
    locations: String,
    #[arg(long, default_value_t = 25)]
    results_wanted: u32,
    #[arg(long, default_value_t = 50)]
    distance: u32,
    #[arg(long)]
    hours_old: Option<u32>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    remote: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    remote_only: Option<bool>,
    #[arg(long, value_parser = parse_job_type)]
    job_type: Option<String>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    easy_apply: Option<bool>,
    #[arg(long, default_value = "USA")]
    indeed_country: String,
    #[arg(long, default_value = "full", value_parser = parse_description_mode)]
    description_mode: DescriptionMode,
    #[arg(long, default_value = "markdown", value_parser = parse_description_format)]
    description_format: DescriptionFormat,
    #[arg(long, default_value = "")]
    proxies: String,
    #[arg(long)]
    user_agent: Option<String>,
    #[arg(long, value_name = "PATH")]
    output_file: Option<PathBuf>,
    #[arg(long, value_name = "PATH")]
    output_file_indeed: Option<PathBuf>,
    #[arg(long, value_name = "PATH")]
    output_file_linkedin: Option<PathBuf>,
    #[arg(long, default_value_t = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    use_jobdb: bool,
}

#[derive(Debug, Args)]
struct ProcessDataArgs {
    #[arg(long, short = 'i', value_name = "PATH")]
    input_dir: Option<PathBuf>,
    #[arg(long)]
    input_files: Option<String>,
    #[arg(long, short = 'o', value_name = "PATH")]
    output_file: Option<PathBuf>,
    #[arg(long, default_value = "")]
    company_filters: String,
    #[arg(long, default_value = "")]
    title_filters: String,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    remote_only: Option<bool>,
    #[arg(long, default_value_t = crate::constants::DEFAULT_JOBCLOTH_COOL_OFF_DAYS)]
    jobcloth_cool_off_days: i64,
    #[arg(long, short = 'b', default_value_t = 1000)]
    batch_size: usize,
    #[arg(long, visible_alias = "smin", default_value_t = 0.0)]
    sleep_min: f64,
    #[arg(long, visible_alias = "smax", default_value_t = 0.0)]
    sleep_max: f64,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    log_cool_offs: Option<bool>,
}

#[derive(Debug, Args)]
struct JobClothArgs {
    #[arg(long, short = 'i', value_name = "PATH")]
    input_file: Option<PathBuf>,
    #[arg(long, short = 'o', value_name = "PATH")]
    output_file: Option<PathBuf>,
    #[arg(long)]
    preset: String,
    #[arg(long, default_value_t = 100)]
    batch: usize,
    #[arg(long)]
    temperature: Option<f64>,
    #[arg(long = "top-p", visible_alias = "topP")]
    top_p: Option<f64>,
    #[arg(long = "max-tokens")]
    max_tokens: Option<u32>,
    #[arg(long, short = 's', default_value_t = 1.0)]
    sleep: f64,
    #[arg(long = "jc-reasoning-effort", visible_alias = "reasoning-effort")]
    reasoning_effort: Option<String>,
    #[arg(long, default_value_t = 60)]
    openai_timeout: u64,
    #[arg(long, default_value_t = 3)]
    batch_retry_attempts: u32,
    #[arg(long, default_value_t = 5000)]
    batch_retry_delay: u64,
    #[arg(long, default_value_t = 2)]
    job_title_retry_attempts: u32,
    #[arg(long, default_value_t = 0.5)]
    circuit_threshold: f64,
    #[arg(long, default_value_t = 60)]
    circuit_timeout: u64,
    #[arg(long)]
    base_url: Option<String>,
    #[arg(long)]
    model_id: Option<String>,
    #[arg(long)]
    retries: Option<u32>,
    #[arg(long)]
    ping_interval: Option<u64>,
    #[arg(long, alias = "ss", num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream_tokens: Option<bool>,
}

#[derive(Debug, Args)]
struct EnrichJobsArgs {
    #[arg(long, value_name = "PATH")]
    input_file: PathBuf,
    #[arg(long, value_name = "PATH")]
    output_file: PathBuf,
    #[arg(long, default_value_t = 1000)]
    delay: u64,
    #[arg(long, default_value = "markdown", value_parser = parse_description_format)]
    description_format: DescriptionFormat,
    #[arg(long, default_value = "")]
    proxies: String,
    #[arg(long)]
    user_agent: Option<String>,
    #[arg(long, default_value_t = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    use_jobdb: bool,
}

#[derive(Debug, Args)]
struct JobJudgeArgs {
    #[arg(
        long,
        default_value = "./data/clothed_jobs_*.json",
        value_name = "PATH"
    )]
    input_file: PathBuf,
    #[arg(long, default_value = "./data/astroapply_eval_", value_name = "PATH")]
    output_file: PathBuf,
    #[arg(long)]
    preset: String,
    #[arg(long, default_value_t = 4)]
    eval_mode: u32,
    #[arg(long, default_value_t = 2.0)]
    sleep: f64,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    strict_parsing: Option<bool>,
    #[arg(long, default_value_t = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    use_jobdb: bool,
    #[arg(long)]
    max_tokens: Option<u32>,
    #[arg(long = "jj-reasoning-effort", visible_alias = "reasoning-effort")]
    reasoning_effort: Option<String>,
    #[arg(long, alias = "ss", num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream_tokens: Option<bool>,
}

#[derive(Debug, Args)]
struct MakeMaterialsArgs {
    #[arg(long)]
    preset: String,
    #[arg(long)]
    targ_jd: Option<String>,
    #[arg(long, default_value_t = 275)]
    cover_length: u32,
    #[arg(long, default_value_t = 2.5)]
    sleep_min: f64,
    #[arg(long, default_value_t = 4.5)]
    sleep_max: f64,
    #[arg(long, default_value_t = true, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    jitter: bool,
    #[arg(long)]
    temperature: Option<f64>,
    #[arg(long = "top-p", visible_alias = "topP")]
    top_p: Option<f64>,
    #[arg(long = "max-tokens")]
    max_tokens: Option<u32>,
    #[arg(long = "mm-reasoning-effort", visible_alias = "reasoning-effort")]
    reasoning_effort: Option<String>,
    #[arg(long)]
    resume: Option<String>,
    #[arg(long)]
    testimonials: Option<String>,
    #[arg(long)]
    my_professional_title: Option<String>,
    #[arg(long)]
    my_professional_summary: Option<String>,
    #[arg(long)]
    my_key_skills: Option<String>,
    #[arg(long, default_value_t = 3)]
    max_retries: u32,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    use_sys_prompt: Option<bool>,
    #[arg(long, default_value_t = 0)]
    test_mode: u32,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    thoughts: Option<bool>,
    #[arg(long, alias = "ss", num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    show_stream_tokens: Option<bool>,
}
#[derive(Debug, Args)]
struct RunPipelineArgs {
    #[arg(long, visible_alias = "sites", default_value = "indeed")]
    job_provider: String,
    #[arg(long)]
    search_terms_file: Option<PathBuf>,
    #[arg(long, default_value_t = 9999)]
    results_wanted: u32,
    #[arg(long)]
    hours_old: Option<u32>,
    #[arg(long,num_args=0..=1,default_missing_value="true",value_parser=parse_bool)]
    remote_only: Option<bool>,
    #[arg(long, default_value_t = 25)]
    batch: usize,
    #[arg(long, default_value_t = 5.0)]
    sleep: f64,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    clean: Option<bool>,
    #[arg(long)]
    resume: Option<String>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    skip_acquisition: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    skip_materials: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    deploy: Option<bool>,
    #[arg(long)]
    deploy_destination: Option<String>,
    #[arg(long, value_name = "PATH")]
    deployed_materials_dir: Option<PathBuf>,
    #[arg(long,num_args=0..=1,default_missing_value="8.8.8.8")]
    internet_watchdog: Option<String>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    track_or_costs: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    log_cool_offs: Option<bool>,
    #[arg(long, default_value = "jc_glm-5.3-flash")]
    jobcloth_preset: String,
    #[arg(long, default_value = "re_glm-5.3-flash")]
    remoteeval_preset: String,
    #[arg(long, default_value = "jep_glm-5.3-flash")]
    jobjudge_preset: String,
    #[arg(long, default_value = "rop_g5.6-luna_or")]
    makematerials_preset: String,
    #[arg(long, default_value_t = crate::constants::DEFAULT_JOBCLOTH_COOL_OFF_DAYS)]
    jobcloth_cool_off_days: i64,
    #[arg(long)]
    jc_reasoning_effort: Option<String>,
    #[arg(long)]
    re_reasoning_level: Option<String>,
    #[arg(long)]
    jj_reasoning_effort: Option<String>,
    #[arg(long)]
    mm_reasoning_effort: Option<String>,
    #[arg(long)]
    jc_provider: Option<String>,
    #[arg(long)]
    re_provider: Option<String>,
    #[arg(long)]
    jj_provider: Option<String>,
    #[arg(long)]
    mm_provider: Option<String>,
    #[arg(long)]
    provider_ignore: Option<String>,
    #[arg(long)]
    jc_provider_quant: Option<String>,
    #[arg(long)]
    re_provider_quant: Option<String>,
    #[arg(long, alias = "j-provider-quant")]
    jj_provider_quant: Option<String>,
    #[arg(long)]
    mm_provider_quant: Option<String>,
    #[arg(long = "astro_auto_provider-top")]
    astro_auto_provider_top: Option<u32>,
}

#[derive(Debug, Subcommand)]
enum ArtifactCommand {
    Verify { file: PathBuf },
}

#[derive(Debug, Args)]
struct JobDbArgs {
    #[arg(value_enum)]
    action: JobDbAction,
    #[arg(long, default_value_t = 10)]
    keep: usize,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum JobDbAction {
    Status,
    Verify,
    Backup,
    RotateBackups,
}

impl JobDbAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Verify => "verify",
            Self::Backup => "backup",
            Self::RotateBackups => "rotate-backups",
        }
    }
}

fn parse_job_type(value: &str) -> std::result::Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "fulltime" | "parttime" | "contract" | "internship" => {
            Ok(value.trim().to_ascii_lowercase())
        }
        _ => Err("expected fulltime, parttime, contract, or internship".to_string()),
    }
}

fn parse_description_mode(value: &str) -> std::result::Result<DescriptionMode, String> {
    DescriptionMode::parse(value).ok_or_else(|| "expected none, available, or full".to_string())
}

fn parse_description_format(value: &str) -> std::result::Result<DescriptionFormat, String> {
    DescriptionFormat::parse(value).ok_or_else(|| "expected markdown, html, or plain".to_string())
}

fn parse_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Node parseCommaSeparatedList: a comma list that yields no entries is None.
fn optional_list(value: Option<String>) -> Option<Vec<String>> {
    let list = value.map(|value| parse_list(&value)).unwrap_or_default();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Node `findProcessedJobFiles`: files in the data directory whose name starts
/// with `processed_jobs` and ends with `.json`. Directory order is preserved
/// (the Node implementation uses `readdir` without sorting).
fn find_processed_job_files(data_dir: &std::path::Path) -> Result<Vec<PathBuf>> {
    let entries = std::fs::read_dir(data_dir).map_err(|error| {
        AppError::message(format!(
            "Data directory is not accessible: {} ({error})",
            data_dir.display()
        ))
    })?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            AppError::message(format!("Failed to read data directory: {error}"))
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("processed_jobs") && name.ends_with(".json") {
            files.push(entry.path());
        }
    }
    Ok(files)
}

fn seconds_to_millis(name: &str, seconds: f64) -> Result<u64> {
    if !seconds.is_finite() || seconds < 0.0 || seconds * 1000.0 > u64::MAX as f64 {
        return Err(AppError::message(format!(
            "{name} must be a non-negative finite number"
        )));
    }
    Ok((seconds * 1000.0) as u64)
}

/// Node replaces the literal default `./data/clothed_jobs.json` with a
/// timestamped filename even when the caller supplies that value explicitly.
/// The Rust CLI stores the default as `None`, so both representations must
/// take the same path here.
fn resolve_job_cloth_output(output: Option<PathBuf>, data_dir: &std::path::Path) -> PathBuf {
    let uses_default = output.is_none()
        || output
            .as_ref()
            .is_some_and(|path| path.to_string_lossy() == "./data/clothed_jobs.json");
    if uses_default {
        data_dir.join(format!(
            "clothed_jobs_{}.json",
            crate::utils::format_date_now("yyyyMMdd_HHmmss")
        ))
    } else {
        output.expect("non-default output checked above")
    }
}

#[derive(Debug, Args)]
struct PreflightArgs {
    #[arg(long)]
    presets: Option<String>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    require_api_key: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool)]
    check_deployment: Option<bool>,
    #[arg(long)]
    deploy_destination: Option<String>,
}

pub fn run_cli() -> i32 {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let exit_code = if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) {
                0
            } else {
                1
            };
            let _ = error.print();
            return exit_code;
        }
    };
    if cli.global.record_logo_gif {
        return match crate::utils::gif_export::record_logo_gif() {
            Ok(path) => {
                println!("Recorded animated logo to {}", path.display());
                0
            }
            Err(error) => {
                eprintln!("Error: failed to generate logo GIF: {error}");
                1
            }
        };
    }
    let command = match cli.command {
        Some(cmd) => cmd,
        None => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            let err = cmd.error(
                ErrorKind::MissingSubcommand,
                "'astroom' requires a subcommand but one was not provided",
            );
            let _ = err.print();
            return 1;
        }
    };
    let suppress_banner = cli.global.no_banner || cli.global.json;
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let context = match cli.global.clone().into_context() {
        Ok(context) => context,
        Err(error) => {
            crate::logging::console_output::write_internal_console_failure(&format!(
                "Error: {error}"
            ));
            return 1;
        }
    };
    let mut context = context;
    if let Command::RunPipeline(args) = &command {
        if args.track_or_costs.unwrap_or(false) {
            context.usage_tracker = Some(std::sync::Arc::new(std::sync::Mutex::new(
                crate::llm::usage::OpenRouterUsageTracker::new(),
            )));
        }
    }
    if let Err(error) = initialize_runtime(&context, &raw_args, suppress_banner) {
        crate::logging::console_output::write_internal_console_failure(&format!("Error: {error}"));
        return 1;
    }
    let result = dispatch(command, &context);
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            crate::logging::log_error("AstroOM", &error, crate::types::LogLevel::Error);
            if error.status_code == 130 || error.status_code == 143 {
                error.status_code as i32
            } else {
                1
            }
        }
    };
    crate::logging::execution_log::close_execution_log();
    code
}

fn initialize_runtime(
    context: &RunContext,
    raw_args: &[String],
    suppress_banner: bool,
) -> Result<()> {
    std::fs::create_dir_all(&context.paths.data_dir)?;
    crate::logging::configure_logging(
        context.display.log_format,
        context.display.initial_log_level(),
        context.display.use_color(),
    );
    if !suppress_banner {
        crate::utils::display_banner(context.display.use_color(), context.display.banner_loops);
    }
    crate::logging::execution_log::initialize_execution_log(&context.paths.log_dir, raw_args)
        .map_err(|error| {
            AppError::message(format!("Failed to initialize execution log: {error}"))
        })?;
    Ok(())
}

fn dispatch(command: Command, context: &RunContext) -> Result<i32> {
    match command {
        Command::AcquireJobs(args) => {
            if args.hours_old.is_some_and(|hours| hours == 0) {
                return Err(AppError::message(
                    "--hours-old must be greater than zero when supplied",
                ));
            }
            let options = AcquireJobsOptions {
                sites: acquire_jobs::parse_sources(&args.sites)?,
                search_terms: parse_list(&args.search_terms),
                search_terms_file: args
                    .search_terms_file
                    .unwrap_or_else(|| context.paths.profile_dir.join("search_terms.txt")),
                locations: parse_list(&args.locations),
                results_wanted: args.results_wanted,
                distance: args.distance,
                hours_old: args.hours_old,
                remote: args.remote.unwrap_or(false),
                remote_only: args.remote_only.unwrap_or(false),
                job_type: args.job_type,
                easy_apply: args.easy_apply.unwrap_or(false),
                indeed_country: args.indeed_country,
                description_mode: args.description_mode,
                description_format: args.description_format,
                proxies: parse_list(&args.proxies),
                user_agent: args.user_agent,
                output_file: args.output_file,
                output_file_indeed: args.output_file_indeed,
                output_file_linkedin: args.output_file_linkedin,
                use_jobdb: args.use_jobdb,
            };
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(acquire_jobs::run(context, &options))?;
            Ok(0)
        }
        Command::ProcessData(args) => {
            let sleep_min_ms = seconds_to_millis("--sleep-min", args.sleep_min)?;
            let sleep_max_ms = seconds_to_millis("--sleep-max", args.sleep_max)?;
            let options = ProcessDataOptions {
                input_directory: args
                    .input_dir
                    .unwrap_or_else(|| context.paths.data_dir.clone()),
                input_files: args.input_files.map_or_else(Vec::new, |files| {
                    parse_list(&files).into_iter().map(PathBuf::from).collect()
                }),
                scan_input_directory: true,
                output_file: args
                    .output_file
                    .unwrap_or_else(|| context.paths.data_dir.join("processed_jobs.json")),
                company_filters: parse_list(&args.company_filters),
                title_filters: parse_list(&args.title_filters),
                remote_only: args.remote_only.unwrap_or(false),
                jobcloth_cool_off_days: args.jobcloth_cool_off_days,
                batch_size: args.batch_size,
                sleep_min_ms,
                sleep_max_ms,
                log_cool_offs: args.log_cool_offs.unwrap_or(false),
            };
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(process_data::run(context, &options))?;
            Ok(0)
        }
        Command::JobCloth(args) => {
            let options = JobClothOptions {
                preset: args.preset,
                batch: args.batch,
                temperature: args.temperature,
                top_p: args.top_p,
                max_tokens: args.max_tokens,
                sleep_ms: seconds_to_millis("--sleep", args.sleep)?,
                reasoning_effort: args.reasoning_effort,
                provider_routing: None,
                openai_timeout_s: args.openai_timeout,
                batch_retry_attempts: args.batch_retry_attempts,
                batch_retry_delay_ms: args.batch_retry_delay,
                job_title_retry_attempts: args.job_title_retry_attempts,
                circuit_threshold: args.circuit_threshold,
                circuit_timeout_s: args.circuit_timeout,
                show_reasoning: context.display.show_reasoning,
                show_stream: args.show_stream.unwrap_or(false)
                    || args.show_stream_tokens.unwrap_or(false),
            };
            let _ = (
                args.base_url,
                args.model_id,
                args.retries,
                args.ping_interval,
            );
            let explicit_input = args.input_file.clone();
            let uses_default_input = explicit_input.is_none()
                || explicit_input.as_ref().is_some_and(|path| {
                    let normalized = path.to_string_lossy().replace('\\', "/");
                    normalized == "./data/processed_jobs_*.json"
                        || normalized == "./data/processed_jobs.json"
                });
            let inputs: Vec<PathBuf> = if uses_default_input {
                let files = find_processed_job_files(&context.paths.data_dir)?;
                if files.is_empty() {
                    return Err(AppError::message(
                        "No processed_jobs*.json files found in ./data/ directory. Please run processData first or provide a specific input file.",
                    ));
                }
                if context.display.verbose {
                    crate::logging::log(
                        "JobCloth",
                        &format!(
                            "Auto-detected {} processed job files for processing",
                            files.len()
                        ),
                        crate::types::LogLevel::Info,
                    );
                }
                files
            } else {
                vec![explicit_input.unwrap()]
            };
            let output = resolve_job_cloth_output(args.output_file, &context.paths.data_dir);
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(job_cloth::run(context, &inputs, &output, &options))?;
            Ok(0)
        }
        Command::EnrichJobs(args) => {
            let options = EnrichJobsOptions {
                input_file: args.input_file,
                output_file: args.output_file,
                delay_ms: args.delay,
                description_format: args.description_format,
                proxies: parse_list(&args.proxies),
                user_agent: args.user_agent,
                use_jobdb: args.use_jobdb,
            };
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(enrich_jobs::run(context, &options))?;
            Ok(0)
        }
        Command::JobJudge(args) => {
            let options = JobJudgeOptions {
                input_file: args.input_file,
                output_file: args.output_file,
                preset: args.preset,
                eval_mode: args.eval_mode,
                sleep_ms: seconds_to_millis("--sleep", args.sleep)?,
                strict_parsing: args.strict_parsing.unwrap_or(false),
                use_jobdb: args.use_jobdb,
                max_tokens: args.max_tokens,
                reasoning_effort: args.reasoning_effort,
                provider_routing: None,
                show_reasoning: context.display.show_reasoning,
                show_stream: args.show_stream.unwrap_or(false)
                    || args.show_stream_tokens.unwrap_or(false),
            };
            if options.max_tokens == Some(0) {
                return Err(AppError::message("--max-tokens must be positive"));
            }
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(job_judge::run(context, &options))?;
            Ok(0)
        }
        Command::MakeMaterials(args) => {
            let sleep_min_ms = seconds_to_millis("--sleep-min", args.sleep_min)?;
            let sleep_max_ms = seconds_to_millis("--sleep-max", args.sleep_max)?;
            if sleep_min_ms > sleep_max_ms {
                return Err(AppError::message(
                    "--sleep-min cannot be greater than --sleep-max",
                ));
            }
            if args.max_tokens == Some(0) {
                return Err(AppError::message("--max-tokens must be positive"));
            }
            let options = MakeMaterialsOptions {
                preset: args.preset,
                targ_jd: args.targ_jd,
                cover_length: args.cover_length,
                sleep_min_ms,
                sleep_max_ms,
                jitter: args.jitter,
                temperature: args.temperature,
                top_p: args.top_p,
                max_tokens: args.max_tokens,
                reasoning_effort: args.reasoning_effort,
                provider_routing: None,
                resume: args.resume,
                testimonials: args.testimonials,
                professional_title: args.my_professional_title,
                professional_summary: args.my_professional_summary,
                key_skills: args.my_key_skills,
                show_reasoning: context.display.show_reasoning,
                show_stream: args.show_stream.unwrap_or(false)
                    || args.show_stream_tokens.unwrap_or(false),
                suppress_errors: false,
            };
            let _ = (
                args.max_retries,
                args.use_sys_prompt,
                args.test_mode,
                args.thoughts,
            );
            let runtime = tokio::runtime::Runtime::new().map_err(|error| {
                AppError::message(format!("Unable to start async runtime: {error}"))
            })?;
            runtime.block_on(make_materials::run(context, &options))?;
            Ok(0)
        }
        Command::RunPipeline(args) => {
            let config = pipeline_config::build(
                context,
                pipeline_config::PipelineConfigArgs {
                    sites: args.job_provider,
                    search_terms_file: args.search_terms_file,
                    results_wanted: args.results_wanted,
                    hours_old: args.hours_old,
                    remote_only: args.remote_only.unwrap_or(false),
                    batch_size: args.batch,
                    sleep_ms: seconds_to_millis("--sleep", args.sleep)?,
                    clean: args.clean.unwrap_or(false),
                    resume: args.resume,
                    skip_acquisition: args.skip_acquisition.unwrap_or(false),
                    skip_materials: args.skip_materials.unwrap_or(false),
                    deploy: args.deploy.unwrap_or(false),
                    deploy_destination: args.deploy_destination,
                    deployed_materials_dir: args.deployed_materials_dir,
                    internet_watchdog: args.internet_watchdog,
                    track_openrouter_costs: args.track_or_costs.unwrap_or(false),
                    log_cool_offs: args.log_cool_offs.unwrap_or(false),
                    jobcloth_preset: args.jobcloth_preset,
                    remoteeval_preset: args.remoteeval_preset,
                    jobjudge_preset: args.jobjudge_preset,
                    makematerials_preset: args.makematerials_preset,
                    reasoning_jobcloth: args.jc_reasoning_effort,
                    reasoning_remoteeval: args.re_reasoning_level,
                    reasoning_jobjudge: args.jj_reasoning_effort,
                    reasoning_makematerials: args.mm_reasoning_effort,
                    jobcloth_cool_off_days: args.jobcloth_cool_off_days,
                    astro_auto_provider_top: args
                        .astro_auto_provider_top
                        .unwrap_or(crate::astro_auto_provider::DEFAULT_TOP),
                    provider_ignore: optional_list(args.provider_ignore),
                    provider_only_jobcloth: optional_list(args.jc_provider),
                    provider_only_remoteeval: optional_list(args.re_provider),
                    provider_only_jobjudge: optional_list(args.jj_provider),
                    provider_only_makematerials: optional_list(args.mm_provider),
                    provider_quant_jobcloth: optional_list(args.jc_provider_quant),
                    provider_quant_remoteeval: optional_list(args.re_provider_quant),
                    provider_quant_jobjudge: optional_list(args.jj_provider_quant),
                    provider_quant_makematerials: optional_list(args.mm_provider_quant),
                },
            )?;
            let runtime = tokio::runtime::Runtime::new()
                .map_err(|e| AppError::message(format!("Unable to start async runtime: {e}")))?;
            runtime.block_on(orchestration::execute(context, &config))?;
            Ok(0)
        }
        Command::Artifact {
            command: ArtifactCommand::Verify { file },
        } => Ok(if app_commands::artifact::verify(&file)? {
            0
        } else {
            1
        }),
        Command::Jobdb(args) => Ok(
            if app_commands::job_db::run(args.action.as_str(), args.keep, &context.paths.data_dir)?
            {
                0
            } else {
                1
            },
        ),
        Command::Preflight(args) => {
            let selected_presets = args
                .presets
                .map(|values| {
                    values
                        .split(',')
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let options = app_commands::preflight::PreflightOptions {
                require_api_key: args.require_api_key.unwrap_or(false),
                check_deployment: args.check_deployment.unwrap_or(false),
                deployment_destination: args.deploy_destination,
                selected_presets,
                selected_preset_categories: vec![],
            };
            let result = app_commands::preflight::run_preflight(context, &options)?;
            crate::logging::console_output::write_machine_json(&serde_json::to_value(&result)?);
            Ok(if result.valid { 0 } else { 1 })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boolean_values_accept_launcher_compatible_forms() {
        assert_eq!(parse_bool("true"), Ok(true));
        assert_eq!(parse_bool("1"), Ok(true));
        assert_eq!(parse_bool("false"), Ok(false));
        assert_eq!(parse_bool("0"), Ok(false));
        assert!(parse_bool("yes").is_err());
    }

    #[test]
    fn launcher_argv_parses() {
        let args = [
            "astroom",
            "run-pipeline",
            "--job-provider",
            "indeed,linkedin",
            "--search-terms-file",
            "/p/profile/search_terms.txt",
            "--api-key",
            "test-key",
            "--jobcloth-preset",
            "jc_glm-5.3-flash",
            "--remoteeval-preset",
            "re_glm-5.3-flash",
            "--jobjudge-preset",
            "jep_glm-5.3-flash",
            "--makematerials-preset",
            "rop_glm-5.3-flash",
            "--batch",
            "10",
            "--sleep",
            "2",
            "--results-wanted",
            "200",
            "--hours-old",
            "24",
            "--jc-provider",
            "astro_auto_provider",
            "--jc-provider-quant",
            "fp8",
            "--jc-reasoning-effort",
            "low",
            "--re-provider",
            "astro_auto_provider",
            "--re-provider-quant",
            "fp8",
            "--re-reasoning-level",
            "high",
            "--jj-provider",
            "astro_auto_provider",
            "--j-provider-quant",
            "fp8",
            "--jj-reasoning-effort",
            "high",
            "--mm-provider",
            "astro_auto_provider",
            "--mm-provider-quant",
            "fp8",
            "--mm-reasoning-effort",
            "high",
            "--astro_auto_provider-top",
            "3",
            "--remote-only",
            "true",
            "--track-or-costs",
            "--internet-watchdog",
            "--log-cool-offs",
        ];
        let cli = Cli::try_parse_from(args).expect("launcher argv should parse");
        match cli.command {
            Some(Command::RunPipeline(_)) => {}
            _ => panic!("expected run-pipeline"),
        }
        let context = cli.global.into_context().expect("context builds");
        assert_eq!(context.api_key.as_deref(), Some("test-key"));
    }

    #[test]
    fn caller_arguments_override_launcher_policy_values() {
        let cli = Cli::try_parse_from([
            "astroom",
            "run-pipeline",
            "--batch",
            "10",
            "--remote-only",
            "true",
            "--clean",
            "--track-or-costs",
            // astro_launcher.bash appends caller-supplied arguments last.
            "--batch",
            "1",
            "--remote-only",
            "false",
            "--clean",
            "false",
            "--track-or-costs",
            "0",
        ])
        .expect("last repeated values should win like yargs");

        let Some(Command::RunPipeline(args)) = cli.command else {
            panic!("expected run-pipeline");
        };
        assert_eq!(args.batch, 1);
        assert_eq!(args.remote_only, Some(false));
        assert_eq!(args.clean, Some(false));
        assert_eq!(args.track_or_costs, Some(false));
    }

    #[test]
    fn job_cloth_default_output_sentinel_is_timestamped() {
        let data_dir = std::path::Path::new("/tmp/astroom-data");
        for output in [None, Some(PathBuf::from("./data/clothed_jobs.json"))] {
            let resolved = resolve_job_cloth_output(output, data_dir);
            assert_eq!(resolved.parent(), Some(data_dir));
            let name = resolved.file_name().unwrap().to_string_lossy();
            assert!(name.starts_with("clothed_jobs_"), "{name}");
            assert!(name.ends_with(".json"), "{name}");
        }

        let custom = PathBuf::from("custom/jobs.json");
        assert_eq!(
            resolve_job_cloth_output(Some(custom.clone()), data_dir),
            custom
        );
    }

    #[test]
    fn top_p_camel_case_alias_matches_node() {
        let cli = Cli::try_parse_from([
            "astroom",
            "jobCloth",
            "--preset",
            "jc_glm-5.3-flash",
            "--topP",
            "0.8",
        ])
        .expect("Node-compatible --topP alias should parse");
        let Some(Command::JobCloth(args)) = cli.command else {
            panic!("expected jobCloth");
        };
        assert_eq!(args.top_p, Some(0.8));
    }
}
