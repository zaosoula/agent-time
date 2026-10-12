use super::Bridge;
use serde_json::json;
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use tauri::{Emitter,Manager,menu::{Menu,MenuItem,PredefinedMenuItem},tray::TrayIconBuilder};

pub struct TrayState {
 status:MenuItem<tauri::Wry>,today:MenuItem<tauri::Wry>,detail:MenuItem<tauri::Wry>,tokens:MenuItem<tauri::Wry>,toggle:MenuItem<tauri::Wry>,
 busy:AtomicBool,pub stopped:AtomicBool,
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
 fn refresh(&self,bridge:&Bridge){
  if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
  match bridge.request("tray_status",json!({})){
   Ok(value)=>{
    if self.busy.load(Ordering::Acquire)||self.stopped.load(Ordering::Acquire){return;}
    let running=value["running"].as_bool().unwrap_or(false);
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
 let state=Arc::new(TrayState{status,today,detail,tokens,toggle,busy:AtomicBool::new(false),stopped:AtomicBool::new(false)});
 app.manage(state.clone());
 std::thread::spawn(move||{while !state.stopped.load(Ordering::Acquire){state.refresh(&bridge);std::thread::sleep(std::time::Duration::from_secs(5));}});
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
  std::thread::spawn(move||{
   let result=bridge.request("tray_status",json!({})).and_then(|v|if v["running"].as_bool()==Some(true){bridge.request("stop",json!({}))}else{bridge.request("start",json!({"durationSeconds":86400}))});
   state.busy.store(false,Ordering::Release);
   if result.is_err(){let _=state.status.set_text("Capture change failed — open dashboard");let _=state.toggle.set_enabled(true);}else{state.refresh(&bridge);}
  });
 },_=>{}
}}
#[cfg(test)]mod tests{use super::*;#[test]fn compact_times(){assert_eq!(duration(59.0),"59s");assert_eq!(duration(60.0),"1m");assert_eq!(duration(3660.0),"1h 1m");}}
