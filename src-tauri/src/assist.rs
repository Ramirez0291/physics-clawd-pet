//! 小助手要的几样系统能力：键鼠空闲时长、下载日历订阅、选本地 .ics 文件。
//! 下载用系统自带的 WinHTTP（走系统代理设置、系统证书），不引入额外的 HTTP/TLS 依赖。

use std::ffi::c_void;
use std::mem::size_of;
use std::thread;

use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Globalization::{GetACP, MultiByteToWideChar, MB_ERR_INVALID_CHARS};
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, SIGDN_FILESYSPATH};

use crate::lang::{colon, tr};

/// 距离上一次键盘/鼠标操作多少毫秒（整个系统的，不只是本程序）
pub fn idle_ms() -> u64 {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return 0;
        }
        // 两个都是会回绕的 32 位毫秒计数，相减按回绕算
        GetTickCount().wrapping_sub(info.dwTime) as u64
    }
}

/// 日历文件最大多大（超过就当出错，免得把内存吃光）
const MAX_BODY: usize = 20 * 1024 * 1024;

/// 关掉 WinHTTP 句柄
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

/// WinHTTP 的错误码在系统消息表里查不到文字，常见的几个自己翻
fn last_error(what: &str) -> String {
    let code = unsafe { windows::Win32::Foundation::GetLastError() }.0;
    let why = match code {
        12002 => tr("超时", "タイムアウトしました", "timed out"),
        12007 => tr("域名解析失败", "ホスト名を解決できませんでした", "could not resolve the host name"),
        12029 | 12030 => tr("连接失败", "接続できませんでした", "connection failed"),
        12157 | 12175 => tr("安全连接（TLS）失败", "セキュア接続（TLS）に失敗しました", "secure connection (TLS) failed"),
        12005 | 12006 => tr("地址格式不对", "URLの形式が正しくありません", "invalid URL"),
        _ => tr(&format!("错误码 {code}"), &format!("エラーコード {code}"), &format!("error code {code}")),
    };
    format!("{what}{}{why}", colon())
}

/// 地址格式错误（解析不了）
fn bad_url() -> String {
    tr("地址格式不对", "URLの形式が正しくありません", "Invalid URL")
}

fn read_failed() -> String {
    tr("读取数据失败", "データの読み取りに失敗しました", "Could not read the data")
}

/// GET 一个 http(s) 地址，返回 UTF-8 文本。自动跟随重定向、解 gzip。
pub fn http_get(url: &str) -> Result<String, String> {
    let wide: Vec<u16> = url.encode_utf16().collect();
    // 指针留空、长度非零：WinHTTP 直接把各部分在原字符串里的位置和长度填回来
    let mut parts = URL_COMPONENTS {
        dwStructSize: size_of::<URL_COMPONENTS>() as u32,
        dwHostNameLength: 1,
        dwUrlPathLength: 1,
        dwExtraInfoLength: 1,
        ..Default::default()
    };
    unsafe { WinHttpCrackUrl(&wide, 0, &mut parts) }.map_err(|_| bad_url())?;
    let secure = parts.nScheme == WINHTTP_INTERNET_SCHEME_HTTPS;
    if !secure && parts.nScheme != WINHTTP_INTERNET_SCHEME_HTTP {
        return Err(tr(
            "只支持 http / https / webcal 地址",
            "http / https / webcal のURLのみ対応しています",
            "Only http / https / webcal URLs are supported",
        ));
    }
    let slice = |p: PWSTR, n: u32| -> &[u16] {
        if p.is_null() {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(p.0, n as usize) }
        }
    };
    let host = HSTRING::from_wide(slice(parts.lpszHostName, parts.dwHostNameLength));
    // 路径后面紧跟着 ?query（私密订阅链接的 token 常在这里），两段在原串里是连着的
    let path_len = parts.dwUrlPathLength + parts.dwExtraInfoLength;
    let path = if parts.lpszUrlPath.is_null() {
        HSTRING::from("/")
    } else {
        HSTRING::from_wide(slice(parts.lpszUrlPath, path_len))
    };

    unsafe {
        let session = Handle(WinHttpOpen(
            w!("PhysicsClawdPet/1.0"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ));
        if session.0.is_null() {
            return Err(last_error(&tr("初始化网络失败", "ネットワークの初期化に失敗しました", "Could not start networking")));
        }
        let _ = WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 30_000);
        let connect = Handle(WinHttpConnect(session.0, &host, parts.nPort, 0));
        if connect.0.is_null() {
            return Err(last_error(&tr("连不上服务器", "サーバーに接続できません", "Could not reach the server")));
        }
        let flags = if secure { WINHTTP_FLAG_SECURE } else { WINHTTP_OPEN_REQUEST_FLAGS(0) };
        let request = Handle(WinHttpOpenRequest(
            connect.0,
            w!("GET"),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        ));
        if request.0.is_null() {
            return Err(last_error(&tr("请求失败", "リクエストに失敗しました", "Request failed")));
        }
        // gzip / deflate 自动解压（Windows 8.1 起支持；不支持就算了）
        let decompress = 3u32.to_ne_bytes();
        let _ = WinHttpSetOption(Some(request.0), WINHTTP_OPTION_DECOMPRESSION, Some(&decompress));
        WinHttpSendRequest(request.0, None, None, 0, 0, 0)
            .map_err(|_| last_error(&tr("发送请求失败", "リクエストの送信に失敗しました", "Could not send the request")))?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut())
            .map_err(|_| last_error(&tr("没有收到响应", "応答がありません", "No response")))?;

        let mut status = 0u32;
        let mut len = size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut c_void),
            &mut len,
            std::ptr::null_mut(),
        )
        .map_err(|_| last_error(&tr("读取状态码失败", "ステータスコードを読み取れません", "Could not read the status code")))?;
        if status != 200 {
            return Err(tr(
                &format!("服务器返回 HTTP {status}"),
                &format!("サーバーが HTTP {status} を返しました"),
                &format!("The server returned HTTP {status}"),
            ));
        }

        let mut body: Vec<u8> = Vec::new();
        loop {
            let mut avail = 0u32;
            WinHttpQueryDataAvailable(request.0, &mut avail).map_err(|_| last_error(&read_failed()))?;
            if avail == 0 {
                break;
            }
            let start = body.len();
            body.resize(start + avail as usize, 0);
            let mut read = 0u32;
            WinHttpReadData(request.0, body[start..].as_mut_ptr() as *mut c_void, avail, &mut read)
                .map_err(|_| last_error(&read_failed()))?;
            body.truncate(start + read as usize);
            if body.len() > MAX_BODY {
                return Err(tr("日历文件太大了", "カレンダーファイルが大きすぎます", "The calendar file is too large"));
            }
        }
        Ok(decode_text(body))
    }
}

/// iCalendar 规定是 UTF-8，但现实里有不守规矩的：
/// UTF-16（记事本"Unicode"、PowerShell 5.1 的 `>`）带 BOM；
/// 老的グループウェア（サイボウズ、desknet's NEO）和旧版 Outlook 导出的是系统代码页（日文系统 Shift_JIS、中文系统 GBK）。
pub fn decode_text(bytes: Vec<u8>) -> String {
    let utf16 = |rest: &[u8], big_endian: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| if big_endian { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, true);
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(<[u8]>::to_vec).unwrap_or(bytes);
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            let bytes = e.into_bytes();
            // 不是合法 UTF-8：先当系统代码页试（严格模式，有非法字节就放弃），都不行才把坏字节替换掉
            decode_codepage(&bytes, unsafe { GetACP() })
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// 按指定代码页严格解码（有非法字节返回 None）
fn decode_codepage(bytes: &[u8], codepage: u32) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    unsafe {
        let n = MultiByteToWideChar(codepage, MB_ERR_INVALID_CHARS, bytes, None);
        if n <= 0 {
            return None;
        }
        let mut wide = vec![0u16; n as usize];
        let written = MultiByteToWideChar(codepage, MB_ERR_INVALID_CHARS, bytes, Some(&mut wide));
        (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
    }
}

/// 弹出"打开文件"对话框选一个 .ics，返回路径；取消返回 None。
/// 在单独的 STA 线程里跑，不阻塞 Tauri 的主线程。
pub fn pick_ics(owner: Option<isize>, title: String, filter_name: String) -> Option<String> {
    thread::spawn(move || unsafe {
        let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| -> windows::core::Result<Option<String>> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            let name = HSTRING::from(filter_name);
            let all = HSTRING::from("*.ics;*.ical;*.ifb");
            let filters = [COMDLG_FILTERSPEC { pszName: PCWSTR(name.as_ptr()), pszSpec: PCWSTR(all.as_ptr()) }];
            dialog.SetFileTypes(&filters)?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_FILEMUSTEXIST)?;
            dialog.SetTitle(&HSTRING::from(title))?;
            if dialog.Show(owner.map(|h| HWND(h as *mut c_void))).is_err() {
                return Ok(None); // 取消
            }
            let item = dialog.GetResult()?;
            let p = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const c_void));
            Ok(path)
        })();
        if inited {
            CoUninitialize();
        }
        result.ok().flatten()
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_is_sane() {
        // 跑测试的时候不可能几天没碰过电脑
        assert!(idle_ms() < 7 * 24 * 3600 * 1000);
    }

    #[test]
    fn decode_strips_bom() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFBEGIN:VCALENDAR".to_vec()), "BEGIN:VCALENDAR");
    }

    #[test]
    fn decode_utf8_japanese_is_untouched() {
        assert_eq!(decode_text("SUMMARY:会議 ☕\n".as_bytes().to_vec()), "SUMMARY:会議 ☕\n");
    }

    #[test]
    fn decode_utf16_with_bom() {
        let mut le = vec![0xFF, 0xFE];
        le.extend("SUMMARY:会議".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_text(le), "SUMMARY:会議");
        let mut be = vec![0xFE, 0xFF];
        be.extend("SUMMARY:会議".encode_utf16().flat_map(u16::to_be_bytes));
        assert_eq!(decode_text(be), "SUMMARY:会議");
    }

    #[test]
    fn decode_shift_jis_by_codepage() {
        // 932 = Shift_JIS："会議" = 89 EF 8B 63（代码页参数写死，在任何系统上都能跑）
        assert_eq!(decode_codepage(b"SUMMARY:\x89\xEF\x8B\x63", 932).as_deref(), Some("SUMMARY:会議"));
        // 严格模式：孤立的前导字节算非法
        assert_eq!(decode_codepage(b"\x89", 932), None);
    }

    /// 需要联网：cargo test -- --ignored
    #[test]
    #[ignore]
    fn fetch_public_calendar() {
        let text = http_get("https://calendars.icloud.com/holidays/cn_zh.ics").expect("download");
        assert!(text.contains("BEGIN:VCALENDAR"), "{}", &text[..text.len().min(200)]);
        assert!(http_get("https://calendars.icloud.com/holidays/does-not-exist.ics").is_err());
        assert!(http_get("ftp://example.com/x.ics").is_err());
    }
}
