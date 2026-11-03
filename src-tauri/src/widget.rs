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
    // The widget shows minutes; rounding keeps per-second ticks from looking
    // like a change.
    let (human, agent) = ((human / 60.0).floor() * 60.0, (agent / 60.0).floor() * 60.0);
    Some(json!({"date":date,"available":available,"running":running && available,"humanSeconds":human,"agentSeconds":agent,"workingAgents":if running && available { working } else { 0 },"hooksNeedUpdate":hooks_need_update,"captureNeedsAttention":capture_needs_attention}).to_string())
}

/// Minimum spacing between widget reloads while nothing state-like changes.
/// Snapshots expire after 15 minutes, so this also keeps them fresh.
const RELOAD_INTERVAL: Duration = Duration::from_secs(300);
/// Deadline for the widget helper; it runs from the exit handler.
const HELPER_TIMEOUT: Duration = Duration::from_secs(3);

/// Fields whose change should reach the widget immediately: day, availability,
/// running/paused, active agents and warnings. Totals alone wait for the
/// reload interval.
fn state_key(body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    json!([value["date"], value["available"], value["running"], value["workingAgents"], value["hooksNeedUpdate"], value["captureNeedsAttention"]]).to_string()
}

fn should_publish(last: Option<&(Instant, String)>, state: &str, force: bool) -> bool {
    force || last.is_none_or(|(at, previous)| previous != state || at.elapsed() >= RELOAD_INTERVAL)
}

fn run_helper(helper: &std::path::Path, body: &str) -> std::io::Result<()> {
    let mut child = Command::new(helper).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
    if let Err(error) = child.stdin.take().ok_or(std::io::Error::other("Widget helper stdin unavailable")).and_then(|mut input| input.write_all(body.as_bytes())) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let deadline = Instant::now() + HELPER_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other("Widget helper timed out"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() { let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr); }
        return Err(std::io::Error::other(stderr.trim().to_string()));
    }
    Ok(())
}

pub struct WidgetPublisher {
    helper: PathBuf,
    /// Time of the last reload and the state key it carried.
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
        let state = state_key(&body);
        if !should_publish(last.as_ref(), &state, force) { return; }
        match run_helper(&self.helper, &body) {
            Ok(()) => *last = Some((Instant::now(), state)),
            Err(error) => eprintln!("Could not update Agent Time widget: {error}"),
        }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn reloads_are_throttled_unless_state_changes() {
        let running = payload(&json!({"date":"2026-10-19","running":true,"humanSeconds":61.0,"agentSeconds":125.0,"workingAgents":1})).unwrap();
        let ticked = payload(&json!({"date":"2026-10-19","running":true,"humanSeconds":179.0,"agentSeconds":300.0,"workingAgents":1})).unwrap();
        let paused = payload(&json!({"date":"2026-10-19","running":false,"humanSeconds":179.0,"agentSeconds":300.0,"workingAgents":1})).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&running).unwrap()["humanSeconds"], 60.0);
        let recent = (Instant::now(), state_key(&running));
        assert!(should_publish(None, &state_key(&running), false));
        assert!(!should_publish(Some(&recent), &state_key(&ticked), false));
        assert!(should_publish(Some(&recent), &state_key(&paused), false));
        assert!(should_publish(Some(&recent), &state_key(&ticked), true));
    }
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
