#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use mailparse::{dateparse, parse_mail, ParsedMail};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use walkdir::WalkDir;

// ============================ 数据模型 ============================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Addr {
    name: Option<String>,
    email: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    index: usize,
    file_name: String,
    content_type: String,
    size_bytes: usize,
    content_id: Option<String>,
    inline: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RawHeader {
    key: String,
    value: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmlData {
    path: String,
    file_name: String,
    size_bytes: u64,
    subject: String,
    from: Option<Addr>,
    to: Vec<Addr>,
    cc: Vec<Addr>,
    date_ts: Option<i64>,
    message_id: Option<String>,
    raw_headers: Vec<RawHeader>,
    has_html: bool,
    text_body: String,
    html_body: String,
    attachments: Vec<Attachment>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmlSummary {
    path: String,
    file_name: String,
    size_bytes: u64,
    subject: String,
    from_name: Option<String>,
    from_email: Option<String>,
    to: Vec<Addr>,
    cc: Vec<Addr>,
    date_ts: Option<i64>,
    attachment_count: usize,
}

// ============================ RFC 2047 头部解码 ============================

fn decode_word(charset: &str, enc: u8, payload: &str) -> String {
    let bytes: Vec<u8> = match enc {
        b'B' | b'b' => {
            let clean: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
            base64::engine::general_purpose::STANDARD
                .decode(clean.as_bytes())
                .unwrap_or_default()
        }
        _ => {
            // Q 编码：下划线 = 空格，=XX 十六进制转义
            let bs = payload.as_bytes();
            let mut out = Vec::with_capacity(bs.len());
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            let mut i = 0;
            while i < bs.len() {
                match bs[i] {
                    b'_' => {
                        out.push(0x20);
                        i += 1;
                    }
                    b'=' if i + 2 < bs.len() && hex(bs[i + 1]).is_some() && hex(bs[i + 2]).is_some() => {
                        out.push(hex(bs[i + 1]).unwrap() * 16 + hex(bs[i + 2]).unwrap());
                        i += 3;
                    }
                    c => {
                        out.push(c);
                        i += 1;
                    }
                }
            }
            out
        }
    };
    let enc_rs = encoding_rs::Encoding::for_label(charset.as_bytes())
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = enc_rs.decode(&bytes);
    text.into_owned()
}

/// 解码 RFC 2047 encoded-word（=?charset?B/Q?data?=）。
/// 相邻 encoded-word 之间的纯空白会被忽略（RFC 规定折叠行为）。
fn decode_encoded_words(input: &str) -> String {
    let re = Regex::new(r"=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=").unwrap();
    let mut out = String::with_capacity(input.len());
    let mut last = 0usize;
    let mut after_word = false;
    for m in re.captures_iter(input) {
        let (start, end) = (m.get(0).unwrap().start(), m.get(0).unwrap().end());
        let gap = &input[last..start];
        let gap_is_ws = !gap.is_empty() && gap.chars().all(char::is_whitespace);
        if !(after_word && gap_is_ws) {
            out.push_str(gap);
        }
        out.push_str(&decode_word(
            m.get(1).unwrap().as_str(),
            m.get(2).unwrap().as_str().as_bytes()[0],
            m.get(3).unwrap().as_str(),
        ));
        last = end;
        after_word = true;
    }
    out.push_str(&input[last..]);
    out
}

/// RFC 2231 percent-decode（filename*=utf-8''xx%20yy）
fn percent_decode(s: &str) -> String {
    let bs = s.as_bytes();
    let mut out = Vec::with_capacity(bs.len());
    let hex = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < bs.len() {
        if bs[i] == b'%' && i + 2 < bs.len() {
            if let (Some(a), Some(b)) = (hex(bs[i + 1]), hex(bs[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(bs[i]);
        i += 1;
    }
    let (t, _, _) = encoding_rs::UTF_8.decode(&out);
    t.into_owned()
}

fn clean_header(v: &str) -> String {
    let decoded = decode_encoded_words(v);
    let mut result = String::with_capacity(decoded.len());
    let mut prev_ws = false;
    for c in decoded.chars() {
        if c == '\r' || c == '\n' || c == '\t' {
            if !prev_ws {
                result.push(' ');
                prev_ws = true;
            }
        } else {
            result.push(c);
            prev_ws = false;
        }
    }
    result.trim().to_string()
}

// ============================ 地址解析 ============================

fn parse_addrs(value: &str) -> Vec<Addr> {
    let decoded = clean_header(value);
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in decoded.chars() {
        match c {
            '"' => {
                in_quote = !in_quote;
                cur.push(c);
            }
            ',' if !in_quote => {
                parts.push(cur.clone());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }

    parts
        .into_iter()
        .filter_map(|p| {
            let p = p.trim();
            if p.is_empty() {
                return None;
            }
            if let Some(lt) = p.rfind('<') {
                if p.ends_with('>') {
                    let email = p[lt + 1..p.len() - 1].trim().to_string();
                    let name = p[..lt].trim().trim_matches('"').trim().to_string();
                    return Some(Addr {
                        name: if name.is_empty() { None } else { Some(name) },
                        email,
                    });
                }
            }
            if p.contains('@') {
                Some(Addr {
                    name: None,
                    email: p.trim_matches('"').to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

// ============================ MIME 部件遍历 ============================

fn header_of<'a>(m: &'a ParsedMail<'a>, key: &str) -> Option<String> {
    m.headers
        .iter()
        .find(|h| h.get_key().eq_ignore_ascii_case(key))
        .map(|h| h.get_value())
}

/// 从 content-disposition / content-type 中提取文件名参数
fn param_value(header: &str, key: &str) -> Option<String> {
    let re = Regex::new(&format!(
        r#"(?i){key}\*?=\s*(?:"([^"]*)"|([^;\s]+))"#
    ))
    .ok()?;
    let caps = re.captures(header)?;
    let raw = caps
        .get(1)
        .map(|m| m.as_str())
        .or_else(|| caps.get(2).map(|m| m.as_str()))?;
    let raw = raw.trim_matches('"');
    if raw.contains("''") {
        // RFC 2231: charset''percent-encoded
        let after = raw.splitn(2, "''").nth(1).unwrap_or(raw);
        Some(percent_decode(after))
    } else {
        Some(raw.to_string())
    }
}

fn part_filename(m: &ParsedMail) -> Option<String> {
    let cd = header_of(m, "content-disposition").unwrap_or_default();
    if let Some(f) = param_value(&cd, "filename").filter(|s| !s.is_empty()) {
        return Some(clean_header(&f));
    }
    let ct = header_of(m, "content-type").unwrap_or_default();
    param_value(&ct, "name")
        .filter(|s| !s.is_empty())
        .map(|f| clean_header(&f))
}

fn disposition_type(m: &ParsedMail) -> String {
    header_of(m, "content-disposition")
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .to_lowercase()
}

fn content_id_of(m: &ParsedMail) -> Option<String> {
    header_of(m, "content-id").map(|v| {
        v.trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string()
    }).filter(|s| !s.is_empty())
}

struct AttachHit<'a> {
    part: &'a ParsedMail<'a>,
    meta: Attachment,
}

fn collect_attachments<'a>(root: &'a ParsedMail<'a>) -> Vec<AttachHit<'a>> {
    fn walk<'a>(m: &'a ParsedMail<'a>, out: &mut Vec<AttachHit<'a>>) {
        let ct = m.ctype.mimetype.to_lowercase();
        let cd = disposition_type(m);
        let cid = content_id_of(m);
        let fname = part_filename(m);
        let is_container = ct.starts_with("multipart/") && !m.subparts.is_empty();

        if !is_container {
            let is_att = cd == "attachment"
                || (fname.is_some() && ct != "text/plain" && ct != "text/html")
                || (ct.starts_with("image/") && (cid.is_some() || fname.is_some()));
            if is_att {
                let size = m.get_body_raw().map(|b| b.len()).unwrap_or(0);
                out.push(AttachHit {
                    part: m,
                    meta: Attachment {
                        index: out.len(),
                        file_name: fname.clone().unwrap_or_else(|| {
                            format!("attachment-{}", out.len() + 1)
                        }),
                        content_type: ct.clone(),
                        size_bytes: size,
                        content_id: cid,
                        inline: cd == "inline",
                    },
                });
            }
        }
        for sub in &m.subparts {
            walk(sub, out);
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

fn find_body_part<'a>(
    m: &'a ParsedMail<'a>,
    mime: &str,
) -> Option<&'a ParsedMail<'a>> {
    let ct = m.ctype.mimetype.to_lowercase();
    let cd = disposition_type(m);
    if ct.starts_with("multipart/") || cd == "attachment" {
        // 容器或显式附件：继续向下找（multipart 内部），附件不再下钻
        if ct.starts_with("multipart/") {
            for sub in &m.subparts {
                if let Some(f) = find_body_part(sub, mime) {
                    return Some(f);
                }
            }
        }
        return None;
    }
    if ct == mime {
        return Some(m);
    }
    for sub in &m.subparts {
        if let Some(f) = find_body_part(sub, mime) {
            return Some(f);
        }
    }
    None
}

fn decode_body(m: &ParsedMail) -> String {
    match m.get_body() {
        Ok(s) => s,
        Err(_) => {
            // 字符集异常时兜底 UTF-8 lossy
            match m.get_body_raw() {
                Ok(b) => String::from_utf8_lossy(b.as_ref()).into_owned(),
                Err(_) => String::new(),
            }
        }
    }
}

fn parse_into_data(path: &str, bytes: &[u8]) -> Result<EmlData, String> {
    let mail = parse_mail(bytes).map_err(|e| format!("解析失败: {e}"))?;

    let subject = header_of(&mail, "subject")
        .map(|v| clean_header(&v))
        .unwrap_or_else(|| "(无主题)".to_string());
    let from = header_of(&mail, "from").map(|v| parse_addrs(&v));
    let from = from.and_then(|v| v.into_iter().next());
    let to = header_of(&mail, "to")
        .map(|v| parse_addrs(&v))
        .unwrap_or_default();
    let cc = header_of(&mail, "cc")
        .map(|v| parse_addrs(&v))
        .unwrap_or_default();
    let date_ts = header_of(&mail, "date").and_then(|v| dateparse(v.trim()).ok());
    let message_id = header_of(&mail, "message-id").map(|v| {
        v.trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string()
    });

    let text_part = find_body_part(&mail, "text/plain");
    let html_part = find_body_part(&mail, "text/html");
    let text_body = text_part.map(decode_body).unwrap_or_default();
    let html_body = html_part.map(decode_body).unwrap_or_default();

    let attachments = collect_attachments(&mail)
        .into_iter()
        .map(|h| h.meta)
        .collect();

    let raw_headers = mail
        .headers
        .iter()
        .map(|h| RawHeader {
            key: h.get_key().to_string(),
            value: String::from_utf8_lossy(h.get_value_raw()).into_owned(),
        })
        .collect();

    let file_name = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(EmlData {
        path: path.to_string(),
        file_name,
        size_bytes: bytes.len() as u64,
        subject,
        from,
        to,
        cc,
        date_ts,
        message_id,
        raw_headers,
        has_html: html_part.is_some(),
        text_body,
        html_body,
        attachments,
    })
}

// ============================ Tauri 命令 ============================

#[tauri::command]
async fn parse_eml(path: String) -> Result<EmlData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
        parse_into_data(&path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_attachment(src: String, index: usize) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&src).map_err(|e| e.to_string())?;
        let mail = parse_mail(&bytes).map_err(|e| e.to_string())?;
        let atts = collect_attachments(&mail);
        let hit = atts.get(index).ok_or("附件索引越界")?;
        hit.part
            .get_body_raw()
            .map(|b| b.to_vec())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_attachment(src: String, index: usize, dest: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&src).map_err(|e| e.to_string())?;
        let mail = parse_mail(&bytes).map_err(|e| e.to_string())?;
        let atts = collect_attachments(&mail);
        let hit = atts.get(index).ok_or("附件索引越界")?;
        let data = hit
            .part
            .get_body_raw()
            .map_err(|e| e.to_string())?;
        fs::write(&dest, &data).map_err(|e| format!("写入失败: {e}"))?;
        Ok(data.len() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_library(dir: String) -> Result<Vec<EmlSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in WalkDir::new(&dir)
            .follow_links(false)
            .max_depth(10)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let is_eml = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().eq_ignore_ascii_case("eml"))
                .unwrap_or(false);
            if !is_eml {
                continue;
            }
            let path = entry.path().to_string_lossy().into_owned();
            let ok = (|| -> Option<EmlSummary> {
                let bytes = fs::read(entry.path()).ok()?;
                let mail = parse_mail(&bytes).ok()?;
                let subject = header_of(&mail, "subject")
                    .map(|v| clean_header(&v))
                    .unwrap_or_else(|| "(无主题)".to_string());
                let from = header_of(&mail, "from").map(|v| parse_addrs(&v));
                let from = from.and_then(|v| v.into_iter().next());
                let date_ts =
                    header_of(&mail, "date").and_then(|v| dateparse(v.trim()).ok());
                let to = header_of(&mail, "to")
                    .map(|v| parse_addrs(&v))
                    .unwrap_or_default();
                let cc = header_of(&mail, "cc")
                    .map(|v| parse_addrs(&v))
                    .unwrap_or_default();
                let attachment_count = collect_attachments(&mail).len();
                Some(EmlSummary {
                    path,
                    file_name: entry.file_name().to_string_lossy().into_owned(),
                    size_bytes: bytes.len() as u64,
                    subject,
                    from_name: from.as_ref().and_then(|a| a.name.clone()),
                    from_email: from.as_ref().map(|a| a.email.clone()),
                    to,
                    cc,
                    date_ts,
                    attachment_count,
                })
            })();
            if let Some(s) = ok {
                out.push(s);
            }
            if out.len() >= 20000 {
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 解压附件到临时目录并用系统默认程序打开，返回临时文件路径
#[tauri::command]
async fn open_attachment(src: String, index: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&src).map_err(|e| e.to_string())?;
        let mail = parse_mail(&bytes).map_err(|e| e.to_string())?;
        let atts = collect_attachments(&mail);
        let hit = atts.get(index).ok_or("附件索引越界")?;
        let data = hit.part.get_body_raw().map_err(|e| e.to_string())?;

        let invalid: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        let safe: String = hit
            .meta
            .file_name
            .chars()
            .map(|c| if invalid.contains(&c) { '_' } else { c })
            .collect();
        let safe = safe.trim();
        let safe = if safe.is_empty() {
            format!("attachment-{index}")
        } else {
            safe.to_string()
        };

        let dir = std::env::temp_dir().join("EMLManagerAttachments");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&safe);
        fs::write(&dest, &data).map_err(|e| format!("写入临时文件失败: {e}"))?;

        // explorer.exe <file> 会调用系统默认关联程序
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            Command::new("explorer.exe")
                .raw_arg(format!("\"{}\"", dest.to_string_lossy()))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
    from: String,
    to: String,
    error: Option<String>,
}

#[tauri::command]
async fn move_eml_files(paths: Vec<String>, dest_dir: String) -> Result<Vec<MoveResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目录失败: {e}"))?;
        let mut results = Vec::new();
        for p in &paths {
            let src = Path::new(p);
            let name = src
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .ok_or_else(|| "无效路径".to_string())?;
            let mut dest = Path::new(&dest_dir).join(&name);
            // 重名自动追加序号
            let mut n = 1u32;
            while dest.exists() {
                let stem = Path::new(&name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let ext = Path::new(&name)
                    .extension()
                    .map(|s| format!(".{}", s.to_string_lossy()))
                    .unwrap_or_default();
                let new_name = format!("{stem} ({n}){ext}");
                dest = Path::new(&dest_dir).join(new_name);
                n += 1;
            }
            let err = fs::rename(src, &dest).err().map(|e| e.to_string());
            results.push(MoveResult {
                from: p.clone(),
                to: dest.to_string_lossy().into_owned(),
                error: err,
            });
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_eml(path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 清理非法字符
        let invalid: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        let mut name: String = new_name.chars().filter(|c| !invalid.contains(c)).collect();
        name = name.trim().trim_matches('.').to_string();
        if name.is_empty() {
            return Err("文件名不能为空".into());
        }
        if !name.to_lowercase().ends_with(".eml") {
            name.push_str(".eml");
        }
        let src = Path::new(&path);
        let dest = src.with_file_name(&name);
        if dest.exists() {
            return Err("同名文件已存在".into());
        }
        fs::rename(src, &dest).map_err(|e| format!("重命名失败: {e}"))?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_eml_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut errors = Vec::new();
        for p in &paths {
            if let Err(e) = trash::delete(p) {
                errors.push(format!("{}: {e}", Path::new(p).display()));
            }
        }
        Ok(errors)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================ 单元测试 ============================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_utf8_b64_word() {
        assert_eq!(decode_encoded_words("=?utf-8?B?5byg5LiJ?="), "张三");
    }

    #[test]
    fn test_decode_adjacent_words_ignores_whitespace() {
        assert_eq!(
            decode_encoded_words("=?utf-8?B?5L2g5aW9?= =?utf-8?B?77yB?="),
            "你好！"
        );
    }

    #[test]
    fn test_decode_gbk() {
        // "你好" 的 GBK 编码 C4E3BAC3
        assert_eq!(decode_encoded_words("=?gbk?B?xOO6ww==?="), "你好");
    }

    #[test]
    fn test_q_encoding() {
        // "你好_A" 的 UTF-8 Q 编码
        assert_eq!(decode_encoded_words("=?utf-8?Q?=E4=BD=A0=E5=A5=BD_A?="), "你好 A");
    }

    #[test]
    fn test_parse_addrs() {
        let v = parse_addrs("=?utf-8?B?5byg5LiJ?= <zhangsan@example.com>, lisi@example.com");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name.as_deref(), Some("张三"));
        assert_eq!(v[0].email, "zhangsan@example.com");
        assert_eq!(v[1].email, "lisi@example.com");
    }

    #[test]
    fn test_parse_sample_eml() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "\\..\\samples\\样例邮件-01.eml");
        let bytes = std::fs::read(path).expect("样例文件读取失败");
        let data = parse_into_data("样例邮件-01.eml", &bytes).unwrap();
        assert!(data.subject.contains("HTML"));
        let from = data.from.unwrap();
        assert_eq!(from.email, "zhangsan@example.com");
        assert_eq!(from.name.as_deref(), Some("张三"));
        assert_eq!(data.to.len(), 1);
        assert_eq!(data.to[0].name.as_deref(), Some("李四"));
        assert_eq!(data.cc.len(), 1);
        assert!(data.date_ts.is_some());
        assert!(data.has_html);
        assert!(data.html_body.contains("cid:logo001"));
        assert!(data.text_body.contains("纯文本"));
        assert_eq!(data.attachments.len(), 2, "内嵌图片 + PDF 附件");
        assert_eq!(data.attachments[0].file_name, "logo.png");
        assert!(data.attachments[0].inline);
        assert_eq!(data.attachments[0].content_id.as_deref(), Some("logo001"));
        assert_eq!(data.attachments[1].file_name, "测试报告.pdf");
        assert!(!data.attachments[1].inline);
        assert!(data.attachments[1].size_bytes > 0);
        assert!(data.raw_headers.iter().any(|h| h.key == "Message-ID"));
    }

    #[test]
    fn test_rename_sanitize() {
        // 间接验证：非法字符被清理由 rename_eml 完成，这里只测 percent_decode
        assert_eq!(percent_decode("%E6%B5%8B%E8%AF%95 abc"), "测试 abc");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            parse_eml,
            read_attachment,
            export_attachment,
            open_attachment,
            scan_library,
            move_eml_files,
            rename_eml,
            delete_eml_files,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
