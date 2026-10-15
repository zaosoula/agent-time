fn main() {
 println!("cargo:rerun-if-env-changed=AGENT_TIME_BETA");
 tauri_build::build();
}
