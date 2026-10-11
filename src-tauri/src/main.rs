// 发布版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code 的 hook、卸载时的清理：做完就退出，不启动宠物
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = clawd_pet_lib::cli(&args) {
        std::process::exit(code);
    }
    clawd_pet_lib::run()
}
