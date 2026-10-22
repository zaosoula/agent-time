use std::{fs, path::PathBuf, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

pub const NOTIFICATION_ID: i32 = 1001;
pub const NOTIFICATION_TITLE: &str = "Agent Time update available";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

fn should_notify(last: Option<&str>, available: &str) -> bool {
    last != Some(available)
}

fn last_notified_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|path| path.join("last-notified-update"))
}

async fn check_once(app: &tauri::AppHandle, last: &mut Option<String>) {
    let result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => {
            eprintln!("Could not initialize update check: {error}");
            return;
        }
    };
    let update = match result {
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
        loop {
            tauri::async_runtime::block_on(check_once(&app, &mut last));
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
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
}
