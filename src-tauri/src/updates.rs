use std::{fs, path::PathBuf, sync::{Arc, Mutex}, time::{Duration, SystemTime}};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use crate::Bridge;

pub const NOTIFICATION_ID: i32 = 1001;
pub const NOTIFICATION_TITLE: &str = "Agent Time update available";
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// The background loop wakes this often and compares wall-clock time, so a
/// check is due promptly after the Mac wakes (monotonic sleeps stall in sleep).
const WAKE_INTERVAL: Duration = Duration::from_secs(60);
/// Network deadline for the update manifest request.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Network deadline for downloading the update archive.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const PROGRESS_EVENT: &str = "beta-update-progress";

fn updates_enabled() -> bool {
    option_env!("AGENT_TIME_BETA") == Some("1")
}

fn should_notify(last: Option<&str>, available: &str) -> bool {
    last != Some(available)
}

/// True when a check is due: the interval elapsed on the wall clock, or the
/// clock moved backwards (manual change), or nothing was checked yet.
fn check_due(last_check: Option<SystemTime>, now: SystemTime) -> bool {
    match last_check {
        None => true,
        Some(at) => now.duration_since(at).map(|elapsed| elapsed >= CHECK_INTERVAL).unwrap_or(true),
    }
}

fn last_notified_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|path| path.join("last-notified-update"))
}

async fn check_update(app: &tauri::AppHandle) -> Result<Option<Update>, String> {
    if !updates_enabled() {
        return Err("Updates are only available in beta builds".into());
    }
    let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|error| error.to_string())?;
    updater.check().await.map_err(|error| error.to_string())
}

async fn check_once(app: &tauri::AppHandle, last: &mut Option<String>) {
    let update = match check_update(app).await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            eprintln!("Could not check for Agent Time updates: {error}");
            return;
        }
    };
    let _ = app.emit("update-available", &update.version);
    if !should_notify(last.as_deref(), &update.version) { return; }
    if app.notification().builder().id(NOTIFICATION_ID).title(NOTIFICATION_TITLE)
        .body(format!("Version {} is ready. Open Agent Time to install and restart.", update.version)).show().is_ok() {
        *last = Some(update.version);
        if let Some(path) = last_notified_path(app) {
            if let Some(parent) = path.parent() {
                if fs::create_dir_all(parent).is_ok() {
                    let _ = fs::write(path, last.as_deref().unwrap_or_default());
                }
            }
        }
    }
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = last_notified_path(&app).and_then(|path| fs::read_to_string(path).ok());
        let mut last_check: Option<SystemTime> = None;
        loop {
            let now = SystemTime::now();
            if check_due(last_check, now) {
                last_check = Some(now);
                tauri::async_runtime::block_on(check_once(&app, &mut last));
            }
            std::thread::sleep(WAKE_INTERVAL);
        }
    });
}

/// The update found by the last `beta_update_check`, installed by
/// `beta_update_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

fn describe(update: &Update) -> Value {
    json!({
        "version": update.version,
        "currentVersion": update.current_version,
        "body": update.body,
        "date": update.date.map(|date| date.unix_timestamp()),
    })
}

/// Check for a beta update. Returns `null` when up to date, otherwise
/// `{version, currentVersion, body, date}` (date in Unix seconds or null).
#[tauri::command]
pub async fn beta_update_check(app: tauri::AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<Value>, String> {
    let update = check_update(&app).await?;
    let described = update.as_ref().map(describe);
    *pending.0.lock().map_err(|error| error.to_string())? = update;
    Ok(described)
}

/// Download, verify and install the update found by the last check, pausing
/// the collector only around the install step. Emits `beta-update-progress`
/// events `{event:"Progress",downloaded,total}` and `{event:"Finished"}`. On
/// success the app restarts; on install failure capture is resumed and the
/// error is returned.
#[tauri::command]
pub async fn beta_update_install(
    app: tauri::AppHandle,
    pending: State<'_, PendingUpdate>,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<(), String> {
    if !updates_enabled() {
        return Err("Updates are only available in beta builds".into());
    }
    let mut update = pending.0.lock().map_err(|error| error.to_string())?.clone()
        .ok_or("No update is available; check for updates again")?;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let progress = app.clone();
    let finished = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update.download(
        move |chunk, total| {
            downloaded += chunk as u64;
            let _ = progress.emit(PROGRESS_EVENT, json!({"event": "Progress", "downloaded": downloaded, "total": total}));
        },
        move || {
            let _ = finished.emit(PROGRESS_EVENT, json!({"event": "Finished"}));
        },
    ).await.map_err(|error| format!("Could not download the update: {error}"))?;
    let bridge = bridge.inner().clone();
    let pause = bridge.clone();
    tauri::async_runtime::spawn_blocking(move || pause.pause_for_update()).await.map_err(|error| error.to_string())?;
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string()).and_then(|result| result);
    match installed {
        Ok(()) => {
            app.request_restart();
            Ok(())
        }
        Err(error) => {
            let recovered = tauri::async_runtime::spawn_blocking(move || bridge.recover_from_update()).await
                .map_err(|join| join.to_string()).and_then(|result| result);
            match recovered {
                Ok(()) => Err(format!("Could not install the update: {error}")),
                Err(resume) => Err(format!("Could not install the update: {error}. Capture could not resume: {resume}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_is_once_per_available_version() {
        assert!(should_notify(None, "0.2.0-beta.8"));
        assert!(!should_notify(Some("0.2.0-beta.8"), "0.2.0-beta.8"));
        assert!(should_notify(Some("0.2.0-beta.8"), "0.2.0-beta.9"));
    }
    #[test]
    fn checks_follow_the_wall_clock() {
        let now = SystemTime::now();
        assert!(check_due(None, now));
        assert!(!check_due(Some(now - Duration::from_secs(60)), now));
        assert!(check_due(Some(now - CHECK_INTERVAL), now));
        // Clock moved backwards: check rather than wait an unknown time.
        assert!(check_due(Some(now + Duration::from_secs(600)), now));
    }
}
