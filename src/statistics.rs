//! Statistics collector. Ported from AstroEX-node src/statistics/StatisticsCollector.ts.

use crate::artifact_manifest::write_json_atomic_private;
use crate::constants::APP_VERSION;
use crate::error::Result;
use crate::logging::{log, log_kv};
use crate::types::LogLevel;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkKind {
    Connection,
    Timeout,
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Opened,
    Read,
    Written,
    Deleted,
}

#[derive(Debug, Clone)]
struct Timer {
    operation: String,
    start: Instant,
}

#[derive(Debug, Clone)]
struct ErrorDetail {
    timestamp: String,
    category: String,
    message: String,
}

#[derive(Default)]
struct FileCounts {
    opened: u64,
    read: u64,
    written: u64,
    deleted: u64,
}

#[derive(Default)]
struct NetworkCounts {
    connections: u64,
    timeouts: u64,
    retries: u64,
}

#[derive(Default)]
struct ApiCounts {
    total_calls: u64,
    successful_calls: u64,
    failed_calls: u64,
    retries: u64,
    circuit_breaker_trips: u64,
    repetition_errors: u64,
}

#[derive(Default)]
struct DataCounts {
    records_processed: u64,
    records_filtered: u64,
    duplicates_removed: u64,
    files_processed: u64,
}

pub struct StatisticsCollector {
    command: String,
    start_time: chrono::DateTime<chrono::Utc>,
    end_time: Option<chrono::DateTime<chrono::Utc>>,
    duration_ms: Option<i64>,
    session_id: String,

    total_execution_time: f64,
    operation_times: HashMap<String, f64>,

    memory_peak: u64,
    memory_average: f64,
    memory_start: u64,
    memory_end: u64,
    memory_samples: Vec<u64>,

    cpu_time_ms: f64,
    garbage_collections: u64,
    cpu_ticks_start: Option<(u64, u64)>,

    operations_total: u64,
    operations_successful: u64,
    operations_failed: u64,
    operations_warnings: u64,

    files: FileCounts,
    network: NetworkCounts,
    api: ApiCounts,
    data: DataCounts,

    errors_by_category: HashMap<String, u64>,
    error_details: Vec<ErrorDetail>,

    counters: HashMap<String, u64>,
    gauges: HashMap<String, f64>,
    histograms: HashMap<String, Vec<f64>>,
    response_times: Vec<f64>,

    timers: HashMap<String, Timer>,
    is_collection_active: bool,
}

fn iso(timestamp: chrono::DateTime<chrono::Utc>) -> String {
    timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_proc_kb(rest: &str) -> Option<u64> {
    rest.trim()
        .strip_suffix("kB")
        .and_then(|n| n.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
}

fn read_proc_status() -> Option<(u64, u64)> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let mut peak = None;
    let mut size = None;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmPeak:") {
            peak = parse_proc_kb(rest);
        } else if let Some(rest) = line.strip_prefix("VmSize:") {
            size = parse_proc_kb(rest);
        }
    }
    Some((peak?, size?))
}

fn read_cpu_ticks() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_comm = stat.rsplit(')').next()?;
    let mut fields = after_comm.split_whitespace();
    let utime: u64 = fields.nth(11)?.parse().ok()?;
    let stime: u64 = fields.next()?.parse().ok()?;
    Some((utime, stime))
}

#[cfg(unix)]
fn clock_ticks_per_sec() -> f64 {
    let tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if tck > 0 {
        tck as f64
    } else {
        100.0
    }
}

#[cfg(not(unix))]
fn clock_ticks_per_sec() -> f64 {
    100.0
}

impl StatisticsCollector {
    pub fn new(command: &str) -> Self {
        let mut collector = Self {
            command: command.to_string(),
            start_time: chrono::Utc::now(),
            end_time: None,
            duration_ms: None,
            session_id: uuid::Uuid::new_v4().to_string(),
            total_execution_time: 0.0,
            operation_times: HashMap::new(),
            memory_peak: 0,
            memory_average: 0.0,
            memory_start: 0,
            memory_end: 0,
            memory_samples: Vec::new(),
            cpu_time_ms: 0.0,
            garbage_collections: 0,
            cpu_ticks_start: None,
            operations_total: 0,
            operations_successful: 0,
            operations_failed: 0,
            operations_warnings: 0,
            files: FileCounts::default(),
            network: NetworkCounts::default(),
            api: ApiCounts::default(),
            data: DataCounts::default(),
            errors_by_category: HashMap::new(),
            error_details: Vec::new(),
            counters: HashMap::new(),
            gauges: HashMap::new(),
            histograms: HashMap::new(),
            response_times: Vec::new(),
            timers: HashMap::new(),
            is_collection_active: false,
        };
        collector.update_memory_usage();
        collector
    }

    pub fn start(&mut self) {
        if self.is_collection_active {
            log("Statistics", "Collection already active", LogLevel::Warn);
            return;
        }
        self.is_collection_active = true;
        self.end_time = None;
        self.duration_ms = None;
        self.start_time = chrono::Utc::now();
        self.cpu_ticks_start = read_cpu_ticks();
        self.update_memory_usage();
        log_kv(
            "Statistics",
            &format!(
                "Started collecting statistics for command: {}",
                self.command
            ),
            LogLevel::Info,
            &[("sessionId", json!(self.session_id))],
        );
    }

    pub fn record_operation(&mut self, name: &str, success: bool) {
        if !self.is_collection_active {
            return;
        }
        self.increment_counter_value("operations.total", 1);
        if success {
            self.increment_counter_value("operations.successful", 1);
            log_kv(
                "Statistics",
                &format!("Success recorded for operation: {name}"),
                LogLevel::Debug,
                &[("operation", json!(name))],
            );
        } else {
            self.increment_counter_value("operations.failed", 1);
            log_kv(
                "Statistics",
                &format!("Failure recorded for operation: {name}"),
                LogLevel::Debug,
                &[("operation", json!(name))],
            );
        }
    }

    pub fn record_warning(&mut self) {
        if !self.is_collection_active {
            return;
        }
        self.increment_counter_value("operations.warnings", 1);
        log("Statistics", "Warning recorded", LogLevel::Warn);
    }

    pub fn record_error(&mut self, category: &str, message: &str) {
        if !self.is_collection_active {
            return;
        }
        self.increment_counter_value("operations.total", 1);
        self.increment_counter_value("operations.failed", 1);
        self.increment_counter_value(&format!("errors.{category}"), 1);
        self.error_details.push(ErrorDetail {
            timestamp: iso(chrono::Utc::now()),
            category: category.to_string(),
            message: message.to_string(),
        });
        log_kv(
            "Statistics",
            &format!("Error recorded: {message}"),
            LogLevel::Error,
            &[("category", json!(category))],
        );
    }

    pub fn record_network_activity(&mut self, kind: NetworkKind) {
        match kind {
            NetworkKind::Connection => self.increment_counter_value("network.connections", 1),
            NetworkKind::Timeout => self.increment_counter_value("network.timeouts", 1),
            NetworkKind::Retry => self.increment_counter_value("network.retries", 1),
        }
    }

    pub fn record_file_activity(&mut self, kind: FileKind) {
        match kind {
            FileKind::Opened => self.increment_counter_value("files.opened", 1),
            FileKind::Read => self.increment_counter_value("files.read", 1),
            FileKind::Written => self.increment_counter_value("files.written", 1),
            FileKind::Deleted => self.increment_counter_value("files.deleted", 1),
        }
    }

    pub fn record_api_call(&mut self, success: bool, response_time_ms: f64) {
        self.increment_counter_value("api.totalCalls", 1);
        if success {
            self.increment_counter_value("api.successfulCalls", 1);
        } else {
            self.increment_counter_value("api.failedCalls", 1);
        }
        self.record_histogram("api.responseTime", response_time_ms);
    }

    pub fn record_circuit_breaker_trip(&mut self) {
        self.increment_counter_value("api.circuitBreakerTrips", 1);
    }

    pub fn record_repetition_error(&mut self) {
        self.increment_counter_value("api.repetitionErrors", 1);
    }

    pub fn record_data(
        &mut self,
        records_processed: u64,
        records_filtered: u64,
        duplicates_removed: u64,
        files_processed: u64,
    ) {
        self.increment_counter_value("data.recordsProcessed", records_processed);
        self.increment_counter_value("data.recordsFiltered", records_filtered);
        self.increment_counter_value("data.duplicatesRemoved", duplicates_removed);
        self.increment_counter_value("data.filesProcessed", files_processed);
    }

    pub fn increment_counter(&mut self, key: &str) {
        self.increment_counter_value(key, 1);
    }

    /// Adds `value` to a counter (Node's `incrementCounter(name, amount)`).
    pub fn increment_counter_by(&mut self, key: &str, value: u64) {
        self.increment_counter_value(key, value);
    }

    fn increment_counter_value(&mut self, name: &str, value: u64) {
        if !self.is_collection_active {
            return;
        }
        *self.counters.entry(name.to_string()).or_insert(0) += value;
        if name == "operations.total" {
            self.operations_total += value;
        } else if name == "operations.successful" {
            self.operations_successful += value;
        } else if name == "operations.failed" {
            self.operations_failed += value;
        } else if name == "operations.warnings" {
            self.operations_warnings += value;
        } else if let Some(rest) = name.strip_prefix("files.") {
            match rest {
                "opened" => self.files.opened += value,
                "read" => self.files.read += value,
                "written" => self.files.written += value,
                "deleted" => self.files.deleted += value,
                _ => {}
            }
        } else if let Some(rest) = name.strip_prefix("network.") {
            match rest {
                "connections" => self.network.connections += value,
                "timeouts" => self.network.timeouts += value,
                "retries" => self.network.retries += value,
                _ => {}
            }
        } else if let Some(rest) = name.strip_prefix("api.") {
            match rest {
                "totalCalls" => self.api.total_calls += value,
                "successfulCalls" => self.api.successful_calls += value,
                "failedCalls" => self.api.failed_calls += value,
                "retries" => self.api.retries += value,
                "circuitBreakerTrips" => self.api.circuit_breaker_trips += value,
                "repetitionErrors" => self.api.repetition_errors += value,
                _ => {}
            }
        } else if let Some(rest) = name.strip_prefix("data.") {
            match rest {
                "recordsProcessed" => self.data.records_processed += value,
                "recordsFiltered" => self.data.records_filtered += value,
                "duplicatesRemoved" => self.data.duplicates_removed += value,
                "filesProcessed" => self.data.files_processed += value,
                _ => {}
            }
        } else if let Some(category) = name.strip_prefix("errors.") {
            if !category.is_empty() {
                *self
                    .errors_by_category
                    .entry(category.to_string())
                    .or_insert(0) += value;
            }
        }
    }

    pub fn set_gauge(&mut self, key: &str, value: f64) {
        if !self.is_collection_active {
            return;
        }
        self.gauges.insert(key.to_string(), value);
        match key {
            "memoryUsage.peak" => {
                self.memory_peak = self.memory_peak.max(value.max(0.0) as u64);
            }
            "cpuTime" => self.cpu_time_ms = value,
            "garbageCollections" => self.garbage_collections = value.max(0.0) as u64,
            _ => {}
        }
    }

    pub fn record_histogram(&mut self, key: &str, value: f64) {
        if !self.is_collection_active {
            return;
        }
        self.histograms
            .entry(key.to_string())
            .or_default()
            .push(value);
        if key == "api.responseTime" {
            self.response_times.push(value);
        }
    }

    pub fn start_timer(&mut self, id: &str, operation: &str) {
        if !self.is_collection_active {
            return;
        }
        self.timers.insert(
            id.to_string(),
            Timer {
                operation: operation.to_string(),
                start: Instant::now(),
            },
        );
    }

    pub fn end_timer(&mut self, id: &str) {
        if !self.is_collection_active {
            log(
                "Statistics",
                &format!("Collection not active, skipping timer end for id: {id}"),
                LogLevel::Warn,
            );
            return;
        }
        let Some(timer) = self.timers.remove(id) else {
            log(
                "Statistics",
                &format!("No timer found with id: {id}"),
                LogLevel::Warn,
            );
            return;
        };
        let duration_ms = timer.start.elapsed().as_secs_f64() * 1000.0;
        *self
            .operation_times
            .entry(timer.operation.clone())
            .or_insert(0.0) += duration_ms;
        self.total_execution_time += duration_ms;
        log_kv(
            "Statistics",
            &format!(
                "Operation {} completed in {}ms",
                timer.operation, duration_ms
            ),
            LogLevel::Debug,
            &[("id", json!(id)), ("duration", json!(duration_ms))],
        );
    }

    fn update_memory_usage(&mut self) {
        if let Some((vm_peak, vm_size)) = read_proc_status() {
            self.memory_samples.push(vm_size);
            if self.memory_start == 0 {
                self.memory_start = vm_size;
            }
            self.memory_end = vm_size;
            self.memory_peak = self.memory_peak.max(vm_size).max(vm_peak);
            let sum = self.memory_samples.iter().sum::<u64>() as f64;
            self.memory_average = sum / self.memory_samples.len() as f64;
        }
    }

    fn success_rate(&self) -> f64 {
        if self.operations_total > 0 {
            (self.operations_successful as f64 / self.operations_total as f64) * 100.0
        } else {
            0.0
        }
    }

    fn api_error_rate(&self) -> f64 {
        if self.api.total_calls > 0 {
            (self.api.failed_calls as f64 / self.api.total_calls as f64) * 100.0
        } else {
            0.0
        }
    }

    fn average_response_time(&self) -> f64 {
        if !self.response_times.is_empty() {
            self.response_times.iter().sum::<f64>() / self.response_times.len() as f64
        } else {
            0.0
        }
    }

    fn build_summary(&self) -> Value {
        let operation_times: Map<String, Value> = self
            .operation_times
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        let counters: Map<String, Value> = self
            .counters
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        let gauges: Map<String, Value> = self
            .gauges
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        let by_category: Map<String, Value> = self
            .errors_by_category
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        let details: Vec<Value> = self
            .error_details
            .iter()
            .map(|d| {
                json!({
                    "timestamp": d.timestamp,
                    "category": d.category,
                    "message": d.message,
                })
            })
            .collect();
        let histograms: Map<String, Value> = self
            .histograms
            .iter()
            .map(|(name, values)| {
                let count = values.len();
                let total: f64 = values.iter().sum();
                let minimum = values.iter().cloned().fold(f64::INFINITY, f64::min);
                let maximum = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                (
                    name.clone(),
                    json!({
                        "count": count,
                        "total": total,
                        "minimum": if count > 0 { minimum } else { 0.0 },
                        "maximum": if count > 0 { maximum } else { 0.0 },
                        "average": if count > 0 { total / count as f64 } else { 0.0 },
                    }),
                )
            })
            .collect();
        json!({
            "metadata": {
                "command": self.command,
                "startTime": iso(self.start_time),
                "endTime": iso(self.end_time.unwrap_or_else(chrono::Utc::now)),
                "duration": self.duration_ms.unwrap_or(0),
                "version": APP_VERSION,
                "sessionId": self.session_id,
            },
            "performance": {
                "totalExecutionTime": self.total_execution_time,
                "operationTimes": operation_times,
                "memoryUsage": {
                    "peak": self.memory_peak,
                    "average": self.memory_average,
                    "start": self.memory_start,
                    "end": self.memory_end,
                    "delta": self.memory_end as f64 - self.memory_start as f64,
                },
                "cpuTime": self.cpu_time_ms,
                "garbageCollections": self.garbage_collections,
            },
            "operations": {
                "total": self.operations_total,
                "successful": self.operations_successful,
                "failed": self.operations_failed,
                "warnings": self.operations_warnings,
                "successRate": self.success_rate(),
            },
            "resources": {
                "files": {
                    "opened": self.files.opened,
                    "read": self.files.read,
                    "written": self.files.written,
                    "deleted": self.files.deleted,
                },
                "network": {
                    "connections": self.network.connections,
                    "timeouts": self.network.timeouts,
                    "retries": self.network.retries,
                },
            },
            "api": {
                "totalCalls": self.api.total_calls,
                "successfulCalls": self.api.successful_calls,
                "failedCalls": self.api.failed_calls,
                "retries": self.api.retries,
                "circuitBreakerTrips": self.api.circuit_breaker_trips,
                "repetitionErrors": self.api.repetition_errors,
                "responseTimes": self.response_times,
                "averageResponseTime": self.average_response_time(),
                "errorRate": self.api_error_rate(),
            },
            "data": {
                "recordsProcessed": self.data.records_processed,
                "recordsFiltered": self.data.records_filtered,
                "duplicatesRemoved": self.data.duplicates_removed,
                "filesProcessed": self.data.files_processed,
            },
            "errors": {
                "byCategory": by_category,
                "details": details,
            },
            "metrics": {
                "counters": counters,
                "gauges": gauges,
                "histograms": histograms,
            },
        })
    }

    pub fn finalize(&mut self) -> Value {
        if !self.is_collection_active {
            return self.build_summary();
        }
        let timer_ids: Vec<String> = self.timers.keys().cloned().collect();
        for id in timer_ids {
            self.end_timer(&id);
        }
        self.is_collection_active = false;
        let end = chrono::Utc::now();
        self.end_time = Some(end);
        self.duration_ms = Some((end - self.start_time).num_milliseconds());
        self.update_memory_usage();
        self.cpu_time_ms = match (read_cpu_ticks(), self.cpu_ticks_start) {
            (Some((utime, stime)), Some((utime0, stime0))) => {
                (utime + stime).saturating_sub(utime0 + stime0) as f64 * 1000.0
                    / clock_ticks_per_sec()
            }
            (Some((utime, stime)), None) => (utime + stime) as f64 * 1000.0 / clock_ticks_per_sec(),
            _ => 0.0,
        };
        log_kv(
            "Statistics",
            &format!(
                "Completed collecting statistics for command: {}",
                self.command
            ),
            LogLevel::Info,
            &[
                ("duration", json!(self.duration_ms.unwrap_or(0))),
                ("totalOperations", json!(self.operations_total)),
                ("successRate", json!(self.success_rate())),
            ],
        );
        let summary = self.build_summary();
        self.timers.clear();
        self.memory_samples.clear();
        summary
    }

    pub fn export_to_file(&mut self, path: &Path) -> Result<()> {
        let summary = self.finalize();
        write_json_atomic_private(path, &summary)
    }

    /// Snapshot the summary without ending the collection (Node `getSummary`).
    pub fn get_summary(&self) -> Value {
        self.build_summary()
    }
}

pub fn create_statistics_collector(command: &str) -> StatisticsCollector {
    StatisticsCollector::new(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_json_shape() {
        let mut stats = StatisticsCollector::new("test-command");
        stats.start();
        stats.record_operation("op1", true);
        stats.record_operation("op2", false);
        stats.record_warning();
        stats.record_error("network", "connection timeout");
        stats.record_network_activity(NetworkKind::Connection);
        stats.record_network_activity(NetworkKind::Retry);
        stats.record_file_activity(FileKind::Opened);
        stats.record_file_activity(FileKind::Written);
        stats.record_api_call(true, 120.0);
        stats.record_api_call(false, 300.0);
        stats.record_circuit_breaker_trip();
        stats.record_repetition_error();
        stats.record_data(100, 20, 5, 3);
        stats.increment_counter("custom.counter");
        stats.set_gauge("custom.gauge", 42.0);
        stats.record_histogram("latency", 10.0);
        stats.record_histogram("latency", 20.0);
        stats.start_timer("t1", "work");
        std::thread::sleep(std::time::Duration::from_millis(5));
        stats.end_timer("t1");
        let summary = stats.finalize();

        for key in [
            "metadata",
            "performance",
            "operations",
            "resources",
            "api",
            "data",
            "errors",
            "metrics",
        ] {
            assert!(summary.get(key).unwrap().is_object(), "missing {key}");
        }

        let metadata = summary.get("metadata").unwrap();
        assert_eq!(metadata.get("command").unwrap(), "test-command");
        assert!(metadata.get("startTime").unwrap().is_string());
        assert!(metadata.get("endTime").unwrap().is_string());
        assert!(metadata.get("duration").unwrap().is_u64());
        assert_eq!(metadata.get("version").unwrap(), APP_VERSION);
        assert!(!metadata
            .get("sessionId")
            .unwrap()
            .as_str()
            .unwrap()
            .is_empty());

        let performance = summary.get("performance").unwrap();
        assert!(
            performance
                .get("totalExecutionTime")
                .unwrap()
                .as_f64()
                .unwrap()
                >= 5.0
        );
        assert!(performance.get("operationTimes").unwrap().is_object());
        assert!(
            performance
                .get("operationTimes")
                .unwrap()
                .get("work")
                .unwrap()
                .as_f64()
                .unwrap()
                >= 5.0
        );
        let memory = performance.get("memoryUsage").unwrap();
        for field in ["peak", "average", "start", "end", "delta"] {
            assert!(
                memory.get(field).unwrap().is_number(),
                "memoryUsage.{field}"
            );
        }
        assert!(performance.get("cpuTime").unwrap().is_number());
        assert_eq!(
            performance.get("garbageCollections").unwrap().as_u64(),
            Some(0)
        );

        let operations = summary.get("operations").unwrap();
        assert_eq!(operations.get("total").unwrap().as_u64(), Some(3));
        assert_eq!(operations.get("successful").unwrap().as_u64(), Some(1));
        assert_eq!(operations.get("failed").unwrap().as_u64(), Some(2));
        assert_eq!(operations.get("warnings").unwrap().as_u64(), Some(1));
        assert!(
            (operations.get("successRate").unwrap().as_f64().unwrap() - (100.0 / 3.0)).abs() < 1e-9
        );

        let resources = summary.get("resources").unwrap();
        let files = resources.get("files").unwrap();
        assert_eq!(files.get("opened").unwrap().as_u64(), Some(1));
        assert_eq!(files.get("read").unwrap().as_u64(), Some(0));
        assert_eq!(files.get("written").unwrap().as_u64(), Some(1));
        assert_eq!(files.get("deleted").unwrap().as_u64(), Some(0));
        let network = resources.get("network").unwrap();
        assert_eq!(network.get("connections").unwrap().as_u64(), Some(1));
        assert_eq!(network.get("timeouts").unwrap().as_u64(), Some(0));
        assert_eq!(network.get("retries").unwrap().as_u64(), Some(1));

        let api = summary.get("api").unwrap();
        assert_eq!(api.get("totalCalls").unwrap().as_u64(), Some(2));
        assert_eq!(api.get("successfulCalls").unwrap().as_u64(), Some(1));
        assert_eq!(api.get("failedCalls").unwrap().as_u64(), Some(1));
        assert_eq!(api.get("circuitBreakerTrips").unwrap().as_u64(), Some(1));
        assert_eq!(api.get("repetitionErrors").unwrap().as_u64(), Some(1));
        let response_times = api.get("responseTimes").unwrap().as_array().unwrap();
        assert_eq!(response_times.len(), 2);
        assert!(response_times.contains(&json!(120.0)));
        assert!((api.get("averageResponseTime").unwrap().as_f64().unwrap() - 210.0).abs() < 1e-9);
        assert!((api.get("errorRate").unwrap().as_f64().unwrap() - 50.0).abs() < 1e-9);

        let data = summary.get("data").unwrap();
        assert_eq!(data.get("recordsProcessed").unwrap().as_u64(), Some(100));
        assert_eq!(data.get("recordsFiltered").unwrap().as_u64(), Some(20));
        assert_eq!(data.get("duplicatesRemoved").unwrap().as_u64(), Some(5));
        assert_eq!(data.get("filesProcessed").unwrap().as_u64(), Some(3));

        let errors = summary.get("errors").unwrap();
        assert_eq!(
            errors
                .get("byCategory")
                .unwrap()
                .get("network")
                .unwrap()
                .as_u64(),
            Some(1)
        );
        let details = errors.get("details").unwrap().as_array().unwrap();
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].get("category").unwrap(), "network");
        assert_eq!(details[0].get("message").unwrap(), "connection timeout");
        assert!(details[0].get("timestamp").unwrap().is_string());

        let metrics = summary.get("metrics").unwrap();
        assert_eq!(
            metrics
                .get("counters")
                .unwrap()
                .get("custom.counter")
                .unwrap()
                .as_u64(),
            Some(1)
        );
        assert_eq!(
            metrics
                .get("counters")
                .unwrap()
                .get("operations.total")
                .unwrap()
                .as_u64(),
            Some(3)
        );
        assert_eq!(
            metrics
                .get("gauges")
                .unwrap()
                .get("custom.gauge")
                .unwrap()
                .as_f64(),
            Some(42.0)
        );
        let latency = metrics.get("histograms").unwrap().get("latency").unwrap();
        assert_eq!(latency.get("count").unwrap().as_u64(), Some(2));
        assert!((latency.get("total").unwrap().as_f64().unwrap() - 30.0).abs() < 1e-9);
        assert!((latency.get("minimum").unwrap().as_f64().unwrap() - 10.0).abs() < 1e-9);
        assert!((latency.get("maximum").unwrap().as_f64().unwrap() - 20.0).abs() < 1e-9);
        assert!((latency.get("average").unwrap().as_f64().unwrap() - 15.0).abs() < 1e-9);

        let repeat = stats.finalize();
        assert_eq!(
            repeat.get("metadata").unwrap().get("sessionId").unwrap(),
            metadata.get("sessionId").unwrap()
        );
        // getSummary stays available after finalize (Node getSummary).
        assert_eq!(
            stats
                .get_summary()
                .get("metadata")
                .unwrap()
                .get("command")
                .unwrap(),
            "test-command"
        );
    }

    #[test]
    fn counter_and_histogram_math() {
        let mut stats = StatisticsCollector::new("math");
        stats.start();
        stats.increment_counter("operations.total");
        stats.increment_counter("operations.total");
        stats.increment_counter("network.retries");
        stats.increment_counter("files.opened");
        stats.increment_counter("files.bogus");
        stats.increment_counter("errors.parsing");
        stats.record_histogram("h", 5.0);
        stats.record_histogram("h", 15.0);
        stats.record_histogram("h", 10.0);
        let summary = stats.finalize();

        let operations = summary.get("operations").unwrap();
        assert_eq!(operations.get("total").unwrap().as_u64(), Some(2));
        assert_eq!(operations.get("successRate").unwrap().as_f64(), Some(0.0));
        let network = summary.get("resources").unwrap().get("network").unwrap();
        assert_eq!(network.get("retries").unwrap().as_u64(), Some(1));
        let files = summary.get("resources").unwrap().get("files").unwrap();
        assert_eq!(files.get("opened").unwrap().as_u64(), Some(1));
        assert_eq!(files.get("written").unwrap().as_u64(), Some(0));
        assert_eq!(
            summary
                .get("errors")
                .unwrap()
                .get("byCategory")
                .unwrap()
                .get("parsing")
                .unwrap()
                .as_u64(),
            Some(1)
        );
        let counters = summary.get("metrics").unwrap().get("counters").unwrap();
        assert_eq!(counters.get("operations.total").unwrap().as_u64(), Some(2));
        assert_eq!(counters.get("files.bogus").unwrap().as_u64(), Some(1));
        assert_eq!(counters.get("network.retries").unwrap().as_u64(), Some(1));

        let h = summary
            .get("metrics")
            .unwrap()
            .get("histograms")
            .unwrap()
            .get("h")
            .unwrap();
        assert_eq!(h.get("count").unwrap().as_u64(), Some(3));
        assert!((h.get("total").unwrap().as_f64().unwrap() - 30.0).abs() < 1e-9);
        assert!((h.get("minimum").unwrap().as_f64().unwrap() - 5.0).abs() < 1e-9);
        assert!((h.get("maximum").unwrap().as_f64().unwrap() - 15.0).abs() < 1e-9);
        assert!((h.get("average").unwrap().as_f64().unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn export_to_file_writes_parseable_json() {
        let mut stats = StatisticsCollector::new("export-cmd");
        stats.start();
        stats.record_operation("x", true);
        stats.record_data(7, 2, 1, 1);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stats.json");
        stats.export_to_file(&path).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            parsed.get("metadata").unwrap().get("command").unwrap(),
            "export-cmd"
        );
        assert_eq!(
            parsed
                .get("data")
                .unwrap()
                .get("recordsProcessed")
                .unwrap()
                .as_u64(),
            Some(7)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
