use serde_json::{json, Value};
use std::{io::Write, path::PathBuf, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant}};

fn payload(value: &Value) -> Option<String> {
    let available = value.get("available").and_then(Value::as_bool).unwrap_or(true);
    let date = if available { value.get("date")?.as_str()? } else { value.get("date").and_then(Value::as_str).unwrap_or("") };
    if available && (date.len() != 10 || !date.bytes().enumerate().all(|(index, byte)| if index == 4 || index == 7 { byte == b'-' } else { byte.is_ascii_digit() })) { return None; }
    let running = value.get("running")?.as_bool()?;
    let human = value.get("humanSeconds")?.as_f64()?;
    let agent = value.get("agentSeconds")?.as_f64()?;
    let working = value.get("workingAgents")?.as_u64()?;
    if !human.is_finite() || human < 0.0 || !agent.is_finite() || agent < 0.0 || working > 1000 { return None; }
    let hooks_need_update = running && available && value.get("hookWarning").is_some_and(|warning| !warning.is_null());
    let capture_needs_attention = hooks_need_update || running && available && value.get("sourceWarning").and_then(Value::as_array).is_some_and(|sources| !sources.is_empty());
    Some(json!({"date":date,"available":available,"running":running && available,"humanSeconds":human,"agentSeconds":agent,"workingAgents":if running && available { working } else { 0 },"hooksNeedUpdate":hooks_need_update,"captureNeedsAttention":capture_needs_attention}).to_string())
}

pub struct WidgetPublisher {
    helper: PathBuf,
    last: Mutex<Option<(Instant, String)>>,
}

impl WidgetPublisher {
    pub fn new() -> std::io::Result<Self> {
        let executable = std::env::current_exe()?;
        let helper = executable.parent().ok_or(std::io::Error::other("Missing executable directory"))?.join("widget-snapshot");
        Ok(Self { helper, last: Mutex::new(None) })
    }

    pub fn publish(&self, value: &Value, force: bool) {
        let Some(body) = payload(value) else { return; };
        if !self.helper.exists() { return; }
        let Ok(mut last) = self.last.lock() else { return; };
        if !force && last.as_ref().is_some_and(|(at, previous)| *previous == body && at.elapsed() < Duration::from_secs(300)) { return; }
        let result = (|| -> std::io::Result<()> {
            let mut child = Command::new(&self.helper).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
            child.stdin.take().ok_or(std::io::Error::other("Widget helper stdin unavailable"))?.write_all(body.as_bytes())?;
            let output = child.wait_with_output()?;
            if !output.status.success() { return Err(std::io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_string())); }
            Ok(())
        })();
        match result {
            Ok(()) => *last = Some((Instant::now(), body)),
            Err(error) => eprintln!("Could not update Agent Time widget: {error}"),
        }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn snapshot_payload_requires_finite_totals_and_zeroes_paused_agents() {
        let value = json!({"date":"2026-10-19","running":false,"humanSeconds":60.0,"agentSeconds":120.0,"workingAgents":3});
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["workingAgents"], 0);
        assert!(payload(&json!({"date":"2026-10-19","running":true,"humanSeconds":-1,"agentSeconds":0,"workingAgents":0})).is_none());
        assert!(payload(&json!({"date":"2026-10-19","running":true,"humanSeconds":0,"agentSeconds":0})).is_none());
        assert!(payload(&json!({"date":"bad","running":true,"humanSeconds":0,"agentSeconds":0,"workingAgents":0})).is_none());
        let unavailable = json!({"available":false,"running":false,"humanSeconds":0,"agentSeconds":0,"workingAgents":0});
        assert_eq!(serde_json::from_str::<Value>(&payload(&unavailable).unwrap()).unwrap()["available"], false);
    }
    #[test] fn snapshot_payload_reports_outdated_hooks_only_while_capture_runs() {
        let mut value = json!({"date":"2026-10-19","running":true,"humanSeconds":60,"agentSeconds":120,"workingAgents":1,"hookWarning":{"key":"v1:claude","agents":["Claude Code"]}});
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["hooksNeedUpdate"], true);
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["captureNeedsAttention"], true);
        value["hookWarning"] = Value::Null;
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["hooksNeedUpdate"], false);
        value["running"] = json!(false);
        value["hookWarning"] = json!({"key":"v1:claude"});
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["hooksNeedUpdate"], false);
    }
    #[test] fn snapshot_payload_reports_source_failure_only_while_capture_runs() {
        let mut value = json!({"date":"2026-10-19","running":true,"humanSeconds":60,"agentSeconds":120,"workingAgents":1,"sourceWarning":["Mac activity"]});
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["captureNeedsAttention"], true);
        value["running"] = json!(false);
        assert_eq!(serde_json::from_str::<Value>(&payload(&value).unwrap()).unwrap()["captureNeedsAttention"], false);
    }
}
