//! DeepSeek Harness 联动。
//!
//! DSH 没有 shell hooks，但能在补丁层里按绝对路径插入 cordis 插件。开启时：
//! 1. 把 `dsh/clawd-pet.mjs`（编进本程序）写到 `$DSH_HOME/clawd-pet/clawd-pet-<哈希>.mjs`；
//! 2. 在 home 级补丁 `$DSH_HOME/cordis.patch.yml`（对所有 profile 生效）里加一段带标记的 insert。
//!
//! 插件在 DSH 进程里直接连宠物的本机桥接端口，所以宠物换了位置也不用重装；
//! 只有令牌或插件内容变了才需要更新。DSH 开着 HMR，改补丁后不用重启就生效；
//! 但它只认补丁里新出现的条目（同一个 id 只改路径不会重新 import），所以条目 id 和插件文件名
//! 都带内容哈希：插件一变就是一个新条目，DSH 卸掉旧的、加载新的。
//! 关闭时只删我们那一段，用户自己的补丁原样保留。

use std::path::{Path, PathBuf};

use crate::claude::{HookStatus, PORT};

pub const PLUGIN: &str = include_str!("../dsh/clawd-pet.mjs");
const BEGIN: &str = "# >>> clawd-pet (managed by Clawd Pet — turn it off from the pet's Assistant window)";
const END: &str = "# <<< clawd-pet";

pub fn home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DSH_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".dsh"))
}

fn plugin_dir(home: &Path) -> PathBuf {
    home.join("clawd-pet")
}

/// 插件版本：内容的 FNV-1a 哈希，只用来区分版本
fn version() -> String {
    let hash = PLUGIN.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{:08x}", hash as u32)
}

fn plugin_path(home: &Path) -> PathBuf {
    plugin_dir(home).join(format!("clawd-pet-{}.mjs", version()))
}

/// 删掉旧版本的插件文件（DSH 正开着、文件被占用时删不掉也无所谓）
fn remove_plugins(home: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(plugin_dir(home)) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if Some(p.as_path()) != keep && p.extension().is_some_and(|x| x == "mjs") {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// YAML 单引号字符串：只需要把 ' 写成 ''
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn block(plugin: &Path, token: &str, permission: bool) -> String {
    // 路径用正斜杠：DSH 把绝对路径转成 file URL，正反斜杠都认，正斜杠在 YAML 里更省心
    let path = plugin.to_string_lossy().replace('\\', "/");
    format!(
        "{BEGIN}\n- insert:\n    - id: clawd-pet-{}\n      name: {}\n      config:\n        port: {PORT}\n        token: {}\n        permission: {permission}\n{END}\n",
        version(),
        quote(&path),
        quote(token),
    )
}

/// 去掉我们那一段，返回剩下的文本和找到的那一段
fn split(text: &str) -> (String, Option<String>) {
    let mut rest = String::new();
    let mut ours: Option<String> = None;
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        let t = line.trim_end();
        if !inside && t.starts_with("# >>> clawd-pet") {
            inside = true;
            ours = Some(String::new());
        }
        if inside {
            ours.as_mut().unwrap().push_str(line);
            if t == END {
                inside = false;
            }
        } else {
            rest.push_str(line);
        }
    }
    (rest, ours)
}

/// 除了注释和空行之外的内容
fn content_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#'))
}

fn read(path: &Path) -> Result<String, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("Read {}: {e}", path.display())),
    };
    let text = String::from_utf8(bytes).map_err(|_| format!("{}: not UTF-8, left unchanged", path.display()))?;
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
    }
    // 只备份用户原来的文件：已经有我们那一段的（插件升级、改设置）不再备份
    let backup = path.with_extension("yml.clawd-backup");
    let untouched = read(path).is_ok_and(|t| split(&t).1.is_none());
    if path.exists() && untouched && !backup.exists() {
        std::fs::copy(path, &backup).map_err(|e| format!("Back up {}: {e}", path.display()))?;
    }
    let tmp = path.with_extension("yml.clawd-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Save {}: {e}", path.display()))
}

fn install_into(home: &Path, token: &str, permission: bool) -> Result<(), String> {
    let patch = home.join("cordis.patch.yml");
    let (rest, _) = split(&read(&patch)?);
    let lines: Vec<&str> = content_lines(&rest).collect();
    // 补丁文件是一个顶层 YAML 数组。空的（或者 `[]`）就换成我们的；块格式就接在后面
    let mut text = if lines.is_empty() || lines == ["[]"] {
        rest.lines().filter(|l| l.trim() != "[]").map(|l| format!("{l}\n")).collect::<String>()
    } else if lines[0].starts_with('[') {
        return Err(format!(
            "{}: uses an inline [ … ] list; rewrite it as a block list (one \"- \" entry per line) and try again",
            patch.display()
        ));
    } else {
        rest
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    let plugin = plugin_path(home);
    text.push_str(&block(&plugin, token, permission));
    // 先放插件再改补丁：DSH 一看到补丁变了就会去加载它
    if let Some(dir) = plugin.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
    }
    std::fs::write(&plugin, PLUGIN).map_err(|e| format!("{}: {e}", plugin.display()))?;
    write(&patch, &text)?;
    remove_plugins(home, Some(&plugin));
    Ok(())
}

pub fn install(token: &str, permission: bool) -> Result<(), String> {
    let home = home().ok_or("Could not find the DeepSeek Harness folder")?;
    install_into(&home, token, permission)
}

fn uninstall_from(home: &Path) -> Result<(), String> {
    let patch = home.join("cordis.patch.yml");
    if patch.exists() {
        let text = read(&patch)?;
        let (rest, ours) = split(&text);
        if ours.is_some() {
            if rest.trim().is_empty() {
                // 文件是我们建的：删掉，DSH 没有这个文件也照常启动
                std::fs::remove_file(&patch).map_err(|e| e.to_string())?;
            } else if content_lines(&rest).next().is_none() {
                // 只剩注释的补丁文件会让 DSH 启动失败，补一个空数组
                let mut rest = rest;
                if !rest.ends_with('\n') {
                    rest.push('\n');
                }
                write(&patch, &(rest + "[]\n"))?;
            } else {
                write(&patch, &rest)?;
            }
        }
    }
    // DSH 可能还开着、正用着它：删不掉也无所谓，补丁里已经不加载了
    remove_plugins(home, None);
    let _ = std::fs::remove_dir(plugin_dir(home));
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    match home() {
        Some(h) => uninstall_from(&h),
        None => Ok(()),
    }
}

fn status_at(home: &Path, token: &str) -> HookStatus {
    let patch = home.join("cordis.patch.yml");
    let mut st = HookStatus {
        installed: false,
        permission: false,
        current: true,
        settings_path: patch.display().to_string(),
        error: None,
    };
    let text = match read(&patch) {
        Ok(t) => t,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    let Some(ours) = split(&text).1 else { return st };
    st.installed = true;
    st.permission = ours.contains("permission: true");
    let plugin = plugin_path(home);
    st.current = ours == block(&plugin, token, st.permission)
        && std::fs::read_to_string(&plugin).is_ok_and(|p| p == PLUGIN);
    st
}

pub fn status(token: &str) -> HookStatus {
    match home() {
        Some(h) => status_at(&h, token),
        None => HookStatus {
            installed: false,
            permission: false,
            current: false,
            settings_path: String::new(),
            error: Some("Could not find the DeepSeek Harness folder".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clawd dsh テスト {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn install_into_fresh_home_and_remove_file_again() {
        let home = temp_home("fresh");
        install_into(&home, "tok", true).unwrap();
        install_into(&home, "tok", false).unwrap();
        assert!(!home.join("cordis.patch.yml.clawd-backup").exists(), "only the user's own file is backed up");
        install_into(&home, "tok", true).unwrap();
        let text = std::fs::read_to_string(home.join("cordis.patch.yml")).unwrap();
        assert!(text.starts_with(BEGIN));
        assert!(text.contains("token: 'tok'") && text.contains("permission: true"));
        assert!(text.contains("dsh テスト"),"path keeps Japanese characters: {text}");
        assert_eq!(std::fs::read_to_string(plugin_path(&home)).unwrap(), PLUGIN);
        let st = status_at(&home, "tok");
        assert!(st.installed && st.current && st.permission);
        assert!(!status_at(&home, "other").current);
        uninstall_from(&home).unwrap();
        assert!(!home.join("cordis.patch.yml").exists());
        assert!(!plugin_dir(&home).exists());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn keeps_user_patches_and_comments() {
        let home = temp_home("user");
        let patch = home.join("cordis.patch.yml");
        let original = "# my notes\n- id: ui-chat\n  config:\n    transcriptView: detailed\n";
        std::fs::write(&patch, original).unwrap();
        install_into(&home, "tok", false).unwrap();
        // 旧版本留下的插件文件在更新时清掉
        std::fs::write(plugin_dir(&home).join("clawd-pet-old.mjs"), "old").unwrap();
        install_into(&home, "tok", true).unwrap();
        assert_eq!(std::fs::read_dir(plugin_dir(&home)).unwrap().count(), 1);
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(text.starts_with(original));
        assert_eq!(text.matches("# >>> clawd-pet").count(), 1, "reinstall does not duplicate");
        assert_eq!(std::fs::read_to_string(patch.with_extension("yml.clawd-backup")).unwrap(), original);
        uninstall_from(&home).unwrap();
        assert_eq!(std::fs::read_to_string(&patch).unwrap(), original);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn empty_list_and_comment_only_files() {
        let home = temp_home("empty");
        let patch = home.join("cordis.patch.yml");
        std::fs::write(&patch, "# header\n[]\n").unwrap();
        install_into(&home, "tok", true).unwrap();
        let text = std::fs::read_to_string(&patch).unwrap();
        assert!(!text.contains("[]"), "the empty list is replaced: {text}");
        uninstall_from(&home).unwrap();
        // 只剩注释的文件会让 DSH 启动失败，所以写回空数组
        assert_eq!(std::fs::read_to_string(&patch).unwrap(), "# header\n[]\n");
        std::fs::write(&patch, "[{ id: x, disabled: true }]\n").unwrap();
        assert!(install_into(&home, "tok", true).is_err());
        assert_eq!(std::fs::read_to_string(&patch).unwrap(), "[{ id: x, disabled: true }]\n");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn yaml_quotes_apostrophes() {
        let b = block(Path::new("C:\\Users\\O'Neil\\.dsh\\clawd-pet\\clawd-pet.mjs"), "t", true);
        assert!(b.contains("name: 'C:/Users/O''Neil/.dsh/clawd-pet/clawd-pet.mjs'"), "{b}");
    }
}
