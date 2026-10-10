//! 小助手要的几样系统能力：键鼠空闲时长、下载日历订阅、选本地 .ics 文件。
//! 下载用系统自带的 WinHTTP（走系统代理设置、系统证书），不引入额外的 HTTP/TLS 依赖。

use std::ffi::c_void;
use std::mem::size_of;
use std::thread;

use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, SIGDN_FILESYSPATH};

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
        12002 => "超时".to_string(),
        12007 => "域名解析失败".to_string(),
        12029 | 12030 => "连接失败".to_string(),
        12157 | 12175 => "安全连接（TLS）失败".to_string(),
        12005 | 12006 => "地址格式不对".to_string(),
        _ => format!("错误码 {code}"),
    };
    format!("{what}：{why}")
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
    unsafe { WinHttpCrackUrl(&wide, 0, &mut parts) }.map_err(|_| "地址格式不对".to_string())?;
    let secure = parts.nScheme == WINHTTP_INTERNET_SCHEME_HTTPS;
    if !secure && parts.nScheme != WINHTTP_INTERNET_SCHEME_HTTP {
        return Err("只支持 http / https / webcal 地址".into());
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
            return Err(last_error("初始化网络失败"));
        }
        let _ = WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 30_000);
        let connect = Handle(WinHttpConnect(session.0, &host, parts.nPort, 0));
        if connect.0.is_null() {
            return Err(last_error("连不上服务器"));
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
            return Err(last_error("请求失败"));
        }
        // gzip / deflate 自动解压（Windows 8.1 起支持；不支持就算了）
        let decompress = 3u32.to_ne_bytes();
        let _ = WinHttpSetOption(Some(request.0), WINHTTP_OPTION_DECOMPRESSION, Some(&decompress));
        WinHttpSendRequest(request.0, None, None, 0, 0, 0).map_err(|_| last_error("发送请求失败"))?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(|_| last_error("没有收到响应"))?;

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
        .map_err(|_| last_error("读取状态码失败"))?;
        if status != 200 {
            return Err(format!("服务器返回 HTTP {status}"));
        }

        let mut body: Vec<u8> = Vec::new();
        loop {
            let mut avail = 0u32;
            WinHttpQueryDataAvailable(request.0, &mut avail).map_err(|_| last_error("读取数据失败"))?;
            if avail == 0 {
                break;
            }
            let start = body.len();
            body.resize(start + avail as usize, 0);
            let mut read = 0u32;
            WinHttpReadData(request.0, body[start..].as_mut_ptr() as *mut c_void, avail, &mut read)
                .map_err(|_| last_error("读取数据失败"))?;
            body.truncate(start + read as usize);
            if body.len() > MAX_BODY {
                return Err("日历文件太大了".into());
            }
        }
        Ok(decode_text(body))
    }
}

/// iCalendar 规定是 UTF-8；去掉 BOM，偶尔遇到坏字节就替换掉
pub fn decode_text(bytes: Vec<u8>) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(<[u8]>::to_vec).unwrap_or(bytes);
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
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
