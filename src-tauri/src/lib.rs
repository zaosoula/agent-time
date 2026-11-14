use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, ChildStdout, Command, Stdio}, sync::{Arc, Condvar, Mutex, atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
mod tray;
mod widget;
mod updates;
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
/// Collector diagnostics: its stderr plus the bridge's own restart and timeout notes. Kept
/// small by rotating to one previous file.
const COLLECTOR_LOG_BYTES:u64=1024*1024;
fn collector_log(output:&std::path::Path)->Option<std::fs::File>{
 let path=output.join("collector.log");
 if std::fs::metadata(&path).map(|meta|meta.len()>COLLECTOR_LOG_BYTES).unwrap_or(false){let _=std::fs::rename(&path,output.join("collector.log.1"));}
 let mut options=std::fs::OpenOptions::new();options.create(true).append(true);
 #[cfg(unix)] std::os::unix::fs::OpenOptionsExt::mode(&mut options,0o600);
 options.open(path).ok()
}
fn log_collector(output:&std::path::Path,message:&str){
 if let Some(mut file)=collector_log(output){
  let at=SystemTime::now().duration_since(UNIX_EPOCH).map(|d|d.as_secs()).unwrap_or(0);
  let _=writeln!(file,"[bridge {at}] {message}");
 }
}
impl LaunchSpec {
 fn spawn(&self)->Result<(Child,ChildStdin,ChildStdout),String>{
  let mut command=Command::new(&self.node);
  command.arg(&self.cli).arg("protocol").arg("--output").arg(&self.output).arg("--probe").arg(&self.helper).arg("--keychain").arg(&self.keychain)
   .env("PATH",&self.path).stdin(Stdio::piped()).stdout(Stdio::piped())
   .stderr(collector_log(&self.output).map(Stdio::from).unwrap_or_else(Stdio::inherit));
  log_collector(&self.output,"starting collector");
  let mut child=spawn_owned(&mut command).map_err(|e|e.to_string())?;
  let input=child.stdin.take().ok_or("sidecar stdin unavailable")?;
  let output=child.stdout.take().ok_or("sidecar stdout unavailable")?;
  Ok((child,input,output))
 }
}
struct RestartState {attempts:u8,window:Instant,closed:bool,restarting:bool}
fn automatic_capture_allowed(output:&std::path::Path)->bool{
 !output.join("storage-paused.json").exists()&&pause_deadline(&output.join("pause-until")).is_none()
}
fn pause_deadline(path:&std::path::Path)->Option<SystemTime>{
 let seconds=std::fs::read_to_string(path).ok()?.trim().parse::<u64>().ok()?;
 let deadline=UNIX_EPOCH.checked_add(Duration::from_secs(seconds))?;
 (deadline>SystemTime::now()).then_some(deadline)
}
/// Default reply deadline for interactive requests.
const REQUEST_TIMEOUT:Duration=Duration::from_secs(45);
/// Reply deadline for operations that copy, vacuum or rewrite the database,
/// or wait on the network. These legitimately run for minutes on large stores.
const LONG_REQUEST_TIMEOUT:Duration=Duration::from_secs(15*60);
/// How long a caller waits for an in-progress collector restart before
/// getting a "restarting" error instead of queueing behind it.
const RESTART_WAIT:Duration=Duration::from_secs(5);
/// Reply deadline for the best-effort `stop` sent while the app exits.
const SHUTDOWN_STOP_TIMEOUT:Duration=Duration::from_secs(3);
fn is_long_request(method:&str)->bool{
 matches!(method,
  "storage_compact_prepare"|"storage_restore_prepare"|"storage_reclaim"|"export_archive"
  |"billing_report"|"archive_import"|"archive_preview"|"tracking_cleanup"|"linear_status"|"linear_sync"|"linear_connect"|"linear_disconnect")
}
fn request_timeout(method:&str)->Duration{
 if is_long_request(method){LONG_REQUEST_TIMEOUT}else{REQUEST_TIMEOUT}
}
/// Kill the collector together with its process group (Orca, keychain and
/// probe helpers it spawned) and reap it.
fn kill_owned(child:&mut Child){
 #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
 let _=child.kill();
 let _=child.wait();
}
struct Bridge {
 child: Mutex<Child>, input: Mutex<ChildStdin>, pending: Pending, counter: AtomicU64, launch:LaunchSpec,
 reader:Mutex<Option<std::thread::JoinHandle<()>>>, restart:Mutex<RestartState>, restart_done:Condvar,
 desired_running:AtomicBool, long_inflight:AtomicUsize, storage_startup:Arc<AtomicBool>,
}
impl Bridge {
 fn start(app: &tauri::App) -> Result<Self, String> {
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let packaged=std::env::current_exe().map_err(|e|e.to_string())?.parent().unwrap().to_path_buf();
  let dev=cfg!(debug_assertions);
  let resources=app.path().resource_dir().map_err(|e|e.to_string())?;
  let node=if dev { dev_node(&root) } else { packaged.join("node") };
  let helper=if dev { root.join(".capture/bin/activity-probe") } else { packaged.join("agent-activity") };
  let keychain=if dev { root.join(".capture/bin/linear-keychain") } else { packaged.join("linear-keychain") };
  let cli=if dev { root.join("src/capture/cli.ts") } else { resources.join("capture/cli.ts") };
  let output=std::env::var_os("ADE_CAPTURE_OUTPUT").map(PathBuf::from).unwrap_or(app.path().app_data_dir().map_err(|e|e.to_string())?);
  let path=format!("{}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",node.parent().unwrap().display());
  Self::from_launch(LaunchSpec{node,cli,output,helper,keychain,path})
 }
 fn from_launch(launch:LaunchSpec)->Result<Self,String>{
  let desired_running=pause_deadline(&launch.output.join("pause-until")).is_none();
  let storage_startup=Arc::new(AtomicBool::new(launch.output.join("pending-storage-replacement.json").exists()));
  let (child,input,output)=launch.spawn()?;
  let pending:Pending=Arc::new(Mutex::new(HashMap::new()));
  let reader=Self::read_replies(output,pending.clone(),storage_startup.clone());
  Ok(Self{
   child:Mutex::new(child),input:Mutex::new(input),pending,counter:AtomicU64::new(0),launch,
   reader:Mutex::new(Some(reader)),
   restart:Mutex::new(RestartState{attempts:0,window:Instant::now(),closed:false,restarting:false}),
   restart_done:Condvar::new(),
   desired_running:AtomicBool::new(desired_running),long_inflight:AtomicUsize::new(0),storage_startup,
  })
 }
 fn read_replies(output:ChildStdout,readers:Pending,storage_startup:Arc<AtomicBool>)->std::thread::JoinHandle<()> {
  std::thread::spawn(move || {
   for line in BufReader::new(output).lines() {
    if let Ok(line)=line { if let Ok(reply)=serde_json::from_str::<Value>(&line) {
     if let Some(id)=reply["id"].as_str() { if let Some(tx)=readers.lock().unwrap().remove(id) {
      storage_startup.store(false,Ordering::Release);
      let result=if reply.get("error").is_some(){Err(reply["error"].as_str().unwrap_or("sidecar error").to_string())}else{Ok(reply["result"].clone())};let _=tx.send(result);
     }}
    }}
   }
   for (_,tx) in readers.lock().unwrap().drain(){let _=tx.send(Err("Collector exited; trying to restart".into()));}
  })
 }
 fn child_alive(&self)->Result<bool,String>{
  Ok(self.child.lock().map_err(|e|e.to_string())?.try_wait().map_err(|e|e.to_string())?.is_none())
 }
 /// Make sure a collector is running. The restart lock is only held for the
 /// bookkeeping; the slow part (backoff, spawn, `start`) runs with the
 /// `restarting` flag set so other callers wait at most RESTART_WAIT.
 fn ensure_live(&self)->Result<(),String>{
  let mut restart=self.restart.lock().map_err(|e|e.to_string())?;
  if restart.restarting{
   restart=self.restart_done.wait_timeout_while(restart,RESTART_WAIT,|state|state.restarting).map_err(|e|e.to_string())?.0;
   if restart.restarting{return Err("Collector restarting; try again shortly".into());}
  }
  if restart.closed{return Err("Collector stopped for update or exit".into());}
  if self.child_alive()?{return Ok(());}
  if restart.window.elapsed()>Duration::from_secs(300){restart.window=Instant::now();restart.attempts=0;}
  if restart.attempts>=3{
   if restart.attempts==3{restart.attempts+=1;log_collector(&self.launch.output,"collector exited 3 times in 5 minutes; not restarting");}
   return Err("Collector repeatedly exited; reopen Agent Time to retry".into());}
  restart.attempts+=1;
  let attempt=restart.attempts;
  let status=self.child.lock().ok().and_then(|mut child|child.try_wait().ok().flatten()).map(|status|format!("{status}")).unwrap_or_else(||"unknown status".into());
  log_collector(&self.launch.output,&format!("collector exited ({status}); restart attempt {attempt}"));
  restart.restarting=true;
  drop(restart);
  let result=self.respawn(attempt);
  if let Ok(mut restart)=self.restart.lock(){restart.restarting=false;}
  self.restart_done.notify_all();
  result
 }
 fn is_closed(&self)->bool{
  self.restart.lock().map(|restart|restart.closed).unwrap_or(true)
 }
 fn respawn(&self,attempt:u8)->Result<(),String>{
  if attempt>1{std::thread::sleep(Duration::from_secs(1 << (attempt-2)));}
  if self.is_closed(){return Err("Collector stopped for update or exit".into());}
  // The previous collector is dead (or was killed with its group), so its
  // stdout reaches EOF and the reader thread ends promptly.
  if let Some(reader)=self.reader.lock().map_err(|e|e.to_string())?.take(){let _=reader.join();}
  self.storage_startup.store(self.launch.output.join("pending-storage-replacement.json").exists(),Ordering::Release);
  let (child,input,output)=self.launch.spawn()?;
  *self.child.lock().map_err(|e|e.to_string())?=child;
  *self.input.lock().map_err(|e|e.to_string())?=input;
  *self.reader.lock().map_err(|e|e.to_string())?=Some(Self::read_replies(output,self.pending.clone(),self.storage_startup.clone()));
  // Shutdown may have run while we were spawning; never leave a collector
  // behind once the bridge is closed.
  if self.is_closed(){
   if let Ok(mut child)=self.child.lock(){stop_owned(&mut child);}
   return Err("Collector stopped for update or exit".into());
  }
  if self.desired_running.load(Ordering::Acquire)&&automatic_capture_allowed(&self.launch.output){
   self.send("start",json!({}),REQUEST_TIMEOUT).map_err(|error|format!("Collector restarted but capture could not start: {error}"))?;
  }
  Ok(())
 }
 fn send(&self, method:&str, params:Value, timeout:Duration)->Result<Value,String>{
  // A verified replacement runs before the CLI reads its first request. It
  // can outlast an interactive deadline; keep that startup allowance until
  // the first real reply, including after the marker is removed mid-apply.
  // Exit remains interruptible under its separate short stop deadline.
  let startup=self.storage_startup.load(Ordering::Acquire)&&timeout!=SHUTDOWN_STOP_TIMEOUT;
  let timeout=if startup{timeout.max(LONG_REQUEST_TIMEOUT)}else{timeout};
  let long=is_long_request(method)||startup;
  if long{self.long_inflight.fetch_add(1,Ordering::AcqRel);}
  let result=self.send_inner(method,params,timeout,long);
  if long{self.long_inflight.fetch_sub(1,Ordering::AcqRel);}
  result
 }
 fn send_inner(&self, method:&str, params:Value, timeout:Duration, long:bool)->Result<Value,String>{
  let id=self.counter.fetch_add(1,Ordering::Relaxed).to_string();let (tx,rx)=std::sync::mpsc::channel();
  self.pending.lock().map_err(|e|e.to_string())?.insert(id.clone(),tx);
  let message=json!({"id":id,"method":method,"params":params}).to_string()+"\n";
  if let Err(e)=self.input.lock().map_err(|e|e.to_string())?.write_all(message.as_bytes()){self.pending.lock().unwrap().remove(&id);return Err(e.to_string());}
  let deadline=Instant::now()+timeout;
  let result=loop {
   let now=Instant::now();
   if now>=deadline{break Err(std::sync::mpsc::RecvTimeoutError::Timeout);}
   match rx.recv_timeout((deadline-now).min(Duration::from_secs(1))) {
    Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{
     // The reader may have drained pending replies before this request was
     // registered; don't wait out the full deadline on a dead collector.
     if !self.child_alive().unwrap_or(true){break Err(std::sync::mpsc::RecvTimeoutError::Disconnected);}
    },
    other=>break other,
   }
  };
  self.pending.lock().unwrap().remove(&id);
  match result {
   Ok(reply)=>reply,
   Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{
    // A long operation (vacuum, archive copy, import) may legitimately keep
    // the collector busy; never kill it under a long request because of an
    // unrelated slow reply.
    if !long && self.long_inflight.load(Ordering::Acquire)>0 {
     return Err("Collector is busy with a storage operation; try again shortly".into());
    }
    // A live but wedged sidecar cannot be restarted by ensure_live. Force its
    // next request through the same bounded recovery path as a crashed child.
    log_collector(&self.launch.output,&format!("`{method}` got no reply within {}s; stopping the collector",timeout.as_secs()));
    if let Ok(mut child)=self.child.lock(){kill_owned(&mut child);}
    Err("Collector request timed out; restarting capture on the next check".into())
   },
   Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>Err("Collector exited before replying".into()),
  }
 }
 fn request(&self, method:&str, params:Value)->Result<Value,String> {
  validate_method(method,&params)?;
  self.ensure_live()?;
  // A storage pause is temporary. Preserve start intent through recovery,
  // including a crash between an internal resume and the next status poll.
  if method=="stop"{self.desired_running.store(false,Ordering::Release);}
  if method=="start"{self.desired_running.store(true,Ordering::Release);}
  let result=self.send(method,params,request_timeout(method))?;
  Ok(result)
 }
 /// Stop the collector without ever respawning it: close the bridge first,
 /// send a short best-effort `stop` if it is alive, then SIGTERM its process
 /// group and SIGKILL after a grace period.
 fn shutdown(&self) {
  if let Ok(mut restart)=self.restart.lock(){restart.closed=true;}
  self.restart_done.notify_all();
  if self.child_alive().unwrap_or(false){
   let _=self.send("stop",json!({}),SHUTDOWN_STOP_TIMEOUT);
  }
  if let Ok(mut child)=self.child.lock(){
   stop_owned(&mut child);
  }
 }
 fn pause_for_update(&self){
  let was_running=self.desired_running.load(Ordering::Acquire);
  self.shutdown();
  self.desired_running.store(was_running,Ordering::Release);
 }
 fn recover_from_update(&self)->Result<(),String>{
  let mut restart=self.restart.lock().map_err(|error|error.to_string())?;
  if !restart.closed{return Err("No interrupted update to recover".into());}
  restart.closed=false;restart.attempts=0;restart.window=Instant::now();
  drop(restart);
  self.ensure_live()
 }
}
fn dev_node(root:&std::path::Path)->PathBuf{
 root.join(format!("src-tauri/binaries/node-{}-apple-darwin",std::env::consts::ARCH))
}
fn is_date(value:&Value)->bool{
 value.as_str().map(|date|date.len()==10&&date.bytes().enumerate().all(|(index,byte)|if index==4||index==7{byte==b'-'}else{byte.is_ascii_digit()})).unwrap_or(false)
}
/// Optional `date` (YYYY-MM-DD) on review mutations that return a refreshed summary.
fn optional_date(params:&serde_json::Map<String,Value>)->bool{
 params.get("date").map(is_date).unwrap_or(true)
}
fn linear_workspace(value:&str)->bool{
 !value.is_empty()&&value.len()<=128&&value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'||b==b'.')
}
fn website_pattern(value:&Value)->bool{
 value.as_str().map(|text|text.len()<=512).unwrap_or(false)
}
fn project_path(value:&Value)->bool{
 value.as_str().map(|text|text.len()<=4096&&!text.contains('\0')).unwrap_or(false)
}
fn billing_progress_id(id:&str)->bool{
 id.len()==36&&id.bytes().enumerate().all(|(i,b)|if [8,13,18,23].contains(&i){b==b'-'}else{b.is_ascii_hexdigit()})
}
fn review_pair(value:&Value)->bool{
 value.as_array().map(|ids|ids.len()==2&&ids.iter().all(|id|id.as_str().map(|text|!text.is_empty()&&text.chars().map(char::len_utf16).sum::<usize>()<=128).unwrap_or(false))).unwrap_or(false)
}
fn review_selection(params:&serde_json::Map<String,Value>)->bool{
 let Some(pairs)=params.get("pairs").and_then(Value::as_array) else{return false;};
 let empty=Vec::new();
 let segments=match params.get("segments"){None=>&empty,Some(value)=>match value.as_array(){Some(items)=>items,None=>return false}};
 (!pairs.is_empty()||!segments.is_empty()) && (segments.is_empty()||params.get("mode").and_then(Value::as_str)!=Some("clear"))
 // The bound applies before deduplication, including overlapping whole/segment entries.
 && pairs.len()+segments.len()<=10_000
 && pairs.iter().all(review_pair)
 && segments.iter().all(|value|value.as_object().map(|item|item.len()==2&&item.get("pair").map(review_pair).unwrap_or(false)&&item.get("segment").and_then(Value::as_str).map(|side|["before","after"].contains(&side)).unwrap_or(false)).unwrap_or(false))
}
fn validate_method(method:&str,params:&Value)->Result<(),String>{
 let p=params.as_object().ok_or("Expected object parameters")?;
 let source_id=|value:&str|value.len()<=41&&!value.is_empty()&&value.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-');
 let source_setting=|key:&str|key.len()<=64&&key!="browserTracking"&&key.bytes().all(|b|b.is_ascii_alphanumeric())&&(key.starts_with("browser")&&key.as_bytes().get(7).map(|b|b.is_ascii_uppercase()).unwrap_or(false)||key.ends_with("Hooks")||key.ends_with("TokenUsage")||key.ends_with("Polling"));
 match method {
  "status"|"summary"|"capture_health"|"capture_checks"|"diagnostics"|"privacy_exclusions"|"export_archive"|"archive_list"|"storage_usage"|"storage_reclaim"|"storage_compact_prepare"|"storage_replacement_cancel"|"storage_replacement_status"|"storage_replacement_result"|"stop"|"tray_status"|"usage"|"hooks_status"|"hooks_verify"|"hooks_dismiss"|"mcp_status"|"claude_status_line_status"|"tracking_cleanup_preview"|"website_projects"|"billing_projects"|"linear_status"|"review_history" if p.is_empty()=>Ok(()),
  "billing_project_save" if p.keys().all(|k|k=="project"||k=="expectedRevision") && p.get("project").map(|v|v.is_object()&&v.to_string().len()<=262144).unwrap_or(false) && p.get("expectedRevision").map(|v|v.as_u64().is_some()).unwrap_or(true)=>Ok(()),
  "billing_report_history" if p.keys().all(|k|["project","historyCursor","limit"].contains(&k.as_str())) && p.get("project").and_then(Value::as_str).map(|s|!s.trim().is_empty()&&s.len()<=4096&&!s.chars().any(char::is_control)).unwrap_or(false) && p.get("limit").map(|v|v.as_u64().map(|n|(1..=50).contains(&n)).unwrap_or(false)).unwrap_or(true) && p.get("historyCursor").map(|v|v.as_str().map(|s|!s.is_empty()&&s.len()<=16&&!s.starts_with('0')&&s.bytes().all(|b|b.is_ascii_digit())&&s.parse::<u64>().map(|n|n<=9007199254740991).unwrap_or(false)).unwrap_or(false)).unwrap_or(true)=>Ok(()),
  "billing_report_progress" if p.len()==1 && p.get("progressId").and_then(Value::as_str).map(billing_progress_id).unwrap_or(false)=>Ok(()),
  "billing_report" if p.get("progressId").map(|v|v.as_str().map(billing_progress_id).unwrap_or(false)).unwrap_or(true) && p.keys().all(|k|["project","fromDate","toDate","format","detail","reportId","cursor","progressId"].contains(&k.as_str())) && p.get("project").and_then(Value::as_str).map(|s|!s.trim().is_empty()&&s.len()<=4096).unwrap_or(false) && ["fromDate","toDate"].iter().all(|k|p.get(*k).and_then(Value::as_str).map(|s|s.len()==10&&s.bytes().enumerate().all(|(i,b)|if i==4||i==7{b==b'-'}else{b.is_ascii_digit()})).unwrap_or(false)) && p.get("format").map(|v|v.as_str().map(|s|["json","csv","markdown"].contains(&s)).unwrap_or(false)).unwrap_or(true) && p.get("detail").map(|v|v.as_str().map(|s|["summary","daily"].contains(&s)).unwrap_or(false)).unwrap_or(true) && p.get("reportId").map(|v|v.as_str().map(|s|s.len()==36&&s.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-')).unwrap_or(false)).unwrap_or(true) && p.get("cursor").map(|v|p.contains_key("reportId")&&v.as_str().map(|s|!s.is_empty()&&s.len()<=7&&s.bytes().all(|b|b.is_ascii_digit())).unwrap_or(false)).unwrap_or(true)=>Ok(()),
  "linear_sync"|"linear_disconnect" if p.is_empty() || p.len()==1 && p.get("workspaceId").and_then(Value::as_str).map(linear_workspace).unwrap_or(false)=>Ok(()),
  "review_undo" if p.len()==1+usize::from(p.contains_key("date")) && optional_date(p) && p.get("id").and_then(Value::as_str).map(|id|id.len()==36&&id.chars().all(|c|c.is_ascii_hexdigit()||c=='-')).unwrap_or(false)=>Ok(()),
  "human_group_split" if p.len()>=2 && p.len()<=5 && optional_date(p) && p.get("splitAt").and_then(Value::as_f64).map(f64::is_finite).unwrap_or(false) && p.get("pairs").and_then(Value::as_array).map(|pairs|!pairs.is_empty()&&pairs.len()<=500&&pairs.iter().all(|pair|pair.as_array().map(|ids|ids.len()==2&&ids.iter().all(|id|id.as_str().map(|text|!text.is_empty()&&text.len()<=128).unwrap_or(false))).unwrap_or(false))).unwrap_or(false) && ["beforeProject","afterProject"].iter().all(|key|p.get(*key).map(|value|value.as_str().is_some()).unwrap_or(true)) && p.keys().all(|key|["pairs","splitAt","beforeProject","afterProject","date"].contains(&key.as_str()))=>Ok(()),
  "reported_timer_stop" if p.keys().all(|k|k=="taskCounterId"||k=="discard") && p.get("taskCounterId").and_then(Value::as_str).map(|id|id.len()==36&&id.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-')).unwrap_or(false) && p.get("discard").map(Value::is_boolean).unwrap_or(true)=>Ok(()),
  "day_review_status" if p.keys().all(|key|key=="date"||key=="includeBacklog") && optional_date(p) && p.contains_key("date") && p.get("includeBacklog").map(Value::is_boolean).unwrap_or(true)=>Ok(()),
  "day_review_mark"|"reported_work"|"work_outcomes" if p.len()==1 && p.get("date").and_then(Value::as_str).map(|date|date.len()==10&&date.bytes().enumerate().all(|(index,byte)|if index==4||index==7{byte==b'-'}else{byte.is_ascii_digit()})).unwrap_or(false)=>Ok(()),
  "archive_preview"|"archive_import" if p.len()==1 && p.get("id").and_then(Value::as_str).map(|id|id.len()>30&&id.len()<100&&id.starts_with("agent-time-")&&(id.ends_with(".sqlite")||id.ends_with(".sqlite.gz"))&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')).unwrap_or(false)=>Ok(()),
  "archive_delete" if p.len()==2 && p.get("confirmed")==Some(&Value::Bool(true)) && p.get("id").and_then(Value::as_str).map(|id|id.len()>30&&id.len()<100&&id.starts_with("agent-time-")&&(id.ends_with(".sqlite")||id.ends_with(".sqlite.gz"))&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')).unwrap_or(false)=>Ok(()),
  "storage_restore_prepare" if p.len()==2 && p.get("confirmed")==Some(&Value::Bool(true)) && p.get("id").and_then(Value::as_str).map(|id|id.len()>30&&id.len()<100&&id.starts_with("agent-time-")&&(id.ends_with(".sqlite")||id.ends_with(".sqlite.gz"))&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')).unwrap_or(false)=>Ok(()),
  "privacy_exclusions_set" if p.len()==1 && p.get("entries").and_then(Value::as_array).map(|entries|entries.len()<=100&&entries.iter().all(|entry|entry.as_object().map(|item|item.len()==2&&["app","site"].contains(&item.get("kind").and_then(Value::as_str).unwrap_or(""))&&item.get("value").and_then(Value::as_str).map(|value|!value.is_empty()&&value.len()<=253).unwrap_or(false)).unwrap_or(false))).unwrap_or(false)=>Ok(()),
  "summary" if (1..=3).contains(&p.len()) && p.keys().all(|k|["date","background","since"].contains(&k.as_str())) && p.get("date").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false) && p.get("background").map(|v|v.is_boolean()).unwrap_or(true) && p.get("since").map(|v|v.as_str().map(|t|!t.is_empty()&&t.len()<=64).unwrap_or(false)).unwrap_or(true)=>Ok(()),
  "period_review" if p.keys().all(|k|["fromDate","toDate","project","filters"].contains(&k.as_str())) && ["fromDate","toDate"].iter().all(|k|p.get(*k).and_then(Value::as_str).map(|s|s.len()==10&&s.bytes().enumerate().all(|(i,b)|if i==4||i==7{b==b'-'}else{b.is_ascii_digit()})).unwrap_or(false)) && p.get("project").map(|v|v.as_str().map(|s|s.len()<=4096).unwrap_or(false)).unwrap_or(true) && p.get("filters").map(|v|v.as_object().map(|f|f.iter().all(|(k,v)|["search","app","site","device","assignment"].contains(&k.as_str())&&v.as_str().map(|s|s.len()<=4096&&(k!="assignment"||["all","assigned","unassigned"].contains(&s))).unwrap_or(false))).unwrap_or(false)).unwrap_or(true)=>Ok(()),
  "weekly_review" if p.len()==1 && p.get("startDate").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false)=>Ok(()),
  "manual_notes" if p.len()==1 && p.get("date").and_then(Value::as_str).map(|date|{let bytes=date.as_bytes();bytes.len()==10&&bytes.iter().enumerate().all(|(i,b)|if i==4||i==7{*b==b'-'}else{b.is_ascii_digit()})}).unwrap_or(false)=>Ok(()),
  "manual_note_add" if p.len()==4 && p.get("start").and_then(Value::as_f64).zip(p.get("end").and_then(Value::as_f64)).map(|(start,end)|start.is_finite()&&end.is_finite()&&end>start&&end-start<=86400.0).unwrap_or(false) && p.get("project").and_then(Value::as_str).map(|value|value.len()<=256).unwrap_or(false) && p.get("note").and_then(Value::as_str).map(|value|!value.trim().is_empty()&&value.len()<=500).unwrap_or(false)=>Ok(()),
  "manual_note_remove" if p.len()==1 && p.get("id").and_then(Value::as_str).map(|id|id.len()==36&&id.bytes().all(|byte|byte.is_ascii_hexdigit()||byte==b'-')).unwrap_or(false)=>Ok(()),
  "linear_connect" if p.len()==1 && p.get("clientId").and_then(Value::as_str).map(|v|v.len()>=8&&v.len()<=128&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')).unwrap_or(false)=>Ok(()),
  "website_rule_set"|"website_rule_preview" if p.len()==2 && p.get("pattern").map(website_pattern).unwrap_or(false) && p.get("projectPath").map(project_path).unwrap_or(false)=>Ok(()),
  "website_rule_remove" if p.len()==1 && p.get("pattern").map(website_pattern).unwrap_or(false)=>Ok(()),
  "human_decision_set" if optional_date(p) && p.keys().all(|key|["pairs","segments","mode","projectPath","date"].contains(&key.as_str())) && p.get("mode").and_then(Value::as_str).map(|mode|match mode {"assigned"=>p.get("projectPath").and_then(Value::as_str).is_some(),"unassigned"|"clear"=>!p.contains_key("projectPath"),_=>false}).unwrap_or(false) && review_selection(p)=>Ok(()),
  "tracking_cleanup" if p.len()==1 && p.get("confirmed")==Some(&Value::Bool(true))=>Ok(()),
  "hooks_install" if (p.len()==1||p.len()==2) && p.get("provider").and_then(Value::as_str).map(source_id).unwrap_or(false) && (p.len()==1||p.get("targetIds").and_then(Value::as_array).map(|ids|!ids.is_empty()&&ids.len()<=100&&ids.iter().all(|id|id.as_str().map(|id|id.len()==16&&id.bytes().all(|byte|byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase())).unwrap_or(false))).unwrap_or(false))=>Ok(()),
  "mcp_install"|"mcp_remove" if (p.len()==1||p.len()==2) && p.get("provider").and_then(Value::as_str).map(|id|id=="claude"||id=="codex").unwrap_or(false) && (p.len()==1||p.get("targetIds").and_then(Value::as_array).map(|ids|!ids.is_empty()&&ids.len()<=100&&ids.iter().all(|id|id.as_str().map(|id|id.len()==16&&id.bytes().all(|byte|byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase())).unwrap_or(false))).unwrap_or(false))=>Ok(()),
  "claude_status_line_install"|"claude_status_line_remove" if p.len()==1 && p.get("targetId").and_then(Value::as_str).map(|id|id.len()==16&&id.bytes().all(|byte|byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase())).unwrap_or(false)=>Ok(()),
  "settings" if p.iter().all(|(k,v)|if k=="storageLimitMB"{v.as_u64().map(|n|(1024..=1048576).contains(&n)).unwrap_or(false)}else if ["humanIdleMinutes","agentIdleMinutes"].contains(&k.as_str()){v.as_u64().map(|n|(1..=60).contains(&n)).unwrap_or(false)}else{(["macosActivity","orcaPolling","tokenUsage","countTaskCounters"].contains(&k.as_str())||source_setting(k))&&v.is_boolean()})=>Ok(()),
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
 let compressed=source.file_name().and_then(|v|v.to_str()).map(|s|s.ends_with(".sqlite.gz")).unwrap_or(false);
 if !info.is_file()||info.file_type().is_symlink()||(!compressed&&source.extension().and_then(|v|v.to_str())!=Some("sqlite")){return Err("Choose a regular SQLite archive".into());}
 if info.len()>8*1024*1024*1024{return Err("Archive is larger than the 8 GB import limit".into());}
 let mut input=std::fs::File::open(source).map_err(|e|e.to_string())?;
 let mut header=[0u8;16];input.read_exact(&mut header).map_err(|e|e.to_string())?;
 if if compressed{header[..2]!=[0x1f,0x8b]}else{&header!=b"SQLite format 3\0"}{return Err("Selected file is not a SQLite archive".into());}
 input.seek(SeekFrom::Start(0)).map_err(|e|e.to_string())?;
 let folder=output.join("exports");
 if folder.exists()&&std::fs::symlink_metadata(&folder).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Export folder must not be a symlink".into());}
 std::fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
 #[cfg(unix)] if available_bytes(&folder)?<info.len().saturating_add(1024*1024*1024){return Err("Not enough free space to stage this archive safely".into());}
 #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&folder,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;}
 let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_secs();
 let id=format!("agent-time-{stamp}-{}.sqlite",uuid::Uuid::new_v4());
 let id=if compressed{format!("{id}.gz")}else{id};
 let path=folder.join(&id);let temporary=folder.join(format!("{id}.tmp"));
 let result=(||->Result<(),String>{
  let mut target=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e|e.to_string())?;
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;target.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?;}
  std::io::copy(&mut input.take(info.len().saturating_add(1)),&mut target).map_err(|e|e.to_string())?;
  if target.metadata().map_err(|e|e.to_string())?.len()!=info.len(){return Err("Archive changed during copying".into());}
  target.sync_all().map_err(|e|e.to_string())?;drop(target);std::fs::rename(&temporary,&path).map_err(|e|e.to_string())
 })();
 if let Err(error)=result{let _=std::fs::remove_file(&temporary);return Err(error);}
 Ok(id)
}
#[tauri::command]
async fn stage_archive(app:tauri::AppHandle,bridge:State<'_,Arc<Bridge>>)->Result<Option<String>,String>{
 let output=bridge.launch.output.clone();
 let (sender,receiver)=std::sync::mpsc::channel();
 app.dialog().file().add_filter("Agent Time archive",&["sqlite","gz"]).pick_file(move |selection|{let _=sender.send(selection);});
 let selection=tauri::async_runtime::spawn_blocking(move||receiver.recv().map_err(|e|e.to_string())).await.map_err(|e|e.to_string())??;
 let Some(selection)=selection else{return Ok(None);};
 let source=selection.into_path().map_err(|e|e.to_string())?;
 tauri::async_runtime::spawn_blocking(move||stage_archive_copy(&source,&output).map(Some)).await.map_err(|e|e.to_string())?
}
fn support_payload(version:&str,diagnostics:&Value)->Value{
 let sources=diagnostics["sources"].as_array().map(|items|items.iter().map(|source|json!({
  "id":source["id"],"kind":source["kind"],"enabled":source["enabled"],
  "lastEventAgeSeconds":source["lastEventAgeSeconds"],"hooks":source["hooks"]
 })).collect::<Vec<_>>()).unwrap_or_default();
 let recovery=diagnostics["recovery"].as_array().map(|items|items.iter().map(|notice|json!({"id":notice["id"],"title":notice["title"],"detail":notice["detail"],"action":notice["action"]})).collect::<Vec<_>>()).unwrap_or_default();
 json!({"appVersion":version,"checkedAt":diagnostics["checkedAt"],"running":diagnostics["running"],"eventCount":diagnostics["eventCount"],"lastPollAgeSeconds":diagnostics["lastPollAgeSeconds"],"errorCategory":diagnostics["errorCategory"],"runtimeReady":diagnostics["runtimeReady"],"databaseBytes":diagnostics["databaseBytes"],"databaseHealth":diagnostics["databaseHealth"],"spool":diagnostics["spool"],"nodeVersion":diagnostics["nodeVersion"],"platform":diagnostics["platform"],"architecture":diagnostics["architecture"],"osVersion":diagnostics["osVersion"],"sources":sources,"recovery":recovery})
}
#[cfg(test)]mod support_tests{use super::*;#[test]fn bundle_fields_exclude_captured_content(){
 let report=json!({"eventCount":5,"sources":[{"id":"claude","kind":"agent","enabled":true,"lastEventAgeSeconds":2,"hooks":"installed","path":"/private/TOP_SECRET"}],"rawError":"TOP_SECRET","windowTitle":"TOP_SECRET","recovery":[]});
 let body=support_payload("0.2.0",&report).to_string();
 assert!(body.contains("claude"));assert!(!body.contains("TOP_SECRET"));assert!(!body.contains("/private/"));
}}
#[tauri::command]
async fn save_support_bundle(app:tauri::AppHandle,bridge:State<'_,Arc<Bridge>>)->Result<bool,String>{
 let bridge=bridge.inner().clone();
 let diagnostics=tauri::async_runtime::spawn_blocking(move||bridge.request("diagnostics",json!({}))).await.map_err(|e|e.to_string())??;
 let body=serde_json::to_vec_pretty(&support_payload(&app.package_info().version.to_string(),&diagnostics)).map_err(|e|e.to_string())?;
 let (sender,receiver)=std::sync::mpsc::channel();
 app.dialog().file().add_filter("JSON",&["json"]).set_file_name("agent-time-support.json").save_file(move |selection|{let _=sender.send(selection);});
 let selection=tauri::async_runtime::spawn_blocking(move||receiver.recv().map_err(|e|e.to_string())).await.map_err(|e|e.to_string())??;
 let Some(selection)=selection else{return Ok(false);};
 let path=selection.into_path().map_err(|e|e.to_string())?;
 tauri::async_runtime::spawn_blocking(move||{
  if let Ok(info)=std::fs::symlink_metadata(&path){if !info.is_file()||info.file_type().is_symlink(){return Err("Choose a regular file for the support bundle".to_string());}}
  std::fs::write(&path,body).map_err(|e|e.to_string())?;
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?;}
  Ok(true)
 }).await.map_err(|e|e.to_string())?
}
fn open_url(target:&'static str,failure:&'static str)->Result<(),String>{
 std::process::Command::new("/usr/bin/open").arg(target).status().map_err(|e|e.to_string())
  .and_then(|s|if s.success(){Ok(())}else{Err(failure.into())})
}
#[tauri::command]
async fn open_accessibility_settings()->Result<(),String>{
 tauri::async_runtime::spawn_blocking(||open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility","Could not open System Settings"))
  .await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn open_linear_oauth_settings()->Result<(),String>{
 tauri::async_runtime::spawn_blocking(||open_url("https://linear.app/settings/api/applications/new","Could not open Linear settings"))
  .await.map_err(|e|e.to_string())?
}
fn run_startup_item(operation:String)->Result<Value,String>{
 if !["status","enable","disable","settings"].contains(&operation.as_str()){return Err("Unsupported startup operation".into());}
 if cfg!(debug_assertions){return Err("Login item controls require the packaged app".into());}
 let helper=std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Missing app executable directory")?.join("startup-item");
 let output=Command::new(helper).arg(operation).output().map_err(|e|e.to_string())?;
 if !output.status.success(){return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());}
 serde_json::from_slice(&output.stdout).map_err(|e|e.to_string())
}
#[tauri::command]
async fn startup_item(operation:String)->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(move||run_startup_item(operation)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn prepare_update(bridge:State<'_,Arc<Bridge>>)->Result<(),String>{
 let bridge=bridge.inner().clone();
 tauri::async_runtime::spawn_blocking(move||bridge.pause_for_update()).await.map_err(|e|e.to_string())?;
 Ok(())
}
#[tauri::command]
async fn resume_after_failed_update(bridge:State<'_,Arc<Bridge>>)->Result<(),String>{
 let bridge=bridge.inner().clone();
 tauri::async_runtime::spawn_blocking(move||bridge.recover_from_update()).await.map_err(|error|error.to_string())?
}
fn app_context()->tauri::Context<tauri::Wry>{tauri::generate_context!()}

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
  }
  let bridge=Arc::new(Bridge::start(app).map_err(std::io::Error::other)?);
  let init=bridge.clone();std::thread::spawn(move||{if init.desired_running.load(Ordering::Acquire)&&automatic_capture_allowed(&init.launch.output){let _=init.request("start",json!({}));}});app.manage(bridge.clone());tray::install(app,bridge)?;
  app.manage(updates::PendingUpdate::default());
  if option_env!("AGENT_TIME_BETA")==Some("1") { updates::start(app.handle().clone()); }
  let show=tauri::menu::MenuItem::with_id(app,"show","Show Agent Time",true,Some("CmdOrCtrl+1"))?;
  let quit=tauri::menu::PredefinedMenuItem::quit(app,Some("Quit Agent Time"))?;
  let edit=tauri::menu::Submenu::with_items(app,"Edit",true,&[
   &tauri::menu::PredefinedMenuItem::undo(app,None)?, &tauri::menu::PredefinedMenuItem::redo(app,None)?,
   &tauri::menu::PredefinedMenuItem::separator(app)?, &tauri::menu::PredefinedMenuItem::cut(app,None)?,
   &tauri::menu::PredefinedMenuItem::copy(app,None)?, &tauri::menu::PredefinedMenuItem::paste(app,None)?,
   &tauri::menu::PredefinedMenuItem::select_all(app,None)?])?;
  let version=app.package_info().version.to_string();
  let about=tauri::menu::PredefinedMenuItem::about(app,Some("About Agent Time"),Some(tauri::menu::AboutMetadata{
   name:Some("Agent Time".into()),version:Some(version.clone()),short_version:Some(version),
   website:Some("https://agent-time.ezyostudio.com".into()),website_label:Some("agent-time.ezyostudio.com".into()),
   copyright:Some("© EZYOSTUDIO".into()),..Default::default()}))?;
  let check=tauri::menu::MenuItem::with_id(app,"app-check-updates","Check for Updates…",true,None::<&str>)?;
  let toggle=tauri::menu::MenuItem::with_id(app,"app-toggle","Pause Capture",true,None::<&str>)?;
  let restart=tauri::menu::MenuItem::with_id(app,"app-restart-collector","Restart Collector",true,None::<&str>)?;
  let troubleshooting=tauri::menu::Submenu::with_items(app,"Troubleshooting",true,&[&restart])?;
  tray::set_app_toggle(app,toggle.clone());
  let (first,second,third)=(tauri::menu::PredefinedMenuItem::separator(app)?,tauri::menu::PredefinedMenuItem::separator(app)?,tauri::menu::PredefinedMenuItem::separator(app)?);
  let beta=option_env!("AGENT_TIME_BETA")==Some("1");
  let mut items:Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>>=vec![&about];
  if beta{items.push(&check);}
  // Standard macOS app-menu items (Services, Hide ⌘H, Hide Others ⌥⌘H, Show All).
  let (fourth,fifth)=(tauri::menu::PredefinedMenuItem::separator(app)?,tauri::menu::PredefinedMenuItem::separator(app)?);
  let services=tauri::menu::PredefinedMenuItem::services(app,None)?;
  let hide=tauri::menu::PredefinedMenuItem::hide(app,Some("Hide Agent Time"))?;
  let hide_others=tauri::menu::PredefinedMenuItem::hide_others(app,None)?;
  let show_all=tauri::menu::PredefinedMenuItem::show_all(app,None)?;
  items.extend([&first as &dyn tauri::menu::IsMenuItem<tauri::Wry>,&toggle,&troubleshooting,&second,&show,&third,&services,&fourth,&hide,&hide_others,&show_all,&fifth,&quit]);
  let view=tauri::menu::Submenu::with_items(app,"View",true,&[&tauri::menu::PredefinedMenuItem::fullscreen(app,None)?])?;
  // Without a Window menu macOS has no ⌘M (Minimize) or ⌘W (Close) shortcut.
  let window_menu=tauri::menu::Submenu::with_items(app,"Window",true,&[
   &tauri::menu::PredefinedMenuItem::minimize(app,None)?, &tauri::menu::PredefinedMenuItem::maximize(app,Some("Zoom"))?,
   &tauri::menu::PredefinedMenuItem::separator(app)?, &tauri::menu::PredefinedMenuItem::bring_all_to_front(app,None)?,
   &tauri::menu::PredefinedMenuItem::separator(app)?, &tauri::menu::PredefinedMenuItem::close_window(app,None)?])?;
  let menu=tauri::menu::Menu::with_items(app,&[&tauri::menu::Submenu::with_items(app,"Agent Time",true,&items)?,&edit,&view,&window_menu])?;
  app.set_menu(menu)?;
  #[cfg(target_os="macos")]
  window_menu.set_as_windows_menu_for_nsapp()?;
  if !std::env::args().any(|arg|arg=="--background") { if let Some(window)=app.get_webview_window("main"){window.show()?;} }
  Ok(())
 }).on_menu_event(|app,event|{tray::handle(app,event.id().as_ref());if event.id().as_ref()=="show"{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}}})
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
 .invoke_handler(tauri::generate_handler![capture_request,stage_archive,save_support_bundle,open_accessibility_settings,open_linear_oauth_settings,startup_item,prepare_update,resume_after_failed_update,updates::beta_update_check,updates::beta_update_install]).build(app_context()).expect("Agent Time could not start")
 .run(|app,event|{match event{tauri::RunEvent::Exit=>{
  // Close the bridge first so nothing respawns the collector while exiting.
  if let Some(tray)=app.try_state::<Arc<tray::TrayState>>(){tray.stopped.store(true,Ordering::Release);}
  if let Some(bridge)=app.try_state::<Arc<Bridge>>(){bridge.shutdown();}
  if let Some(tray)=app.try_state::<Arc<tray::TrayState>>(){tray.publish_stopped();}
 },tauri::RunEvent::Reopen{..}=>{if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.set_focus();}},_=>{}}});
}
#[cfg(test)]mod compressed_archive_tests{use super::*;
 #[test]fn compressed_ids_are_validated(){let id="agent-time-2026-11-08T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite.gz";for method in ["archive_preview","archive_import"]{assert!(validate_method(method,&json!({"id":id})).is_ok());}for method in ["archive_delete","storage_restore_prepare"]{assert!(validate_method(method,&json!({"id":id,"confirmed":true})).is_ok());}}
}
#[cfg(test)]mod tests{use super::*;#[test]fn restricted_protocol(){assert!(validate_method("diagnostics",&json!({})).is_ok());assert!(validate_method("diagnostics",&json!({"includeRawEvents":true})).is_err());assert!(validate_method("archive_delete",&json!({"id":"agent-time-2026-10-20T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite","confirmed":true})).is_ok());assert!(validate_method("archive_delete",&json!({"id":"../events.sqlite","confirmed":true})).is_err());assert!(validate_method("archive_delete",&json!({"id":"agent-time-2026-10-20T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite"})).is_err());assert!(validate_method("tracking_cleanup",&json!({"confirmed":true})).is_ok());assert!(validate_method("tracking_cleanup",&json!({"confirmed":false})).is_err());assert!(validate_method("tracking_cleanup",&json!({"confirmed":true,"path":"/tmp"})).is_err());assert!(validate_method("tracking_cleanup_preview",&json!({})).is_ok());assert!(validate_method("exec",&json!({"command":"anything"})).is_err());assert!(validate_method("start",&json!({})).is_ok());assert!(validate_method("start",&json!({"durationSeconds":-1})).is_err());assert!(validate_method("start",&json!({"durationSeconds":5,"path":"/tmp"})).is_err());assert!(validate_method("summary",&json!({})).is_ok());assert!(validate_method("summary",&json!({"date":"2026-10-14"})).is_ok());assert!(validate_method("summary",&json!({"date":"yesterday"})).is_err());assert!(validate_method("capture_health",&json!({})).is_ok());assert!(validate_method("capture_health",&json!({"limit":10000})).is_err());assert!(validate_method("website_projects",&json!({})).is_ok());assert!(validate_method("website_projects",&json!({"path":"/tmp"})).is_err());assert!(validate_method("website_rule_set",&json!({"pattern":"http://localhost:1420","projectPath":"/tmp"})).is_ok());assert!(validate_method("website_rule_set",&json!({"pattern":"http://localhost:1420","projectPath":"/tmp","extra":true})).is_err());assert!(validate_method("website_rule_remove",&json!({"pattern":"http://localhost:1420"})).is_ok());assert!(validate_method("settings",&json!({"macosActivity":false,"claudeHooks":true,"codexHooks":false,"orcaPolling":true})).is_ok());assert!(validate_method("settings",&json!({"humanIdleMinutes":5})).is_ok());assert!(validate_method("settings",&json!({"orcaPolling":"yes"})).is_err());assert!(validate_method("settings",&json!({"path":"/tmp"})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"claude"})).is_ok());assert!(validate_method("hooks_install",&json!({"provider":"codex","targetIds":["0123456789abcdef"]})).is_ok());assert!(validate_method("hooks_install",&json!({"provider":"codex","targetIds":["../other"]})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"codex","path":"/tmp"})).is_err());assert!(validate_method("hooks_install",&json!({"provider":"../other"})).is_err());assert!(validate_method("hooks_verify",&json!({})).is_ok());}}
#[cfg(test)]mod mcp_protocol_tests{use super::*;#[test]fn mcp_methods_are_bounded(){
 assert!(validate_method("mcp_status",&json!({})).is_ok());
 assert!(validate_method("mcp_install",&json!({"provider":"claude"})).is_ok());
 assert!(validate_method("mcp_remove",&json!({"provider":"codex","targetIds":["0123456789abcdef"]})).is_ok());
 assert!(validate_method("mcp_install",&json!({"provider":"other"})).is_err());
 assert!(validate_method("mcp_remove",&json!({"provider":"claude","path":"/tmp"})).is_err());
}}
#[cfg(test)]mod desktop_request_contract_tests{use super::*;#[test]fn dashboard_and_reported_work_requests_are_bounded(){
 assert!(validate_method("summary",&json!({"date":"2026-11-02","background":true})).is_ok());
 assert!(validate_method("summary",&json!({"date":"2026-11-02","background":"true"})).is_err());
 assert!(validate_method("summary",&json!({"date":"2026-11-02","extra":true})).is_err());
 assert!(validate_method("summary",&json!({"date":"2026-11-02","background":true,"since":"abc-1"})).is_ok());
 assert!(validate_method("summary",&json!({"date":"2026-11-02","since":7})).is_err());
 assert!(validate_method("reported_timer_stop",&json!({"taskCounterId":"7a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c62","discard":true})).is_ok());
 assert!(validate_method("reported_timer_stop",&json!({"taskCounterId":"x;rm"})).is_err());
 for method in ["reported_work","work_outcomes"] {
  assert!(validate_method(method,&json!({"date":"2026-11-02"})).is_ok());
  assert!(validate_method(method,&json!({"date":"2026-11-02","extra":true})).is_err());
  assert!(validate_method(method,&json!({"date":"yesterday"})).is_err());
 }
 assert!(validate_method("claude_status_line_status",&json!({})).is_ok());
 assert!(validate_method("claude_status_line_status",&json!({"targetId":"0123456789abcdef"})).is_err());
 for method in ["claude_status_line_install","claude_status_line_remove"] {
  assert!(validate_method(method,&json!({"targetId":"0123456789abcdef"})).is_ok());
  assert!(validate_method(method,&json!({"targetId":"../other"})).is_err());
  assert!(validate_method(method,&json!({"targetId":"0123456789abcdef","extra":true})).is_err());
 }
}}
#[cfg(test)]mod storage_protocol_tests{use super::*;#[test]fn replacement_requires_explicit_archive_and_confirmation(){
 assert!(validate_method("storage_compact_prepare",&json!({})).is_ok());
 assert!(validate_method("storage_compact_prepare",&json!({"path":"/tmp"})).is_err());
 let id="agent-time-2026-10-20T12-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite";
 assert!(validate_method("storage_restore_prepare",&json!({"id":id,"confirmed":true})).is_ok());
 assert!(validate_method("storage_restore_prepare",&json!({"id":id})).is_err());
 assert!(validate_method("storage_restore_prepare",&json!({"id":"../events.sqlite","confirmed":true})).is_err());
}}
#[cfg(test)]mod human_review_tests{use super::*;#[test]fn human_decision_protocol(){
 let segment=json!({"pair":["a","b"],"segment":"before"});
 assert!(validate_method("human_decision_set",&json!({"pairs":[],"segments":[segment.clone()],"mode":"assigned","projectPath":"/project"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["c","d"]],"segments":[segment.clone()],"mode":"unassigned"})).is_ok());
 for segments in [json!(null),json!([{"pair":["a"],"segment":"before"}]),json!([{"pair":["a","b"],"segment":"middle"}]),json!([{"pair":["a","b"],"segment":"before","extra":true}])]{
  assert!(validate_method("human_decision_set",&json!({"pairs":[["c","d"]],"segments":segments,"mode":"unassigned"})).is_err());
 }
 assert!(validate_method("human_decision_set",&json!({"pairs":[],"segments":[segment.clone()],"mode":"clear"})).is_err());
 assert!(validate_method("human_decision_set",&json!({"pairs":[],"segments":vec![segment.clone();10_000],"mode":"unassigned"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["c","d"]],"segments":vec![segment;10_000],"mode":"unassigned"})).is_err());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"assigned","projectPath":"/project"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"unassigned"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a"]],"mode":"assigned","projectPath":"/project"})).is_err());
 assert!(validate_method("human_decision_set",&json!({"pairs":[["a","b"]],"mode":"clear","projectPath":"/project"})).is_err());
 // Bulk assign spans many review rows, each holding up to 500 intervals.
 let pairs=|n:usize|(0..n).map(|i|json!([format!("s{i}"),format!("e{i}")])).collect::<Vec<_>>();
 assert!(validate_method("human_decision_set",&json!({"pairs":pairs(5000),"mode":"unassigned"})).is_ok());
 assert!(validate_method("human_decision_set",&json!({"pairs":pairs(10_001),"mode":"unassigned"})).is_err());
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
 #[test] fn automatic_storage_resume_survives_a_crash_before_the_next_status_poll(){
  let directory=std::env::temp_dir().join(format!("agent-time-storage-resume-crash-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,r#"
const fs=require('fs'),readline=require('readline'),root=process.argv[process.argv.indexOf('--output')+1],marker=root+'/storage-paused.json';let running=false;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='start'&&fs.existsSync(marker)){process.stdout.write(JSON.stringify({id:r.id,error:'low disk space'})+'\n');return;}if(r.method==='start')running=true;if(r.method==='stop')running=false;process.stdout.write(JSON.stringify({id:r.id,result:{running}})+'\n');});
"#).unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  bridge.request("stop",json!({})).unwrap();
  std::fs::write(directory.join("storage-paused.json"),"{}").unwrap();
  assert!(bridge.request("start",json!({})).is_err());
  assert_eq!(bridge.request("status",json!({})).unwrap()["running"],false);
  assert!(bridge.desired_running.load(Ordering::Acquire));
  // Compression has resumed capture and removed its marker, but the native
  // bridge has not observed a running status yet when the collector exits.
  std::fs::remove_file(directory.join("storage-paused.json")).unwrap();
  {let mut child=bridge.child.lock().unwrap();kill_owned(&mut child);}
  assert_eq!(bridge.request("status",json!({})).unwrap()["running"],true);
  bridge.shutdown();let _=std::fs::remove_dir_all(directory);
 }
 #[test] fn storage_pause_survives_application_and_collector_restarts(){
  let directory=std::env::temp_dir().join(format!("agent-time-storage-pause-{}",std::process::id()));
  std::fs::create_dir_all(&directory).unwrap();
  assert!(automatic_capture_allowed(&directory));
  std::fs::write(directory.join("storage-paused.json"),"{}").unwrap();
  assert!(!automatic_capture_allowed(&directory));
  std::fs::remove_file(directory.join("storage-paused.json")).unwrap();
  assert!(automatic_capture_allowed(&directory));
  let _=std::fs::remove_dir_all(directory);
 }
 #[test] fn pending_storage_startup_waits_for_first_reply_and_then_uses_normal_deadlines() {
  let directory=std::env::temp_dir().join(format!("agent-time-storage-startup-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  std::fs::write(directory.join("pending-storage-replacement.json"),"{}").unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,r#"
const fs=require('fs'),readline=require('readline'),root=process.argv[process.argv.indexOf('--output')+1];let first=true;
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);const reply=()=>process.stdout.write(JSON.stringify({id:request.id,result:{ready:true}})+'\n');if(first){first=false;fs.unlinkSync(root+'/pending-storage-replacement.json');setTimeout(reply,200);}else reply();});
"#).unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  let result=bridge.send("status",json!({}),Duration::from_millis(50));
  assert!(!bridge.storage_startup.load(Ordering::Acquire));
  assert_eq!(bridge.long_inflight.load(Ordering::Acquire),0);
  bridge.shutdown();let _=std::fs::remove_dir_all(directory);
  assert_eq!(result.unwrap()["ready"],true,"startup must survive its ordinary reply deadline, even after the replacement marker disappears");
 }
 #[test] fn failed_update_reopens_the_collector_and_restores_capture() {
  let directory=std::env::temp_dir().join(format!("agent-time-update-recovery-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,r#"
const fs=require('fs'),readline=require('readline'),root=process.argv[process.argv.indexOf('--output')+1];
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);fs.appendFileSync(root+'/requests',request.method+'\n');process.stdout.write(JSON.stringify({id:request.id,result:{running:request.method==='start'}})+'\n');});
"#).unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  assert!(bridge.recover_from_update().is_err());
  bridge.request("start",json!({})).unwrap();
  bridge.pause_for_update();
  assert!(bridge.request("status",json!({})).is_err());
  bridge.recover_from_update().unwrap();
  assert_eq!(bridge.request("status",json!({})).unwrap()["method"],Value::Null);
  let requests=std::fs::read_to_string(directory.join("requests")).unwrap();
  assert_eq!(requests.lines().filter(|method|*method=="start").count(),2);
  bridge.shutdown();let _=std::fs::remove_dir_all(directory);
 }
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
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
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
 #[test] fn shutdown_never_respawns_a_dead_collector() {
  let directory=std::env::temp_dir().join(format!("agent-time-shutdown-dead-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,"require('fs').appendFileSync(process.argv[process.argv.indexOf('--output')+1]+'/spawns','x\\n');process.stdin.resume();").unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
  let bridge=Bridge::from_launch(launch).unwrap();
  let spawned=Instant::now();
  while !directory.join("spawns").exists()&&spawned.elapsed()<Duration::from_secs(5){std::thread::sleep(Duration::from_millis(20));}
  {let mut child=bridge.child.lock().unwrap();kill_owned(&mut child);}
  let started=Instant::now();
  bridge.shutdown();
  assert!(started.elapsed()<Duration::from_secs(2),"exit must not wait on a dead collector");
  assert!(bridge.request("status",json!({})).is_err());
  std::thread::sleep(Duration::from_millis(200));
  assert_eq!(std::fs::read_to_string(directory.join("spawns")).unwrap().lines().count(),1);
  let _=std::fs::remove_dir_all(directory);
 }
 #[test] fn repeated_collector_crashes_stop_after_three_restarts() {
  let directory=std::env::temp_dir().join(format!("agent-time-restart-limit-{}",std::process::id()));
  let _=std::fs::remove_dir_all(&directory);std::fs::create_dir_all(&directory).unwrap();
  let script=directory.join("collector.cjs");
  std::fs::write(&script,"process.stdin.resume();process.stdin.once('data',()=>process.exit(1));").unwrap();
  let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
  let launch=LaunchSpec{node:dev_node(&root),cli:script,output:directory.clone(),helper:directory.join("probe"),keychain:directory.join("keychain"),path:"/usr/bin:/bin".into()};
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
mod app_icon_tests {
 #[test]
 fn bundled_window_icon_has_eight_bit_rgba_pixels() {
  let context=super::app_context();
  let icon=context.default_window_icon().expect("the app must have a window icon");
  assert_eq!(icon.rgba().len(),icon.width() as usize*icon.height() as usize*4,
   "Tauri window icons require exactly four 8-bit channels per pixel");
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

#[cfg(test)]
mod audit_protocol_tests {
 use super::*;
 #[test]
 fn linear_workspace_is_optional_and_bounded() {
  for method in ["linear_sync","linear_disconnect"] {
   assert!(validate_method(method,&json!({})).is_ok());
   assert!(validate_method(method,&json!({"workspaceId":"8f2c1a9e-1234-4abc-9def-0123456789ab"})).is_ok());
   assert!(validate_method(method,&json!({"workspaceId":""})).is_err());
   assert!(validate_method(method,&json!({"workspaceId":"a".repeat(129)})).is_err());
   assert!(validate_method(method,&json!({"workspaceId":"../x y"})).is_err());
   assert!(validate_method(method,&json!({"workspaceId":"abc","extra":1})).is_err());
  }
 }
 #[test]
 fn website_rules_are_length_capped() {
  assert!(validate_method("website_rule_set",&json!({"pattern":"a".repeat(513),"projectPath":"/tmp"})).is_err());
  assert!(validate_method("website_rule_preview",&json!({"pattern":"example.com","projectPath":"/".repeat(4097)})).is_err());
  assert!(validate_method("website_rule_preview",&json!({"pattern":"example.com","projectPath":"/tmp"})).is_ok());
  assert!(validate_method("website_rule_remove",&json!({"pattern":"a".repeat(513)})).is_err());
 }
 #[test]
 fn review_mutations_accept_an_optional_date() {
  let pairs=json!([["a","b"]]);
  assert!(validate_method("human_decision_set",&json!({"pairs":pairs,"mode":"assigned","projectPath":"/p","date":"2026-11-02"})).is_ok());
  assert!(validate_method("human_decision_set",&json!({"pairs":pairs,"mode":"clear","date":"2026-11-02"})).is_ok());
  assert!(validate_method("human_decision_set",&json!({"pairs":pairs,"mode":"clear","date":"today"})).is_err());
  assert!(validate_method("human_decision_set",&json!({"pairs":pairs,"mode":"clear","projectPath":"/p","date":"2026-11-02"})).is_err());
  let id="12345678-1234-1234-1234-123456789abc";
  assert!(validate_method("review_undo",&json!({"id":id})).is_ok());
  assert!(validate_method("review_undo",&json!({"id":id,"date":"2026-11-02"})).is_ok());
  assert!(validate_method("review_undo",&json!({"id":id,"date":"2026/11/02"})).is_err());
  assert!(validate_method("review_undo",&json!({"id":id,"other":"2026-11-02"})).is_err());
  assert!(validate_method("human_group_split",&json!({"pairs":pairs,"splitAt":1.0,"beforeProject":"/a","afterProject":"/b","date":"2026-11-02"})).is_ok());
  assert!(validate_method("human_group_split",&json!({"pairs":pairs,"splitAt":1.0,"date":"x"})).is_err());
 }
 #[test]
 fn long_operations_get_long_deadlines() {
  assert_eq!(request_timeout("storage_compact_prepare"),LONG_REQUEST_TIMEOUT);
  assert_eq!(request_timeout("archive_import"),LONG_REQUEST_TIMEOUT);
  assert_eq!(request_timeout("status"),REQUEST_TIMEOUT);
 }
}

#[cfg(test)]mod billing_protocol_tests{use super::*;#[test]fn history_metadata_pages_are_bounded(){
 assert!(validate_method("billing_report_history",&json!({"project":"caex","historyCursor":"12","limit":50})).is_ok());
 assert!(validate_method("billing_report_history",&json!({"project":"caex"})).is_ok());
 for params in [json!({}),json!({"project":""}),json!({"project":"x","limit":0}),json!({"project":"x","limit":51}),json!({"project":"x","limit":1.5}),json!({"project":"x","cursor":"12"}),json!({"project":"x","path":"/tmp"}),json!({"project":"x","historyCursor":"0"}),json!({"project":"x","historyCursor":"../12"}),json!({"project":"x","historyCursor":"9007199254740992"})]{assert!(validate_method("billing_report_history",&params).is_err());}
}
#[test]fn billing_requests_are_restricted(){
 assert!(validate_method("billing_report_progress",&json!({"progressId":"12345678-1234-1234-1234-123456789abc"})).is_ok());
 assert!(validate_method("billing_report_progress",&json!({"progressId":"../../file"})).is_err());
 assert!(validate_method("billing_report_progress",&json!({"progressId":"12345678-1234-1234-1234-123456789abc","path":"/tmp"})).is_err());
 assert!(validate_method("billing_report",&json!({"project":"x","fromDate":"2026-11-01","toDate":"2026-11-10","progressId":"12345678-1234-1234-1234-123456789abc"})).is_ok());
 assert!(validate_method("billing_report",&json!({"project":"x","fromDate":"2026-11-01","toDate":"2026-11-10","progressId":"x"})).is_err());
 assert!(validate_method("day_review_status",&json!({"date":"2026-11-10","includeBacklog":false})).is_ok());
 assert!(validate_method("day_review_status",&json!({"date":"2026-11-10","includeBacklog":"false"})).is_err());
 assert!(validate_method("day_review_mark",&json!({"date":"2026-11-10","includeBacklog":false})).is_err());
 assert!(validate_method("billing_projects",&json!({})).is_ok());assert!(validate_method("billing_projects",&json!({"path":"/tmp"})).is_err());
 assert!(validate_method("billing_report",&json!({"project":"caex","fromDate":"2026-11-01","toDate":"2026-11-30","detail":"daily"})).is_ok());
 assert!(validate_method("billing_report",&json!({"project":"caex","fromDate":"2026-11-01","toDate":"2026-11-30","path":"/tmp"})).is_err());
 assert!(validate_method("billing_report",&json!({"project":"caex","fromDate":"2026-11-01","toDate":"2026-11-30","cursor":"1"})).is_err());
 assert!(validate_method("billing_project_save",&json!({"project":{},"expectedRevision":1})).is_ok());assert!(validate_method("billing_project_save",&json!({"project":{},"expectedRevision":-1})).is_err());
}}

#[cfg(test)]mod period_scope_tests{use super::*;
 #[test]fn period_review_scope_is_bounded(){
  let scope=json!({"fromDate":"2026-11-01","toDate":"2026-11-14","project":"/repo","filters":{"search":"fix","app":"Browser","site":"example.com","device":"local","assignment":"assigned"}});
  assert!(validate_method("period_review",&scope).is_ok());
  for extra in [json!({"filters":true}),json!({"filters":{"assignment":"bad"}}),json!({"filters":{"sql":"delete"}}),json!({"path":"/tmp"})]{let mut invalid=scope.clone();for(k,v)in extra.as_object().unwrap(){invalid[k]=v.clone();}assert!(validate_method("period_review",&invalid).is_err());}
 }
}
