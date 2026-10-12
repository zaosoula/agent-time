use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use tauri::{Manager, State};
mod tray;
#[cfg(unix)] use std::os::unix::process::CommandExt;
use serde_json::{json, Value};
type Pending = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<Result<Value, String>>>>>;
fn spawn_owned(command: &mut Command) -> std::io::Result<Child> {
 #[cfg(unix)] command.process_group(0);
 command.spawn()
}
struct Bridge { child: Mutex<Child>, input: Mutex<ChildStdin>, pending: Pending, counter: AtomicU64 }
impl Bridge {
 fn start(app: &tauri::App) -> Result<Self, String> {
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let packaged=std::env::current_exe().map_err(|e|e.to_string())?.parent().unwrap().to_path_buf();
  let dev=cfg!(debug_assertions);
  let resources=app.path().resource_dir().map_err(|e|e.to_string())?;
  let node=if dev { root.join("src-tauri/binaries/node-aarch64-apple-darwin") } else { packaged.join("node") };
  let helper=if dev { root.join(".capture/bin/activity-probe") } else { packaged.join("agent-activity") };
  let cli=if dev { root.join("src/capture/cli.ts") } else { resources.join("capture/cli.ts") };
  let output=std::env::var_os("ADE_CAPTURE_OUTPUT").map(PathBuf::from).unwrap_or(app.path().app_data_dir().map_err(|e|e.to_string())?);
  let path=format!("{}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",node.parent().unwrap().display());
  let mut command=Command::new(node);
  command.arg(cli).arg("protocol").arg("--output").arg(output).arg("--probe").arg(helper)
   .env("PATH",path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
  let mut child=spawn_owned(&mut command).map_err(|e|e.to_string())?;
  let input=child.stdin.take().ok_or("sidecar stdin unavailable")?;
  let output=child.stdout.take().ok_or("sidecar stdout unavailable")?;
  let pending:Pending=Arc::new(Mutex::new(HashMap::new()));let readers=pending.clone();
  std::thread::spawn(move || {
   for line in BufReader::new(output).lines() {
    if let Ok(line)=line { if let Ok(reply)=serde_json::from_str::<Value>(&line) {
     if let Some(id)=reply["id"].as_str() { if let Some(tx)=readers.lock().unwrap().remove(id) {
      let result=if reply.get("error").is_some(){Err(reply["error"].as_str().unwrap_or("sidecar error").to_string())}else{Ok(reply["result"].clone())};let _=tx.send(result);
     }}
    }}
   }
   for (_,tx) in readers.lock().unwrap().drain(){let _=tx.send(Err("Collector exited; reopen the app to restart".into()));}
  });
  Ok(Self{child:Mutex::new(child),input:Mutex::new(input),pending,counter:AtomicU64::new(0)})
 }
 fn request(&self, method:&str, params:Value)->Result<Value,String> {
  validate_method(method,&params)?;
  if self.child.lock().map_err(|e|e.to_string())?.try_wait().map_err(|e|e.to_string())?.is_some(){return Err("Collector exited".into());}
  let id=self.counter.fetch_add(1,Ordering::Relaxed).to_string();let (tx,rx)=std::sync::mpsc::channel();
  self.pending.lock().map_err(|e|e.to_string())?.insert(id.clone(),tx);
  let message=json!({"id":id,"method":method,"params":params}).to_string()+"\n";
  if let Err(e)=self.input.lock().map_err(|e|e.to_string())?.write_all(message.as_bytes()){self.pending.lock().unwrap().remove(&id);return Err(e.to_string());}
  let result=rx.recv_timeout(Duration::from_secs(45)).map_err(|_|"Collector request timed out".to_string());
  self.pending.lock().unwrap().remove(&id);result?
 }
 fn shutdown(&self) {
  let _=self.request("stop",json!({}));
  if let Ok(mut child)=self.child.lock(){
   #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
   let _=child.kill();let _=child.wait();
  }
 }
}
fn validate_method(method:&str,params:&Value)->Result<(),String>{
 let p=params.as_object().ok_or("Expected object parameters")?;
 match method {
  "status"|"summary"|"stop"|"tray_status"|"usage" if p.is_empty()=>Ok(()),
  "settings" if p.iter().all(|(k,v)|["macosActivity","claudeHooks","codexHooks","orcaPolling","tokenUsage"].contains(&k.as_str())&&v.is_boolean())=>Ok(()),
  "start" if p.len()==1 && p.get("durationSeconds").and_then(Value::as_f64).map(|n|n.is_finite()&&n>=1.0&&n<=86400.0).unwrap_or(false)=>Ok(()),
  _=>Err("Unsupported operation or parameters".into())
 }
}
#[tauri::command]
async fn capture_request(method:String,params:Value,bridge:State<'_,Arc<Bridge>>)->Result<Value,String>{
 let bridge=bridge.inner().clone();tauri::async_runtime::spawn_blocking(move||bridge.request(&method,params)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn open_accessibility_settings()->Result<(),String>{
 std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status().map_err(|e|e.to_string()).and_then(|s|if s.success(){Ok(())}else{Err("Could not open System Settings".into())})
}
pub fn run(){
 tauri::Builder::default().setup(|app|{
  let bridge=Arc::new(Bridge::start(app).map_err(std::io::Error::other)?);
  let init=bridge.clone();std::thread::spawn(move||{let _=init.request("start",json!({"durationSeconds":86400}));});app.manage(bridge.clone());tray::install(app,bridge)?;
  let show=tauri::menu::MenuItem::with_id(app,"show","Show Agent Time",true,Some("CmdOrCtrl+1"))?;
  let quit=tauri::menu::PredefinedMenuItem::quit(app,Some("Quit Agent Time"))?;
  let edit=tauri::menu::Submenu::with_items(app,"Edit",true,&[
   &tauri::menu::PredefinedMenuItem::undo(app,None)?, &tauri::menu::PredefinedMenuItem::redo(app,None)?,
   &tauri::menu::PredefinedMenuItem::separator(app)?, &tauri::menu::PredefinedMenuItem::cut(app,None)?,
   &tauri::menu::PredefinedMenuItem::copy(app,None)?, &tauri::menu::PredefinedMenuItem::paste(app,None)?,
   &tauri::menu::PredefinedMenuItem::select_all(app,None)?])?;
  let menu=tauri::menu::Menu::with_items(app,&[&tauri::menu::Submenu::with_items(app,"Agent Time",true,&[&show,&quit])?,&edit])?;
  app.set_menu(menu)?;Ok(())
 }).on_menu_event(|app,event|{tray::handle(app,event.id().as_ref());if event.id().as_ref()=="show"{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}}})
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
 .invoke_handler(tauri::generate_handler![capture_request,open_accessibility_settings]).build(tauri::generate_context!()).expect("Agent Time could not start")
 .run(|app,event|{match event{tauri::RunEvent::Exit=>{if let Some(tray)=app.try_state::<Arc<tray::TrayState>>(){tray.stopped.store(true,Ordering::Release);}if let Some(bridge)=app.try_state::<Arc<Bridge>>(){bridge.shutdown();}},tauri::RunEvent::Reopen{..}=>{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}},_=>{}}});
}
#[cfg(test)]mod tests{use super::*;#[test]fn restricted_protocol(){assert!(validate_method("exec",&json!({"command":"anything"})).is_err());assert!(validate_method("start",&json!({"durationSeconds":-1})).is_err());assert!(validate_method("start",&json!({"durationSeconds":5,"path":"/tmp"})).is_err());assert!(validate_method("summary",&json!({})).is_ok());assert!(validate_method("settings",&json!({"macosActivity":false,"claudeHooks":true,"codexHooks":false,"orcaPolling":true})).is_ok());assert!(validate_method("settings",&json!({"orcaPolling":"yes"})).is_err());assert!(validate_method("settings",&json!({"path":"/tmp"})).is_err());}}

#[cfg(all(test,unix))]
mod process_tests {
 use super::*;
 #[test] fn collector_process_owns_its_group() {
  let mut command=Command::new("/bin/sleep");command.arg("30");
  let mut child=spawn_owned(&mut command).unwrap();let pid=child.id() as i32;
  let group=unsafe{libc::getpgid(pid)};
  unsafe{libc::kill(-pid,libc::SIGTERM);}
  let _=child.kill();let _=child.wait();
  assert_eq!(group,pid,"collector must be independently terminable with its descendants");
 }
}
