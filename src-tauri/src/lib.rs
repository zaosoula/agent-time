use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, State};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
mod tray;
mod widget;
#[cfg(unix)] use std::os::unix::process::CommandExt;
use serde_json::{json, Value};
type Pending = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<Result<Value, String>>>>>;
fn spawn_owned(command: &mut Command) -> std::io::Result<Child> {
 #[cfg(unix)] command.process_group(0);
 command.spawn()
}
fn stop_owned(child:&mut Child) {
 #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
 let deadline=std::time::Instant::now()+Duration::from_secs(2);
 loop {
  if child.try_wait().ok().flatten().is_some(){return;}
  if std::time::Instant::now()>=deadline{break;}
  std::thread::sleep(Duration::from_millis(25));
 }
 #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
 let _=child.kill();let _=child.wait();
}
struct LaunchSpec {node:PathBuf,cli:PathBuf,output:PathBuf,helper:PathBuf,keychain:PathBuf,path:String}
impl LaunchSpec {
 fn spawn(&self)->Result<(Child,ChildStdin,ChildStdout),String>{
  let mut command=Command::new(&self.node);
  command.arg(&self.cli).arg("protocol").arg("--output").arg(&self.output).arg("--probe").arg(&self.helper).arg("--keychain").arg(&self.keychain)
   .env("PATH",&self.path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
  let mut child=spawn_owned(&mut command).map_err(|e|e.to_string())?;
  let input=child.stdin.take().ok_or("sidecar stdin unavailable")?;
  let output=child.stdout.take().ok_or("sidecar stdout unavailable")?;
  Ok((child,input,output))
 }
}
struct RestartState {attempts:u8,window:Instant,closed:bool}
fn pause_deadline(path:&std::path::Path)->Option<SystemTime>{
 let seconds=std::fs::read_to_string(path).ok()?.trim().parse::<u64>().ok()?;
 let deadline=UNIX_EPOCH.checked_add(Duration::from_secs(seconds))?;
 (deadline>SystemTime::now()).then_some(deadline)
}
struct Bridge { child: Mutex<Child>, input: Mutex<ChildStdin>, pending: Pending, counter: AtomicU64, launch:LaunchSpec, reader:Mutex<Option<std::thread::JoinHandle<()>>>, restart:Mutex<RestartState>, desired_running:AtomicBool }
impl Bridge {
 fn start(app: &tauri::App) -> Result<Self, String> {
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let packaged=std::env::current_exe().map_err(|e|e.to_string())?.parent().unwrap().to_path_buf();
  let dev=cfg!(debug_assertions);
  let resources=app.path().resource_dir().map_err(|e|e.to_string())?;
  let node=if dev { root.join("src-tauri/binaries/node-aarch64-apple-darwin") } else { packaged.join("node") };
  let helper=if dev { root.join(".capture/bin/activity-probe") } else { packaged.join("agent-activity") };
  let keychain=if dev { root.join(".capture/bin/linear-keychain") } else { packaged.join("linear-keychain") };
  let cli=if dev { root.join("src/capture/cli.ts") } else { resources.join("capture/cli.ts") };
  let output=std::env::var_os("ADE_CAPTURE_OUTPUT").map(PathBuf::from).unwrap_or(app.path().app_data_dir().map_err(|e|e.to_string())?);
  let path=format!("{}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",node.parent().unwrap().display());
  Self::from_launch(LaunchSpec{node,cli,output,helper,keychain,path})
 }
 fn from_launch(launch:LaunchSpec)->Result<Self,String>{
  let desired_running=pause_deadline(&launch.output.join("pause-until")).is_none();
  let (child,input,output)=launch.spawn()?;
  let pending:Pending=Arc::new(Mutex::new(HashMap::new()));
  let reader=Self::read_replies(output,pending.clone());
  Ok(Self{child:Mutex::new(child),input:Mutex::new(input),pending,counter:AtomicU64::new(0),launch,reader:Mutex::new(Some(reader)),restart:Mutex::new(RestartState{attempts:0,window:Instant::now(),closed:false}),desired_running:AtomicBool::new(desired_running)})
 }
 fn read_replies(output:ChildStdout,readers:Pending)->std::thread::JoinHandle<()> {
  std::thread::spawn(move || {
   for line in BufReader::new(output).lines() {
    if let Ok(line)=line { if let Ok(reply)=serde_json::from_str::<Value>(&line) {
     if let Some(id)=reply["id"].as_str() { if let Some(tx)=readers.lock().unwrap().remove(id) {
      let result=if reply.get("error").is_some(){Err(reply["error"].as_str().unwrap_or("sidecar error").to_string())}else{Ok(reply["result"].clone())};let _=tx.send(result);
     }}
    }}
   }
   for (_,tx) in readers.lock().unwrap().drain(){let _=tx.send(Err("Collector exited; trying to restart".into()));}
  })
 }
 fn ensure_live(&self)->Result<(),String>{
  let mut restart=self.restart.lock().map_err(|e|e.to_string())?;
  if restart.closed{return Err("Collector stopped for update or exit".into());}
  if self.child.lock().map_err(|e|e.to_string())?.try_wait().map_err(|e|e.to_string())?.is_none(){return Ok(());}
  if restart.window.elapsed()>Duration::from_secs(300){restart.window=Instant::now();restart.attempts=0;}
  if restart.attempts>=3{return Err("Collector repeatedly exited; reopen Agent Time to retry".into());}
  restart.attempts+=1;
  if restart.attempts>1{std::thread::sleep(Duration::from_secs(1 << (restart.attempts-2)));}
  if let Some(reader)=self.reader.lock().map_err(|e|e.to_string())?.take(){let _=reader.join();}
  let (child,input,output)=self.launch.spawn()?;
  *self.child.lock().map_err(|e|e.to_string())?=child;
  *self.input.lock().map_err(|e|e.to_string())?=input;
  *self.reader.lock().map_err(|e|e.to_string())?=Some(Self::read_replies(output,self.pending.clone()));
  if self.desired_running.load(Ordering::Acquire){self.send("start",json!({})).map_err(|error|format!("Collector restarted but capture could not start: {error}"))?;}
  Ok(())
 }
 fn send(&self, method:&str, params:Value)->Result<Value,String>{
  let id=self.counter.fetch_add(1,Ordering::Relaxed).to_string();let (tx,rx)=std::sync::mpsc::channel();
  self.pending.lock().map_err(|e|e.to_string())?.insert(id.clone(),tx);
  let message=json!({"id":id,"method":method,"params":params}).to_string()+"\n";
  if let Err(e)=self.input.lock().map_err(|e|e.to_string())?.write_all(message.as_bytes()){self.pending.lock().unwrap().remove(&id);return Err(e.to_string());}
  let result=rx.recv_timeout(Duration::from_secs(45));
  self.pending.lock().unwrap().remove(&id);
  match result {
   Ok(reply)=>reply,
   Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{
    // A live but wedged sidecar cannot be restarted by ensure_live. Force its
    // next request through the same bounded recovery path as a crashed child.
    if let Ok(mut child)=self.child.lock(){let _=child.kill();}
    Err("Collector request timed out; restarting capture on the next check".into())
   },
   Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>Err("Collector exited before replying".into()),
  }
 }
 fn request(&self, method:&str, params:Value)->Result<Value,String> {
  validate_method(method,&params)?;
  self.ensure_live()?;
  let result=self.send(method,params)?;
  if method=="stop"{self.desired_running.store(false,Ordering::Release);}
  if method=="start"{self.desired_running.store(true,Ordering::Release);}
  Ok(result)
 }
 fn shutdown(&self) {
  let _=self.request("stop",json!({}));
  if let Ok(mut restart)=self.restart.lock(){restart.closed=true;}
  if let Ok(mut child)=self.child.lock(){
   stop_owned(&mut child);
  }
 }
}
fn validate_method(method:&str,params:&Value)->Result<(),String>{
 let p=params.as_object().ok_or("Expected object parameters")?;
 let source_id=|value:&str|value.len()<=41&&!value.is_empty()&&value.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-');
 let source_setting=|key:&str|key.len()<=64&&key!="browserTracking"&&key.bytes().all(|b|b.is_ascii_alphanumeric())&&(key.starts_with("browser")&&key.as_bytes().get(7).map(|b|b.is_ascii_uppercase()).unwrap_or(false)||key.ends_with("Hooks")||key.ends_with("TokenUsage")||key.ends_with("Polling"));
 match method {
  "status"|"summary"|"capture_health"|"capture_checks"|"diagnostics"|"privacy_exclusions"|"export_archive"|"archive_list"|"storage_usage"|"storage_reclaim"|"stop"|"tray_status"|"usage"|"hooks_status"|"hooks_verify"|"hooks_dismiss"|"tracking_cleanup_preview"|"website_projects"|"linear_status"|"linear_sync"|"linear_disconnect" if p.is_empty()=>Ok(()),
  "archive_preview"|"archive_import" if p.len()==1 && p.get("id").and_then(Value::as_str).map(|id|id.len()>30&&id.len()<100&&id.starts_with("agent-time-")&&id.ends_with(".sqlite")&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')).unwrap_or(false)=>Ok(()),
  "archive_delete" if p.len()==2 && p.get("confirmed")==Some(&Value::Bool(true)) && p.get("id").and_then(Value::as_str).map(|id|id.len()>30&&id.len()<100&&id.starts_with("agent-time-")&&id.ends_with(".sqlite")&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')).unwrap_or(false)=>Ok(()),
  "privacy_exclusions_set" if p.len()==1 && p.get("entries").and_then(Value::as_array).map(|entries|entries.len()<=100&&entries.iter().all(|entry|entry.as_object().map(|item|item.len()==2&&["app","site"].contains(&item.get("kind").and_then(Value::as_str).unwrap_or(""))&&item.get("value").and_then(Value::as_str).map(|value|!value.is_empty()&&value.len()<=253).unwrap_or(false)).unwrap_or(false))).unwrap_or(false)=>Ok(()),
  "summary" if p.len()==1 && p.get("date").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false)=>Ok(()),
  "weekly_review" if p.len()==1 && p.get("startDate").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false)=>Ok(()),
  "manual_notes" if p.len()==1 && p.get("date").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false)=>Ok(()),
  "manual_note_add" if p.len()==4 && p.get("start").and_then(Value::as_f64).zip(p.get("end").and_then(Value::as_f64)).map(|(start,end)|start.is_finite()&&end.is_finite()&&end>start&&end-start<=86400.0).unwrap_or(false) && p.get("project").and_then(Value::as_str).map(|value|value.len()<=256).unwrap_or(false) && p.get("note").and_then(Value::as_str).map(|value|!value.trim().is_empty()&&value.len()<=500).unwrap_or(false)=>Ok(()),
  "manual_note_remove" if p.len()==1 && p.get("id").and_then(Value::as_str).map(|id|id.len()==36&&id.bytes().all(|byte|byte.is_ascii_hexdigit()||byte==b'-')).unwrap_or(false)=>Ok(()),
  "linear_connect" if p.len()==1 && p.get("clientId").and_then(Value::as_str).map(|v|v.len()>=8&&v.len()<=128&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')).unwrap_or(false)=>Ok(()),
  "website_rule_set" if p.len()==2 && p.get("pattern").and_then(Value::as_str).is_some() && p.get("projectPath").and_then(Value::as_str).is_some()=>Ok(()),
  "website_rule_remove" if p.len()==1 && p.get("pattern").and_then(Value::as_str).is_some()=>Ok(()),
  "human_decision_set" if (p.len()==2||p.len()==3) && p.get("mode").and_then(Value::as_str).map(|mode|match mode {"assigned"=>p.len()==3&&p.get("projectPath").and_then(Value::as_str).is_some(),"unassigned"|"clear"=>p.len()==2,_=>false}).unwrap_or(false) && p.get("pairs").and_then(Value::as_array).map(|pairs|!pairs.is_empty()&&pairs.len()<=500&&pairs.iter().all(|pair|pair.as_array().map(|ids|ids.len()==2&&ids.iter().all(|id|id.as_str().map(|text|!text.is_empty()&&text.len()<=128).unwrap_or(false))).unwrap_or(false))).unwrap_or(false)=>Ok(()),
  "tracking_cleanup" if p.len()==1 && p.get("confirmed")==Some(&Value::Bool(true))=>Ok(()),
  "hooks_install" if (p.len()==1||p.len()==2) && p.get("provider").and_then(Value::as_str).map(source_id).unwrap_or(false) && (p.len()==1||p.get("targetIds").and_then(Value::as_array).map(|ids|!ids.is_empty()&&ids.len()<=100&&ids.iter().all(|id|id.as_str().map(|id|id.len()==16&&id.bytes().all(|byte|byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase())).unwrap_or(false))).unwrap_or(false))=>Ok(()),
  "settings" if p.iter().all(|(k,v)|if ["humanIdleMinutes","agentIdleMinutes"].contains(&k.as_str()){v.as_u64().map(|n|(1..=60).contains(&n)).unwrap_or(false)}else{(["macosActivity","orcaPolling","tokenUsage"].contains(&k.as_str())||source_setting(k))&&v.is_boolean()})=>Ok(()),
  "start" if p.is_empty() || p.len()==1 && p.get("durationSeconds").and_then(Value::as_f64).map(|n|n.is_finite()&&n>=1.0&&n<=86400.0).unwrap_or(false)=>Ok(()),
  _=>Err("Unsupported operation or parameters".into())
 }
}
#[tauri::command]
async fn capture_request(method:String,params:Value,bridge:State<'_,Arc<Bridge>>)->Result<Value,String>{
 let bridge=bridge.inner().clone();tauri::async_runtime::spawn_blocking(move||bridge.request(&method,params)).await.map_err(|e|e.to_string())?
}
#[cfg(unix)]
fn available_bytes(path:&std::path::Path)->Result<u64,String>{
 use std::os::unix::ffi::OsStrExt;
 let name=std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e|e.to_string())?;
 let mut info=std::mem::MaybeUninit::<libc::statvfs>::uninit();
 if unsafe{libc::statvfs(name.as_ptr(),info.as_mut_ptr())}!=0{return Err(std::io::Error::last_os_error().to_string());}
 let info=unsafe{info.assume_init()};
 Ok((info.f_bavail as u64).saturating_mul(info.f_frsize as u64))
}
fn stage_archive_copy(source:&std::path::Path,output:&std::path::Path)->Result<String,String>{
 use std::io::{Read,Seek,SeekFrom};
 let info=std::fs::symlink_metadata(source).map_err(|e|e.to_string())?;
 if !info.is_file()||info.file_type().is_symlink()||source.extension().and_then(|v|v.to_str())!=Some("sqlite"){return Err("Choose a regular SQLite archive".into());}
 if info.len()>8*1024*1024*1024{return Err("Archive is larger than the 8 GB import limit".into());}
 let mut input=std::fs::File::open(source).map_err(|e|e.to_string())?;
 let mut header=[0u8;16];input.read_exact(&mut header).map_err(|e|e.to_string())?;
 if &header!=b"SQLite format 3\0"{return Err("Selected file is not a SQLite archive".into());}
 input.seek(SeekFrom::Start(0)).map_err(|e|e.to_string())?;
 let folder=output.join("exports");
 if folder.exists()&&std::fs::symlink_metadata(&folder).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Export folder must not be a symlink".into());}
 std::fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
 #[cfg(unix)] if available_bytes(&folder)?<info.len().saturating_add(256*1024*1024){return Err("Not enough free space to stage this archive safely".into());}
 #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&folder,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;}
 let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_secs();
 let id=format!("agent-time-{stamp}-{}.sqlite",uuid::Uuid::new_v4());
 let path=folder.join(&id);
 let result=(||->Result<(),String>{
  let mut target=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|e.to_string())?;
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;target.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?;}
  std::io::copy(&mut input,&mut target).map_err(|e|e.to_string())?;
  if target.metadata().map_err(|e|e.to_string())?.len()!=info.len(){return Err("Archive changed during copying".into());}
  target.sync_all().map_err(|e|e.to_string())
 })();
 if let Err(error)=result{let _=std::fs::remove_file(&path);return Err(error);}
 Ok(id)
}
#[tauri::command]
async fn stage_archive(app:tauri::AppHandle,bridge:State<'_,Arc<Bridge>>)->Result<Option<String>,String>{
 let output=bridge.launch.output.clone();
 let (sender,receiver)=std::sync::mpsc::channel();
 app.dialog().file().add_filter("Agent Time archive",&["sqlite"]).pick_file(move |selection|{let _=sender.send(selection);});
 let selection=tauri::async_runtime::spawn_blocking(move||receiver.recv().map_err(|e|e.to_string())).await.map_err(|e|e.to_string())??;
 let Some(selection)=selection else{return Ok(None);};
 let source=selection.into_path().map_err(|e|e.to_string())?;
 tauri::async_runtime::spawn_blocking(move||stage_archive_copy(&source,&output).map(Some)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn open_accessibility_settings()->Result<(),String>{
 std::process::Command::new("/usr/bin/open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status().map_err(|e|e.to_string()).and_then(|s|if s.success(){Ok(())}else{Err("Could not open System Settings".into())})
}
#[tauri::command]
fn open_linear_oauth_settings()->Result<(),String>{
 std::process::Command::new("/usr/bin/open").arg("https://linear.app/settings/api/applications/new").status().map_err(|e|e.to_string()).and_then(|s|if s.success(){Ok(())}else{Err("Could not open Linear settings".into())})
}
#[tauri::command]
fn startup_item(operation:String)->Result<Value,String>{
 if !["status","enable","disable","settings"].contains(&operation.as_str()){return Err("Unsupported startup operation".into());}
 if cfg!(debug_assertions){return Err("Login item controls require the packaged app".into());}
 let helper=std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Missing app executable directory")?.join("startup-item");
 let output=Command::new(helper).arg(operation).output().map_err(|e|e.to_string())?;
 if !output.status.success(){return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());}
 serde_json::from_slice(&output.stdout).map_err(|e|e.to_string())
}
#[tauri::command]
async fn prepare_update(bridge:State<'_,Arc<Bridge>>)->Result<(),String>{
 let bridge=bridge.inner().clone();
 tauri::async_runtime::spawn_blocking(move||bridge.shutdown()).await.map_err(|e|e.to_string())?;
 Ok(())
}
pub fn run(){
  tauri::Builder::default().plugin(tauri_plugin_deep_link::init()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_process::init()).setup(|app|{
  let deep_handle=app.handle().clone();
  app.deep_link().on_open_url(move |event|{
   if event.urls().iter().any(|url|url.scheme()=="agenttime"&&["today","capture-health"].contains(&url.host_str().unwrap_or(""))&&url.path()=="/"&&url.query().is_none()&&url.fragment().is_none()){
    if let Some(window)=deep_handle.get_webview_window("main"){let _=window.show();let _=window.set_focus();}
   }
  });
  if option_env!("AGENT_TIME_BETA")==Some("1") {
   app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
   let handle=app.handle().clone();
   tauri::async_runtime::spawn(async move {
    let mut announced=String::new();
    loop {
     if let Ok(updater)=handle.updater(){
      if let Ok(Some(update))=updater.check().await {
       if update.version!=announced {
        announced=update.version.clone();
        if handle.get_webview_window("main").and_then(|window|window.is_visible().ok())!=Some(true){
         let _=handle.notification().builder().title("Agent Time update available").body(format!("Version {} is ready. Open Agent Time to install it.",update.version)).show();
        }
       }
      }
     }
     let _=tauri::async_runtime::spawn_blocking(||std::thread::sleep(Duration::from_secs(6*60*60))).await;
    }
   });
  }
  let bridge=Arc::new(Bridge::start(app).map_err(std::io::Error::other)?);
  let init=bridge.clone();std::thread::spawn(move||{if init.desired_running.load(Ordering::Acquire){let _=init.request("start",json!({}));}});app.manage(bridge.clone());tray::install(app,bridge)?;
  let show=tauri::menu::MenuItem::with_id(app,"show","Show Agent Time",true,Some("CmdOrCtrl+1"))?;
  let quit=tauri::menu::PredefinedMenuItem::quit(app,Some("Quit Agent Time"))?;
  let edit=tauri::menu::Submenu::with_items(app,"Edit",true,&[
   &tauri::menu::PredefinedMenuItem::undo(app,None)?, &tauri::menu::PredefinedMenuItem::redo(app,None)?,
   &tauri::menu::PredefinedMenuItem::separator(app)?, &tauri::menu::PredefinedMenuItem::cut(app,None)?,
   &tauri::menu::PredefinedMenuItem::copy(app,None)?, &tauri::menu::PredefinedMenuItem::paste(app,None)?,
   &tauri::menu::PredefinedMenuItem::select_all(app,None)?])?;
  let menu=tauri::menu::Menu::with_items(app,&[&tauri::menu::Submenu::with_items(app,"Agent Time",true,&[&show,&quit])?,&edit])?;
  app.set_menu(menu)?;
  if !std::env::args().any(|arg|arg=="--background") { if let Some(window)=app.get_webview_window("main"){window.show()?;} }
  Ok(())
 }).on_menu_event(|app,event|{tray::handle(app,event.id().as_ref());if event.id().as_ref()=="show"{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}}})
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
 .invoke_handler(tauri::generate_handler![capture_request,stage_archive,open_accessibility_settings,open_linear_oauth_settings,startup_item,prepare_update]).build(tauri::generate_context!()).expect("Agent Time could not start")
 .run(|app,event|{match event{tauri::RunEvent::Exit=>{if let Some(tray)=app.try_state::<Arc<tray::TrayState>>(){tray.stopped.store(true,Ordering::Release);tray.publish_stopped();}if let Some(bridge)=app.try_state::<Arc<Bridge>>(){bridge.shutdown();}},tauri::RunEvent::Reopen{..}=>{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}},_=>{}}});
}
#[cfg(test)]mod tests{use super::*;#[test]fn restricted_protocol(){assert!(validate_method("diagnostics",&json!({})).is_ok());assert!(validate_method("diagnostics",&json!({"includeRawEvents":true})).is_err());assert!(validate_method("archive_delete",&json!({"id":"agent-time-2026-10-20T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite","confirmed":true})).is_ok());assert!(validate_method("archive_delete",&json!({"id":"../events.sqlite","confirmed":true})).is_err());assert!(validate_method("archive_delete",&json!({"id":"agent-time-2026-10-20T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite"})).is_err());assert!(validate_method("tracking_cleanup",&json!({"confirmed":true})).is_ok());assert!(validate_method("tracking_cleanup",&json!({"confirmed":false})).is_err());assert!(validate_method("tracking_cleanup",&json!({"confirmed":true,"path":"/tmp"})).is_err());assert!(validate_method("tracking_cleanup_preview",&json!({})).is_ok());assert!(validate_method("exec",&json!({"command":"anything"})).is_err());assert!(validate_method("start",&json!({})).is_ok());assert!(validate_method("start",&json!({"durationSeconds":-1})).is_err());assert!(validate_method("start",&json!({"durationSeconds":5,"path":"/tmp"})).is_err());assert!(validate_method("summary",&json!({})).is_ok());assert!(validate_method("summary",&json!({"date":"2026-10-14"})).is_ok());assert!(validate_method("summary",&json!({"date":"yesterday"})).is_err());assert!(validate_method("capture_health",&json!({})).is_ok());assert!(validate_method("capture_health",&json!({"limit":10000})).is_err());assert!(validate_method("website_projects",&json!({})).is_ok());assert!(validate_method("website_projects",&json!({"path":"/tmp"})).is_err());assert!(validate_method("website_rule_set",&json!({"pattern":"http://localhost:1420","projectPath":"/tmp"})).is_ok());assert!(validate_method("website_rule_set",&json!({"pattern":"http://localhost:1420","projectPath":"/tmp","extra":true})).is_err());assert!(validate_method("website_rule_remove",&json!({"pattern":"http://localhost:1420"})).is_ok());assert!(validate_method("settings",&json!({"macosActivity":false,"claudeHooks":true,"codexHooks":false,"orcaPolling":true})).is_ok());assert!(validate_method("settings",&json!({"humanIdleMinutes":5})).is_ok());assert!(validate_method("settings",&json!({"orcaPolling":"yes"})).is_err());assert!(validate_method("settings",&json!({"path":"/tmp"})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"claude"})).is_ok());assert!(validate_method("hooks_install",&json!({"provider":"codex","targetIds":["0123456789abcdef"]})).is_ok());assert!(validate_method("hooks_install",&json!({"provider":"codex","targetIds":["../other"]})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"codex","path":"/tmp"})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"../other"})).is_err());assert!(validate_method("hooks_verify",&json!({})).is_ok());}}
#[cfg(test)]mod human_review_tests{use super::*;#[test]fn human_decision_protocol(){
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"assigned","projectPath":"/project"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"unassigned"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a"]],"mode":"assigned","projectPath":"/project"})).is_err());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"clear","projectPath":"/project"})).is_err());
}}

#[cfg(all(test,unix))]
mod process_tests {
 use super::*;
 #[test] fn collector_flushes_on_shutdown_signal() {
  use std::io::BufRead;
  let marker=std::env::temp_dir().join(format!("agent-time-shutdown-{}",std::process::id()));
  let _=std::fs::remove_file(&marker);
  let mut command=Command::new("/bin/sh");
  command.arg("-c").arg(format!("trap 'echo closed > {} ; exit 0' TERM; echo ready; while :; do sleep 1; done",marker.display())).stdout(Stdio::piped());
  let mut child=spawn_owned(&mut command).unwrap();
  let mut line=String::new();BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();assert_eq!(line.trim(),"ready");
  stop_owned(&mut child);
  assert!(marker.exists(),"collector should finish its SIGTERM cleanup before forced termination");
  let _=std::fs::remove_file(marker);
 }
 #[test] fn collector_process_owns_its_group() {
  let mut command=Command::new("/bin/sleep");command.arg("30");
  let mut child=spawn_owned(&mut command).unwrap();let pid=child.id() as i32;
  let group=unsafe{libc::getpgid(pid)};
  unsafe{libc::kill(-pid,libc::SIGTERM);}
  let _=child.kill();let _=child.wait();
  assert_eq!(group,pid,"collector must be independently terminable with its descendants");
 }
}
#[cfg(test)]
mod restart_tests {
 use super::*;
 #[test] fn collector_crash_recovers_and_restarts_capture() {
  let directory=std::env::temp_dir().join(format!("agent-time-recovery-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,r#"
const fs=require('fs'),readline=require('readline'),marker=process.argv[process.argv.indexOf('--output')+1]+'/restarted';
const first=!fs.existsSync(marker);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(process.argv[process.argv.indexOf('--output')+1]+'/requests',request.method+'\n');
 process.stdout.write(JSON.stringify({id:request.id,result:{running:true,method:request.method}})+'\n');
 if(first){fs.writeFileSync(marker,'yes');setTimeout(()=>process.exit(1),20);}
});
"#).unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:root.join("src-tauri/binaries/node-aarch64-apple-darwin"),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  assert_eq!(bridge.request("status",json!({})).unwrap()["method"],"status");
  std::thread::sleep(Duration::from_millis(100));
  assert_eq!(bridge.request("status",json!({})).unwrap()["method"],"status");
  assert_eq!(bridge.counter.load(Ordering::Relaxed),3); // initial status, recovered start, next status
  bridge.request("stop",json!({})).unwrap();
  {let mut child=bridge.child.lock().unwrap();let _=child.kill();let _=child.wait();}
  assert_eq!(bridge.request("status",json!({})).unwrap()["method"],"status");
  let requests=std::fs::read_to_string(directory.join("requests")).unwrap();
  assert_eq!(requests.lines().filter(|method|*method=="start").count(),1,"paused capture must stay paused after recovery");
  bridge.shutdown();let _=std::fs::remove_dir_all(directory);
 }
 #[test] fn repeated_collector_crashes_stop_after_three_restarts() {
  let directory=std::env::temp_dir().join(format!("agent-time-restart-limit-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,"process.stdin.resume();process.stdin.once('data',()=>process.exit(1));").unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:root.join("src-tauri/binaries/node-aarch64-apple-darwin"),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  for _ in 0..4 {assert!(bridge.request("status",json!({})).is_err());}
  assert!(bridge.request("status",json!({})).unwrap_err().contains("repeatedly exited"));
  bridge.shutdown();let _=std::fs::remove_dir_all(directory);
 }
}

#[cfg(test)]
mod browser_settings_tests {
 use super::*;
 #[test]
 fn browser_switches_are_independent_and_restricted() {
  assert!(validate_method("settings",&json!({"browserSafari":false})).is_ok());
  assert!(validate_method("settings",&json!({"browserChrome":true,"browserBrave":false})).is_ok());
  assert!(validate_method("settings",&json!({"browserTracking":true})).is_err());
  assert!(validate_method("settings",&json!({"browserSafari":"false"})).is_err());
 }
}

#[cfg(test)]
mod archive_stage_tests {
 use super::*;
 #[test]
 fn staged_archive_is_private_and_rejects_non_sqlite_input(){
  let root=std::env::temp_dir().join(format!("agent-time-stage-{}",uuid::Uuid::new_v4()));
  std::fs::create_dir_all(&root).unwrap();
  let source=root.join("backup.sqlite");
  std::fs::write(&source,b"SQLite format 3\0example").unwrap();
  let staged=stage_archive_copy(&source,&root).unwrap();
  assert!(staged.starts_with("agent-time-"));
  assert_eq!(std::fs::read(root.join("exports").join(staged)).unwrap(),b"SQLite format 3\0example");
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;assert_eq!(std::fs::metadata(root.join("exports")).unwrap().permissions().mode()&0o777,0o700);let file=std::fs::read_dir(root.join("exports")).unwrap().next().unwrap().unwrap().path();assert_eq!(std::fs::metadata(file).unwrap().permissions().mode()&0o777,0o600);}
  std::fs::write(&source,b"wrong").unwrap();
  assert!(stage_archive_copy(&source,&root).is_err());
  let huge=std::fs::OpenOptions::new().write(true).open(&source).unwrap();
  huge.set_len(8*1024*1024*1024+1).unwrap();
  assert!(stage_archive_copy(&source,&root).unwrap_err().contains("8 GB"));
  std::fs::remove_dir_all(root).unwrap();
 }
}
