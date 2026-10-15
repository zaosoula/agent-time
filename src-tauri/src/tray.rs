use super::Bridge;
use serde_json::{json,Value};
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use tauri::{Emitter,Manager,menu::{Menu,MenuItem,PredefinedMenuItem},tray::TrayIconBuilder};
use tauri_plugin_notification::NotificationExt;

pub struct TrayState {
 status:MenuItem<tauri::Wry>,today:MenuItem<tauri::Wry>,detail:MenuItem<tauri::Wry>,tokens:MenuItem<tauri::Wry>,toggle:MenuItem<tauri::Wry>,
 busy:AtomicBool,pub stopped:AtomicBool,last_warning:Mutex<Option<String>>,
}
fn hook_warning_body(value:&Value,last:&mut Option<String>)->Option<String>{
 if value["running"].as_bool()!=Some(true){return None;}
 let Some(warning)=value.get("hookWarning").filter(|warning|!warning.is_null()) else{*last=None;return None;};
 let Some(key)=warning["key"].as_str().filter(|key|!key.is_empty()) else{return None;};
 if last.as_deref()==Some(key){return None;}
 let names=warning["agents"].as_array()?.iter().filter_map(Value::as_str).collect::<Vec<_>>();
 if names.is_empty(){return None;}
 *last=Some(key.to_string());
 Some(format!("Update outdated hooks for {}. Agent time may be missing. Open Agent Time to repair.",names.join(", ")))
}
fn duration(seconds:f64)->String {
 let seconds=seconds.max(0.0).round() as u64;
 if seconds<60{format!("{seconds}s")}else if seconds<3600{format!("{}m",seconds/60)}else{format!("{}h {}m",seconds/3600,(seconds%3600)/60)}
}
fn clock_icon()->tauri::image::Image<'static>{
 let mut pixels=vec![0u8;36*36*4];
 for y in 0..36 {for x in 0..36 {
  let dx=x as f64-17.5;let dy=y as f64-17.5;let radius=(dx*dx+dy*dy).sqrt();
  let ring=(1.5-(radius-13.0).abs()).clamp(0.0,1.0);
  let hands=if (x>=16&&x<=18&&y>=9&&y<=18)||(x>=17&&x<=25&&y>=16&&y<=18){1.0}else{0.0};
  pixels[(y*36+x)*4+3]=(ring.max(hands)*255.0) as u8;
 }}
 tauri::image::Image::new_owned(pixels,36,36)
}
impl TrayState {
 fn refresh(&self,bridge:&Bridge,app:&tauri::AppHandle){
  if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
  match bridge.request("tray_status",json!({})){
   Ok(value)=>{
    if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
    let running=value["running"].as_bool().unwrap_or(false);
    if let Some(body)=hook_warning_body(&value,&mut self.last_warning.lock().unwrap()){
     let _=app.notification().builder().title("Agent tracking may be idle").body(body).show();
    }
    let _=self.status.set_text(if running{"Capture running"}else{"Capture paused"});
    let _=self.today.set_text(format!("Today: {} activity",duration(value["elapsedSeconds"].as_f64().unwrap_or(0.0))));
    let _=self.detail.set_text(format!("Agents: {} · Mac: {}",duration(value["agentSeconds"].as_f64().unwrap_or(0.0)),duration(value["humanSeconds"].as_f64().unwrap_or(0.0))));
    let n=value["tokensToday"].as_f64().unwrap_or(0.0);let count=if n>=1e6{format!("{:.1}M",n/1e6)}else if n>=1e3{format!("{:.1}K",n/1e3)}else{format!("{:.0}",n)};
    let _=self.tokens.set_text(format!("Tokens: {} · ${:.2} API equivalent{}",count,value["apiUsdToday"].as_f64().unwrap_or(0.0),if value["unpricedToday"].as_f64().unwrap_or(0.0)>0.0{" (partial)"}else{""}));
    let _=self.toggle.set_text(if running{"Pause capture"}else{"Resume capture"});let _=self.toggle.set_enabled(true);
   },
   Err(_)=>{let _=self.status.set_text("Capture unavailable");let _=self.today.set_text("Today: unavailable");let _=self.detail.set_text("Open dashboard for capture details");let _=self.toggle.set_enabled(false);}
  }
 }
}
pub fn install(app:&tauri::App,bridge:Arc<Bridge>)->tauri::Result<()> {
 let on_notification=app.handle().clone();
 let _=app.notification().on_action(move |action|{if action.action_id()=="tap"{open_page(&on_notification,"settings");}});
 let status=MenuItem::with_id(app,"tray-status","Connecting to capture…",false,None::<&str>)?;
 let today=MenuItem::with_id(app,"tray-today","Today: —",false,None::<&str>)?;
 let detail=MenuItem::with_id(app,"tray-detail","Agents: — · Mac: —",false,None::<&str>)?;
 let tokens=MenuItem::with_id(app,"tray-tokens","Tokens: —",false,None::<&str>)?;
 let toggle=MenuItem::with_id(app,"tray-toggle","Pause capture",false,None::<&str>)?;
 let dashboard=MenuItem::with_id(app,"tray-dashboard","Open dashboard",true,None::<&str>)?;
 let settings=MenuItem::with_id(app,"tray-settings","Settings…",true,None::<&str>)?;
 let usage=MenuItem::with_id(app,"tray-usage","Tokens and limits…",true,None::<&str>)?;
 let quit=MenuItem::with_id(app,"tray-quit","Quit Agent Time",true,None::<&str>)?;
 let menu=Menu::with_items(app,&[&status,&today,&detail,&tokens,&PredefinedMenuItem::separator(app)?,&toggle,&dashboard,&usage,&settings,&PredefinedMenuItem::separator(app)?,&quit])?;
 TrayIconBuilder::with_id("agent-time").icon(clock_icon()).icon_as_template(true).tooltip("Agent Time").menu(&menu).show_menu_on_left_click(true).build(app)?;
 let state=Arc::new(TrayState{status,today,detail,tokens,toggle,busy:AtomicBool::new(false),stopped:AtomicBool::new(false),last_warning:Mutex::new(None)});
 app.manage(state.clone());
 let handle=app.handle().clone();
 std::thread::spawn(move||{while !state.stopped.load(Ordering::Acquire){state.refresh(&bridge,&handle);std::thread::sleep(std::time::Duration::from_secs(5));}});
 Ok(())
}
fn open_page(app:&tauri::AppHandle,page:&str){
 if let Some(window)=app.get_webview_window("main"){
  let _=window.unminimize();let _=window.show();let _=window.set_focus();let _=window.emit("navigate",page);
 }
}
pub fn handle(app:&tauri::AppHandle,id:&str){match id{
 "tray-dashboard"=>open_page(app,"today"),"tray-settings"=>open_page(app,"settings"),"tray-usage"=>open_page(app,"usage"),"tray-quit"=>app.exit(0),
 "tray-toggle"=>{
  let Some(state)=app.try_state::<Arc<TrayState>>() else{return;};let state=state.inner().clone();
  if state.busy.swap(true,Ordering::AcqRel){return;}
  let _=state.toggle.set_enabled(false);let _=state.status.set_text("Updating capture…");
  let bridge=app.state::<Arc<Bridge>>().inner().clone();
  let handle=app.clone();
  std::thread::spawn(move||{
   let result=bridge.request("tray_status",json!({})).and_then(|v|if v["running"].as_bool()==Some(true){bridge.request("stop",json!({}))}else{bridge.request("start",json!({}))});
   state.busy.store(false,Ordering::Release);
   if result.is_err(){let _=state.status.set_text("Capture change failed — open dashboard");let _=state.toggle.set_enabled(true);}else{state.refresh(&bridge,&handle);}
  });
 },_=>{}
}}
#[cfg(test)]mod tests{use super::*;#[test]fn compact_times(){assert_eq!(duration(59.0),"59s");assert_eq!(duration(60.0),"1m");assert_eq!(duration(3660.0),"1h 1m");}}
#[cfg(test)]mod warning_tests{use super::*;#[test]fn one_notification_per_outdated_state(){
 let mut last=None;let old=json!({"running":true,"hookWarning":{"key":"v1:a","agents":["Claude Code"]}});
 assert!(hook_warning_body(&old,&mut last).unwrap().contains("Claude Code"));
 assert!(hook_warning_body(&old,&mut last).is_none());
 assert!(hook_warning_body(&json!({"running":false,"hookWarning":null}),&mut last).is_none());
 assert!(hook_warning_body(&old,&mut last).is_none());
 assert!(hook_warning_body(&json!({"running":true,"hookWarning":null}),&mut last).is_none());
 assert!(hook_warning_body(&old,&mut last).is_some());
}}
