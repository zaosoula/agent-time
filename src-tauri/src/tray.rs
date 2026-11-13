use super::{Bridge,pause_deadline};
use serde_json::{json,Value};
use std::{sync::{Arc,Condvar,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant,SystemTime,UNIX_EPOCH},path::PathBuf};
use tauri::{Emitter,Manager,menu::{Menu,MenuItem,PredefinedMenuItem,Submenu},tray::{TrayIconBuilder,TrayIconEvent}};
use tauri_plugin_notification::NotificationExt;
use crate::widget::WidgetPublisher;

pub struct TrayState {
 status:MenuItem<tauri::Wry>,today:MenuItem<tauri::Wry>,detail:MenuItem<tauri::Wry>,tokens:MenuItem<tauri::Wry>,toggle:MenuItem<tauri::Wry>,timed_pause:MenuItem<tauri::Wry>,
 busy:AtomicBool,pub stopped:AtomicBool,last_warning:Mutex<Option<String>>,last_storage_warning:Mutex<Option<String>>,widget:WidgetPublisher,last_summary:Mutex<Option<Value>>,
 pause_until:Mutex<Option<SystemTime>>,pause_file:PathBuf,
 /// Last observed capture state; paused capture is polled less often.
 running:AtomicBool,
 /// Pause/Resume item in the app menu, mirrored from the tray toggle.
 app_toggle:Mutex<Option<MenuItem<tauri::Wry>>>,
 /// Set when the tray menu is about to open so the poller refreshes now.
 wake:(Mutex<bool>,Condvar),
}
/// Tray status poll interval while capture runs.
const POLL_RUNNING:Duration=Duration::from_secs(20);
/// Tray status poll interval while capture is paused or unavailable.
const POLL_PAUSED:Duration=Duration::from_secs(60);
/// Minimum spacing between refreshes triggered by opening the menu.
const WAKE_DEBOUNCE:Duration=Duration::from_secs(2);
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
const STORAGE_NOTIFICATION_TITLE:&str="Capture paused: low disk space";
const STORAGE_RESUMED_TITLE:&str="Capture restarted automatically";
fn storage_warning_body(value:&Value,last:&mut Option<String>)->Option<String>{
 let notice=&value["storageCare"]["pressure"];
 let resumed=notice["phase"].as_str()==Some("resumed")&&value["running"].as_bool()==Some(true);
 if !resumed&&(value["running"].as_bool()==Some(true)||value["storageCare"]["paused"].as_bool()!=Some(true)){*last=None;return None;}
 if notice["reason"].as_str()!=Some("disk-space"){return None;}
 let id=notice["id"].as_str().filter(|id|!id.is_empty())?;
 let phase=notice["phase"].as_str()?;
 let (bucket,body)=match phase{
  "queued"|"compressing"=>("compressing","Less than 1 GB was available. Agent Time paused capture and is compressing stored history automatically."),
  "ready"=>("ready","Automatic compression finished. Capture restarts automatically when space and your storage budget allow."),
  "blocked"=>("blocked","Automatic compression finished, but storage is still full. Agent Time checks every 10 seconds and restarts capture when space is available."),
  "failed"=>("failed","Automatic compression could not finish. Capture remains paused. Agent Time checks every 10 seconds and restarts capture when space is available."),
  "resumed" if resumed=>("resumed","Capture paused for low disk space and history compression was attempted. Free space recovered and capture restarted automatically."),
  _=>return None,
 };
 let key=format!("{id}:{bucket}");if last.as_ref()==Some(&key){return None;}*last=Some(key);Some(body.into())
}
fn duration(seconds:f64)->String {
 let seconds=seconds.max(0.0).round() as u64;
 if seconds<60{format!("{seconds}s")}else if seconds<3600{format!("{}m",seconds/60)}else{format!("{}h {}m",seconds/3600,(seconds%3600)/60)}
}
fn clock_icon()->tauri::image::Image<'static>{
 // Generated from the same editable branching-clock mark as the app icon.
 // Raw RGBA keeps template loading infallible without a runtime PNG decoder.
 const PIXELS:&[u8;36*36*4]=include_bytes!("../icons/tray.rgba");
 tauri::image::Image::new(PIXELS,36,36)
}
impl TrayState {
 fn refresh(&self,bridge:&Bridge,app:&tauri::AppHandle){
  if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
  match bridge.request("tray_status",json!({})){
   Ok(value)=>{
    if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
    self.widget.publish(&value,false);
    if let Ok(mut last)=self.last_summary.lock(){*last=Some(value.clone());}
    let running=value["running"].as_bool().unwrap_or(false);
    self.running.store(running,Ordering::Release);
    if running{if let Ok(mut deadline)=self.pause_until.lock(){*deadline=None;}let _=std::fs::remove_file(&self.pause_file);}
    if let Some(body)=hook_warning_body(&value,&mut self.last_warning.lock().unwrap()){
     let _=app.notification().builder().title("Agent tracking may be idle").body(body).show();
    }
    if let Some(body)=storage_warning_body(&value,&mut self.last_storage_warning.lock().unwrap()){
     let title=if running{STORAGE_RESUMED_TITLE}else{STORAGE_NOTIFICATION_TITLE};
     let _=app.notification().builder().title(title).body(body).show();
    }
    let remaining=self.pause_until.lock().ok().and_then(|until|until.as_ref().and_then(|at|at.duration_since(SystemTime::now()).ok().map(|remaining|remaining.as_secs()/60+1)));
    let needs_attention=value["sourceWarning"].as_array().is_some_and(|sources|!sources.is_empty());
    let _=self.status.set_text(if running&&needs_attention{"Capture needs attention — open dashboard".into()}else if running{"Capture running".into()}else if let Some(minutes)=remaining{format!("Paused · resumes in {minutes}m")}else{"Capture paused".into()});
    let _=self.today.set_text(format!("Today: {} activity",duration(value["elapsedSeconds"].as_f64().unwrap_or(0.0))));
    let _=self.detail.set_text(format!("Agents: {} · Mac: {}",duration(value["agentSeconds"].as_f64().unwrap_or(0.0)),duration(value["humanSeconds"].as_f64().unwrap_or(0.0))));
    let n=value["tokensToday"].as_f64().unwrap_or(0.0);let count=if n>=1e6{format!("{:.1}M",n/1e6)}else if n>=1e3{format!("{:.1}K",n/1e3)}else{format!("{:.0}",n)};
    let _=self.tokens.set_text(format!("Tokens: {} · ${:.2} API equivalent{}",count,value["apiUsdToday"].as_f64().unwrap_or(0.0),if value["unpricedToday"].as_f64().unwrap_or(0.0)>0.0{" (partial)"}else{""}));
    let _=self.toggle.set_text(if running{"Pause capture"}else{"Resume capture"});let _=self.toggle.set_enabled(true);if let Ok(item)=self.app_toggle.lock(){if let Some(item)=item.as_ref(){let _=item.set_text(if running{"Pause Capture"}else{"Resume Capture"});}}let _=self.timed_pause.set_enabled(running);
   },
   Err(_)=>{self.running.store(false,Ordering::Release);if let Ok(mut last)=self.last_summary.lock(){*last=None;}self.widget.publish(&json!({"available":false,"running":false,"humanSeconds":0,"agentSeconds":0,"workingAgents":0}),false);let _=self.status.set_text("Capture unavailable");let _=self.today.set_text("Today: unavailable");let _=self.detail.set_text("Open dashboard for capture details");let _=self.toggle.set_enabled(false);let _=self.timed_pause.set_enabled(false);}
  }
 }
 fn wake(&self){
  if let Ok(mut flag)=self.wake.0.lock(){*flag=true;self.wake.1.notify_all();}
 }
 /// Sleep until the next poll, a timed-pause deadline, a menu-open wake, or
 /// shutdown, whichever comes first.
 fn wait_next(&self){
  let interval=if self.running.load(Ordering::Acquire){POLL_RUNNING}else{POLL_PAUSED};
  let until_resume=self.pause_until.lock().ok().and_then(|deadline|deadline.as_ref().map(|at|at.duration_since(SystemTime::now()).unwrap_or(Duration::ZERO)));
  let timeout=until_resume.map(|remaining|remaining.min(interval)).unwrap_or(interval);
  let Ok(flag)=self.wake.0.lock() else{std::thread::sleep(timeout);return;};
  if let Ok((mut flag,_))=self.wake.1.wait_timeout_while(flag,timeout,|woken|!*woken&&!self.stopped.load(Ordering::Acquire)){*flag=false;}
 }
 pub fn publish_stopped(&self){
  let previous=self.last_summary.lock().ok().and_then(|last|last.clone());
  if let Some(mut value)=previous{value["running"]=json!(false);value["workingAgents"]=json!(0);self.widget.publish(&value,true);}else{self.widget.publish(&json!({"available":false,"running":false,"humanSeconds":0,"agentSeconds":0,"workingAgents":0}),true);}
 }
}
pub fn install(app:&tauri::App,bridge:Arc<Bridge>)->tauri::Result<()> {
 let on_notification=app.handle().clone();
 let _=app.notification().on_action(move |action|{if action.action_id()=="tap"{
  let update=action.notification().is_some_and(|notification|notification.id()==crate::updates::NOTIFICATION_ID || notification.title()==Some(crate::updates::NOTIFICATION_TITLE));
  let storage=action.notification().is_some_and(|notification|matches!(notification.title(),Some(STORAGE_NOTIFICATION_TITLE)|Some(STORAGE_RESUMED_TITLE)));
  let hook=action.notification().is_some_and(|notification|notification.title()==Some("Agent tracking may be idle"));
  open_page(&on_notification,if update{"today"}else if hook{"hook-setup"}else if storage{"storage"}else{"health"});
 }});
 let status=MenuItem::with_id(app,"tray-status","Connecting to capture…",false,None::<&str>)?;
 let today=MenuItem::with_id(app,"tray-today","Today: —",false,None::<&str>)?;
 let detail=MenuItem::with_id(app,"tray-detail","Agents: — · Mac: —",false,None::<&str>)?;
 let tokens=MenuItem::with_id(app,"tray-tokens","Tokens: —",false,None::<&str>)?;
 let toggle=MenuItem::with_id(app,"tray-toggle","Pause capture",false,None::<&str>)?;
 let timed_pause=MenuItem::with_id(app,"tray-pause-15","Pause for 15 minutes",false,None::<&str>)?;
 let dashboard=MenuItem::with_id(app,"tray-dashboard","Open dashboard",true,None::<&str>)?;
 let health=MenuItem::with_id(app,"tray-health","Capture health…",true,None::<&str>)?;
 let repair=MenuItem::with_id(app,"tray-repair-hooks","Check and repair agent hooks…",true,None::<&str>)?;
 let settings=MenuItem::with_id(app,"tray-settings","Settings…",true,None::<&str>)?;
 let usage=MenuItem::with_id(app,"tray-usage","Tokens and limits…",true,None::<&str>)?;
 let quit=MenuItem::with_id(app,"tray-quit","Quit Agent Time",true,None::<&str>)?;
 let troubleshooting=Submenu::with_items(app,"Capture & connections",true,&[&health,&repair])?;
 let menu=Menu::with_items(app,&[&status,&today,&detail,&tokens,&PredefinedMenuItem::separator(app)?,&toggle,&timed_pause,&dashboard,&usage,&settings,&troubleshooting,&PredefinedMenuItem::separator(app)?,&quit])?;
 TrayIconBuilder::with_id("agent-time").icon(clock_icon()).icon_as_template(true).tooltip("Agent Time").menu(&menu).show_menu_on_left_click(true)
  .on_tray_icon_event(|tray,event|{
   if matches!(event,TrayIconEvent::Click{..}|TrayIconEvent::Enter{..}){
    if let Some(state)=tray.app_handle().try_state::<Arc<TrayState>>(){state.wake();}
   }
  })
  .build(app)?;
 let pause_file=bridge.launch.output.join("pause-until");
 let pause_until=pause_deadline(&pause_file);
 let state=Arc::new(TrayState{status,today,detail,tokens,toggle,timed_pause,app_toggle:Mutex::new(None),busy:AtomicBool::new(false),stopped:AtomicBool::new(false),last_warning:Mutex::new(None),last_storage_warning:Mutex::new(None),widget:WidgetPublisher::new()?,last_summary:Mutex::new(None),pause_until:Mutex::new(pause_until),pause_file,running:AtomicBool::new(true),wake:(Mutex::new(false),Condvar::new())});
 app.manage(state.clone());
 let handle=app.handle().clone();
 std::thread::spawn(move||{let mut last_refresh:Option<Instant>=None;while !state.stopped.load(Ordering::Acquire){
  let due=state.pause_until.lock().ok().and_then(|mut deadline|{if deadline.as_ref().is_some_and(|at|SystemTime::now()>=*at){deadline.take()}else{None}});
  if due.is_some(){if bridge.request("start",json!({})).is_err(){if let Ok(mut deadline)=state.pause_until.lock(){*deadline=Some(SystemTime::now()+Duration::from_secs(60));}}else{let _=std::fs::remove_file(&state.pause_file);}}
  if last_refresh.is_none_or(|at:Instant|at.elapsed()>=WAKE_DEBOUNCE){state.refresh(&bridge,&handle);last_refresh=Some(Instant::now());}
  state.wait_next();
 }});
 Ok(())
}
fn open_page(app:&tauri::AppHandle,page:&str){
 if let Some(window)=app.get_webview_window("main"){
  let _=window.unminimize();let _=window.show();let _=window.set_focus();let _=window.emit("navigate",page);
 }
}
pub fn handle(app:&tauri::AppHandle,id:&str){match id{
 "tray-dashboard"=>open_page(app,"today"),"tray-health"=>open_page(app,"health"),"tray-repair-hooks"=>open_page(app,"hook-setup"),"tray-settings"=>open_page(app,"settings"),"tray-usage"=>open_page(app,"usage"),"tray-quit"=>app.exit(0),
 "app-check-updates"=>{
  if let Some(window)=app.get_webview_window("main"){let _=window.unminimize();let _=window.show();let _=window.set_focus();let _=window.emit("check-updates",app.package_info().version.to_string());}
 },
 "app-restart-collector"=>{
  let bridge=app.state::<Arc<Bridge>>().inner().clone();let handle=app.clone();
  let state=app.try_state::<Arc<TrayState>>().map(|state|state.inner().clone());
  if let Some(state)=&state{let _=state.status.set_text("Restarting collector…");}
  std::thread::spawn(move||{
   // Same path as an update: stop the collector, then start a fresh one with capture as it was.
   bridge.pause_for_update();
   let result=bridge.recover_from_update();
   let _=handle.emit("collector-restarted",result.as_ref().err().cloned());
   if let Some(state)=state{state.refresh(&bridge,&handle);}
  });
 },
 "tray-toggle"|"app-toggle"=>{
  let Some(state)=app.try_state::<Arc<TrayState>>() else{return;};let state=state.inner().clone();
  if state.busy.swap(true,Ordering::AcqRel){return;}
  let _=state.toggle.set_enabled(false);let _=state.status.set_text("Updating capture…");
  let bridge=app.state::<Arc<Bridge>>().inner().clone();
  let handle=app.clone();
  std::thread::spawn(move||{
   let result=bridge.request("tray_status",json!({})).and_then(|v|if v["running"].as_bool()==Some(true){bridge.request("stop",json!({}))}else{bridge.request("start",json!({}))});
   state.busy.store(false,Ordering::Release);
   if result.is_err(){let _=state.status.set_text("Capture change failed — open dashboard");let _=state.toggle.set_enabled(true);}else{if let Ok(mut deadline)=state.pause_until.lock(){*deadline=None;}let _=std::fs::remove_file(&state.pause_file);state.refresh(&bridge,&handle);}
  });
 },
 "tray-pause-15"=>{
  let Some(state)=app.try_state::<Arc<TrayState>>() else{return;};let state=state.inner().clone();
  if state.busy.swap(true,Ordering::AcqRel){return;}
  let bridge=app.state::<Arc<Bridge>>().inner().clone();let handle=app.clone();
  std::thread::spawn(move||{
   let result=bridge.request("stop",json!({}));
   let mut save_failed=false;
   if result.is_ok(){let until=SystemTime::now()+Duration::from_secs(15*60);if let Ok(seconds)=until.duration_since(UNIX_EPOCH){
    if std::fs::write(&state.pause_file,seconds.as_secs().to_string()).is_ok(){if let Ok(mut deadline)=state.pause_until.lock(){*deadline=Some(until);}}
    else{save_failed=true;let _=bridge.request("start",json!({}));}
   }}
   state.busy.store(false,Ordering::Release);state.refresh(&bridge,&handle);
   if save_failed{let _=state.status.set_text("Timed pause failed — check capture in dashboard");}
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

/// Attach the app menu's Pause/Resume item so it follows capture state.
pub fn set_app_toggle(app:&tauri::App,item:MenuItem<tauri::Wry>){
 if let Some(state)=app.try_state::<Arc<TrayState>>(){
  let _=item.set_text(if state.running.load(Ordering::Acquire){"Pause Capture"}else{"Resume Capture"});
  if let Ok(mut slot)=state.app_toggle.lock(){*slot=Some(item);}
 }
}

#[cfg(test)]mod storage_warning_tests{
 use super::*;
 #[test]fn storage_notifications_are_deduplicated_and_manual_pauses_stay_quiet(){
  let mut last=None;
  let mut value=json!({"running":false,"storageCare":{"paused":true,"pressure":{"id":"episode","reason":"disk-space","phase":"queued"}}});
  assert!(storage_warning_body(&value,&mut last).unwrap().contains("compressing"));
  value["storageCare"]["pressure"]["phase"]=json!("compressing");assert!(storage_warning_body(&value,&mut last).is_none());
  value["storageCare"]["pressure"]["phase"]=json!("ready");assert!(storage_warning_body(&value,&mut last).unwrap().contains("restarts automatically"));assert!(storage_warning_body(&value,&mut last).is_none());
  value["storageCare"]["pressure"]["phase"]=json!("blocked");assert!(storage_warning_body(&value,&mut last).unwrap().contains("every 10 seconds"));
  value["storageCare"]["pressure"]["phase"]=json!("failed");assert!(storage_warning_body(&value,&mut last).unwrap().contains("could not finish"));
  assert!(storage_warning_body(&json!({"running":false}),&mut last).is_none());
  assert!(storage_warning_body(&value,&mut last).is_some());
  value["running"]=json!(true);assert!(storage_warning_body(&value,&mut last).is_none());
  value["storageCare"]["paused"]=json!(false);value["storageCare"]["pressure"]["phase"]=json!("resumed");
  assert!(storage_warning_body(&value,&mut last).unwrap().contains("restarted automatically"));assert!(storage_warning_body(&value,&mut last).is_none());
 }
}
