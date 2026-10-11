//! 界面语言：中文 / 日文 / 英文，其他语言用英文。托盘菜单、窗口标题和原生侧的错误提示都按它选。
//! （网页里的文字由前端按 navigator.language 选，规则一致。）

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Zh,
    Ja,
    En,
}

/// Windows 的 LANGID：低 10 位是主语言（0x04 = 中文，简体繁体都算；0x11 = 日文）
pub fn from_langid(id: u16) -> Lang {
    match id & 0x3ff {
        0x04 => Lang::Zh,
        0x11 => Lang::Ja,
        _ => Lang::En,
    }
}

#[cfg(windows)]
fn detect() -> Lang {
    from_langid(unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() })
}

#[cfg(not(windows))]
fn detect() -> Lang {
    match std::env::var("LANG") {
        Ok(l) if l.starts_with("zh") => Lang::Zh,
        Ok(l) if l.starts_with("ja") => Lang::Ja,
        _ => Lang::En,
    }
}

pub fn lang() -> Lang {
    static LANG: std::sync::OnceLock<Lang> = std::sync::OnceLock::new();
    *LANG.get_or_init(detect)
}

/// 按当前语言挑一句
pub fn tr(zh: &str, ja: &str, en: &str) -> String {
    match lang() {
        Lang::Zh => zh,
        Lang::Ja => ja,
        Lang::En => en,
    }
    .to_string()
}

/// "说明：原因" 里的冒号（英文用半角加空格）
pub fn colon() -> &'static str {
    match lang() {
        Lang::En => ": ",
        _ => "：",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn langid_maps_primary_language() {
        assert_eq!(from_langid(0x0411), Lang::Ja); // ja-JP
        assert_eq!(from_langid(0x0804), Lang::Zh); // zh-CN
        assert_eq!(from_langid(0x0404), Lang::Zh); // zh-TW
        assert_eq!(from_langid(0x0c04), Lang::Zh); // zh-HK
        assert_eq!(from_langid(0x0409), Lang::En); // en-US
        assert_eq!(from_langid(0x0412), Lang::En); // ko-KR 归到英文
    }
}
