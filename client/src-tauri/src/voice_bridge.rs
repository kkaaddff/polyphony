//! 远程语音输入 · 桌面接收端(docs/voice-input.md)。
//!
//! 链路:手机原生语音输入页 →(WS,服务端中继)→ WebView(lib/voiceReceiver.ts)
//!       → 本模块(会话/seq/revision 校验)→ Unix Socket → 输入法插件(Fcitx5,后续接入)。
//!
//! 职责边界:这里只做「校验 + 转发」,不碰任何输入上下文 —— 更新 Preedit / Commit 由输入法插件
//! 在它自己的主事件循环里完成。没有插件连接时照常校验与预览,只是不注入(回执 injected=false)。
//! 日志与错误信息里不出现输入文本。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_STATE: &str = "voice://state";
pub const EVENT_UPSTREAM: &str = "voice://upstream";

// ---------------------------------------------------------------- 诊断日志(只记元数据,不记文本)

/// FNV-1a 32(UTF-8 字节);与手机 VoiceLog.fnv、服务端 inputRelay 同一算法,
/// 同一段文本在各跳的 h= 相同 —— 用来定位文本在哪一跳被截断/改写,而不把文本写进日志。
pub fn fnv(text: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in text.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

pub fn meta(text: &str) -> String {
    format!("bytes={} chars={} h={}", text.len(), text.chars().count(), fnv(text))
}

fn sid(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// stderr(桌面启动时进 journal:`journalctl --user -f | grep polyvoice`)
pub fn trace(msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("[polyvoice {}.{:03}] {msg}", now / 1000, now % 1000);
}

/// 一条事件/消息的元数据摘要(type / 会话前 8 位 / seq / revision / 文本 meta)。
fn describe(v: &Value) -> String {
    let mut out = v.get("type").and_then(Value::as_str).unwrap_or("?").to_string();
    if let Some(id) = v.get("session_id").and_then(Value::as_str) {
        out.push_str(&format!(" sid={}", sid(id)));
    }
    for key in ["seq", "revision"] {
        if let Some(n) = v.get(key).and_then(Value::as_u64) {
            out.push_str(&format!(" {key}={n}"));
        }
    }
    for key in ["status", "reason"] {
        if let Some(t) = v.get(key).and_then(Value::as_str) {
            out.push_str(&format!(" {key}={t}"));
        }
    }
    if let Some(t) = v.get("text").and_then(Value::as_str) {
        out.push_str(&format!(" {}", meta(t)));
    }
    out
}

// ---------------------------------------------------------------- 会话状态机(纯逻辑)

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Incoming {
    #[serde(rename = "session.start")]
    Start { session_id: String, seq: u64 },
    #[serde(rename = "text.snapshot")]
    Snapshot {
        session_id: String,
        seq: u64,
        revision: u64,
        text: String,
    },
    #[serde(rename = "session.finish")]
    Finish {
        session_id: String,
        seq: u64,
        revision: u64,
        text: String,
    },
    #[serde(rename = "session.cancel")]
    Cancel { session_id: String, seq: u64 },
}

#[derive(Debug)]
struct Session {
    id: String,
    last_seq: u64,
    last_revision: u64,
    text: String,
}

/// 一条入站消息的处理结果:发给输入法插件的 IPC 事件 + 回给手机的消息。
#[derive(Debug, Default)]
pub struct Outcome {
    pub ipc: Vec<Value>,
    pub replies: Vec<Value>,
}

/// 同一时刻只有一个活动会话;只接受更高的 seq / 不回退的 revision,旧帧直接丢弃。
#[derive(Debug, Default)]
pub struct SessionManager {
    current: Option<Session>,
    /// 最近一次提交的文本(仅供设置页预览)
    last_committed: Option<String>,
}

fn ack(session_id: &str, seq: u64, injected: bool) -> Value {
    json!({ "v": 1, "type": "ack", "session_id": session_id, "seq": seq, "injected": injected })
}

fn status(session_id: &str, status: &str) -> Value {
    json!({ "v": 1, "type": "session.status", "session_id": session_id, "status": status })
}

impl SessionManager {
    pub fn handle_json(&mut self, raw: &str, ime_connected: bool) -> Outcome {
        match serde_json::from_str::<Incoming>(raw) {
            Ok(msg) => self.handle(msg, ime_connected),
            Err(_) => Outcome::default(), // 未知类型/坏格式:静默丢弃
        }
    }

    fn handle(&mut self, msg: Incoming, ime_connected: bool) -> Outcome {
        let mut out = Outcome::default();
        match msg {
            Incoming::Start { session_id, seq } => {
                if let Some(cur) = self.current.as_mut() {
                    if cur.id == session_id {
                        // 重连后的重复声明:幂等,不清空已有 Preedit
                        cur.last_seq = cur.last_seq.max(seq);
                        out.replies.push(ack(&session_id, seq, ime_connected));
                        return out;
                    }
                    // 新会话顶掉旧会话:旧的未提交内容作废,不能残留在输入框里
                    out.ipc
                        .push(json!({ "type": "session.cancel", "session_id": cur.id }));
                }
                out.ipc
                    .push(json!({ "type": "session.start", "session_id": session_id }));
                out.replies.push(ack(&session_id, seq, ime_connected));
                self.current = Some(Session {
                    id: session_id,
                    last_seq: seq,
                    last_revision: 0,
                    text: String::new(),
                });
            }
            Incoming::Snapshot {
                session_id,
                seq,
                revision,
                text,
            } => {
                let Some(cur) = self.current.as_mut().filter(|c| c.id == session_id) else {
                    out.replies.push(status(&session_id, "unknown_session"));
                    return out;
                };
                if seq <= cur.last_seq || revision < cur.last_revision {
                    return out; // 迟到/重复帧
                }
                cur.last_seq = seq;
                cur.last_revision = revision;
                cur.text = text;
                out.ipc.push(json!({
                    "type": "preedit.update",
                    "session_id": cur.id,
                    "revision": revision,
                    "text": cur.text,
                }));
                out.replies.push(ack(&session_id, seq, ime_connected));
            }
            Incoming::Finish {
                session_id,
                seq,
                revision,
                text,
            } => {
                // 「发送」是用户的显式操作,finish 自带终稿:即使桌面端已丢了这个会话
                // (桌面壳重启 / 会话被顶掉 / 中间帧乱序),也以 finish 为准开一个即时会话提交。
                // 旧行为是回 unknown_session 或静默丢弃,手机上表现为「点发送没反应」(真机实踩)。
                // 是否真的写进输入框仍由插件按焦点判断(目标不在焦点 → rejected/focus_lost,不注入)。
                match self.current.as_ref() {
                    Some(cur) if cur.id == session_id => {
                        if seq <= cur.last_seq {
                            trace(&format!(
                                "finish sid={} seq={seq} <= last_seq={}: committing anyway",
                                sid(&session_id),
                                cur.last_seq
                            ));
                        }
                    }
                    other => {
                        if let Some(old) = other {
                            out.ipc
                                .push(json!({ "type": "session.cancel", "session_id": old.id }));
                        }
                        trace(&format!(
                            "finish sid={} for unknown session: implicit start + commit",
                            sid(&session_id)
                        ));
                        out.ipc
                            .push(json!({ "type": "session.start", "session_id": session_id }));
                    }
                }
                // finish 自带终稿:以它为准提交(末帧快照可能没送达)
                out.ipc.push(json!({
                    "type": "session.commit",
                    "session_id": session_id,
                    "revision": revision,
                    "text": text,
                }));
                out.replies.push(ack(&session_id, seq, ime_connected));
                if !ime_connected {
                    // 有插件时由插件上报真实结果(committed / suspended …)
                    out.replies.push(status(&session_id, "not_injected"));
                }
                self.last_committed = Some(text);
                self.current = None;
            }
            Incoming::Cancel { session_id, seq } => {
                if self.current.as_ref().is_some_and(|c| c.id == session_id) {
                    out.ipc
                        .push(json!({ "type": "session.cancel", "session_id": session_id }));
                    out.replies.push(ack(&session_id, seq, ime_connected));
                    out.replies.push(status(&session_id, "cancelled"));
                    self.current = None;
                }
            }
        }
        out
    }

    /// 关闭接收 / 新插件连接时用:当前会话的恢复事件(无会话则空)。
    pub fn resume_events(&self) -> Vec<Value> {
        match &self.current {
            Some(cur) => vec![
                json!({ "type": "session.start", "session_id": cur.id }),
                json!({
                    "type": "preedit.update",
                    "session_id": cur.id,
                    "revision": cur.last_revision,
                    "text": cur.text,
                }),
            ],
            None => vec![],
        }
    }

    /// 放弃当前会话(关闭接收时);返回要发给插件的取消事件。
    pub fn abort(&mut self) -> Vec<Value> {
        match self.current.take() {
            Some(cur) => vec![json!({ "type": "session.cancel", "session_id": cur.id })],
            None => vec![],
        }
    }
}

/// 输入法插件上行消息 → 回给手机的 session.status(白名单重建;非法返回 None)。
/// 插件侧协议:`{"type":"status","session_id":"…","status":"committed|suspended|resumed|cancelled|rejected","reason":"focus_lost|user_interference|…"}`
pub fn upstream_to_reply(raw: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(raw).ok()?;
    if v.get("type")?.as_str()? != "status" {
        return None;
    }
    let session_id = v.get("session_id")?.as_str()?;
    let st = v.get("status")?.as_str()?;
    if session_id.is_empty()
        || session_id.len() > 64
        || !matches!(st, "committed" | "suspended" | "resumed" | "cancelled" | "rejected")
    {
        return None;
    }
    let mut reply = status(session_id, st);
    if let Some(reason) = v.get("reason").and_then(Value::as_str) {
        let ok = !reason.is_empty()
            && reason.len() <= 32
            && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if ok {
            reply["reason"] = Value::String(reason.to_string());
        }
    }
    Some(reply)
}

// ---------------------------------------------------------------- Unix Socket IPC

/// NDJSON over Unix Domain Socket。本进程是服务端,输入法插件是客户端(可多连,通常一个)。
#[cfg(unix)]
pub mod ipc {
    use serde_json::Value;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// 插件上行单行上限:状态消息很短,超出视为异常客户端直接断开
    const MAX_UPSTREAM_LINE: u64 = 4096;

    pub trait Events: Send + Sync + 'static {
        /// 新客户端接入时先发给它的事件(当前会话恢复)。
        fn greeting(&self) -> Vec<Value>;
        /// 客户端发来的一行(未解析)。
        fn upstream(&self, line: &str);
        /// 客户端数量变化。
        fn clients_changed(&self, count: usize);
    }

    type Clients = Arc<Mutex<Vec<(u64, UnixStream)>>>;

    pub struct Server {
        path: PathBuf,
        clients: Clients,
        stop: Arc<AtomicBool>,
    }

    fn write_line(stream: &mut UnixStream, v: &Value) -> std::io::Result<()> {
        let mut line = v.to_string();
        line.push('\n');
        stream.write_all(line.as_bytes())
    }

    impl Server {
        pub fn start(path: &Path, events: Arc<dyn Events>) -> std::io::Result<Server> {
            if path.exists() {
                // 残留文件:连得上说明另一个实例在用,连不上才是上次异常退出留下的
                if UnixStream::connect(path).is_ok() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        "voice bridge socket is in use by another instance",
                    ));
                }
                std::fs::remove_file(path)?;
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let listener = UnixListener::bind(path)?;
            // 仅本用户可连:同机其他用户不能向输入法注入文字
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;

            let clients: Clients = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let next_id = AtomicU64::new(1);

            let (c, s) = (clients.clone(), stop.clone());
            std::thread::Builder::new()
                .name("voice-ipc-accept".into())
                .spawn(move || {
                    while !s.load(Ordering::Relaxed) {
                        match listener.accept() {
                            Ok((stream, _)) => {
                                let id = next_id.fetch_add(1, Ordering::Relaxed);
                                Self::serve(id, stream, c.clone(), events.clone());
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(150));
                            }
                            Err(_) => std::thread::sleep(Duration::from_millis(500)),
                        }
                    }
                })?;

            Ok(Server {
                path: path.to_path_buf(),
                clients,
                stop,
            })
        }

        fn serve(id: u64, mut stream: UnixStream, clients: Clients, events: Arc<dyn Events>) {
            // 卡死的插件不能拖住应用:写超时后该客户端被剔除
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
            let Ok(reader) = stream.try_clone() else { return };

            let mut hello = vec![serde_json::json!({ "type": "hello", "version": 1 })];
            hello.extend(events.greeting());
            for ev in &hello {
                if write_line(&mut stream, ev).is_err() {
                    return;
                }
            }
            let count = {
                let mut list = clients.lock().unwrap();
                list.push((id, stream));
                list.len()
            };
            events.clients_changed(count);

            let _ = std::thread::Builder::new()
                .name("voice-ipc-client".into())
                .spawn(move || {
                    let mut reader = BufReader::new(reader);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        let mut limited = (&mut reader).take(MAX_UPSTREAM_LINE);
                        match limited.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) if !line.ends_with('\n') => break, // 超长行
                            Ok(_) => events.upstream(line.trim_end()),
                        }
                    }
                    let count = {
                        let mut list = clients.lock().unwrap();
                        list.retain(|(cid, _)| *cid != id);
                        list.len()
                    };
                    events.clients_changed(count);
                });
        }

        pub fn client_count(&self) -> usize {
            self.clients.lock().unwrap().len()
        }

        /// 广播给全部插件客户端;返回成功送达的客户端数。写失败的客户端被断开。
        pub fn broadcast(&self, events: &[Value]) -> usize {
            if events.is_empty() {
                return self.client_count();
            }
            let mut list = self.clients.lock().unwrap();
            let mut delivered = 0;
            for (_, stream) in list.iter_mut() {
                if events.iter().all(|ev| write_line(stream, ev).is_ok()) {
                    delivered += 1;
                } else {
                    // 关掉连接:读线程随即退出并把它从列表里摘除
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
            delivered
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            for (_, stream) in self.clients.lock().unwrap().iter() {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

// ---------------------------------------------------------------- Tauri 接线

#[derive(Default)]
struct Inner {
    enabled: bool,
    manager: SessionManager,
    #[cfg(unix)]
    server: Option<ipc::Server>,
}

impl Inner {
    fn ime_clients(&self) -> usize {
        #[cfg(unix)]
        {
            self.server.as_ref().map_or(0, |s| s.client_count())
        }
        #[cfg(not(unix))]
        {
            0
        }
    }

    fn broadcast(&self, events: &[Value]) -> usize {
        #[cfg(unix)]
        if let Some(server) = &self.server {
            return server.broadcast(events);
        }
        let _ = events;
        0
    }

    fn snapshot(&self) -> BridgeState {
        BridgeState {
            enabled: self.enabled,
            ipc_supported: cfg!(unix),
            socket_path: {
                #[cfg(unix)]
                {
                    self.server
                        .as_ref()
                        .map(|s| s.path().to_string_lossy().into_owned())
                }
                #[cfg(not(unix))]
                {
                    None
                }
            },
            ime_clients: self.ime_clients(),
            ime_setup: if self.ime_clients() > 0 {
                "ready"
            } else {
                crate::ime_setup::status()
            },
            active: self.manager.current.is_some(),
            text: self
                .manager
                .current
                .as_ref()
                .map(|c| c.text.clone())
                .unwrap_or_default(),
            last_committed: self.manager.last_committed.clone(),
        }
    }
}

#[derive(Default)]
pub struct VoiceBridge(Mutex<Inner>);

/// 设置页展示用状态(只发给本机 WebView)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    enabled: bool,
    ipc_supported: bool,
    socket_path: Option<String>,
    ime_clients: usize,
    /// 输入法插件就绪状态(见 ime_setup.rs);插件已连上时不再扫描,恒为 "ready"
    ime_setup: &'static str,
    active: bool,
    text: String,
    last_committed: Option<String>,
}

fn emit_state(app: &AppHandle) {
    let state = app.state::<VoiceBridge>().0.lock().unwrap().snapshot();
    let _ = app.emit(EVENT_STATE, state);
}

/// Socket 路径:Linux 取 `$XDG_RUNTIME_DIR/polyphony-voice.sock`(0700 的每用户目录,输入法插件按同一规则找);
/// 没有该变量的平台(macOS 开发调试)回落应用缓存目录。
#[cfg(unix)]
fn socket_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    const NAME: &str = "polyphony-voice.sock";
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return Ok(std::path::PathBuf::from(dir).join(NAME));
    }
    app.path()
        .app_cache_dir()
        .map(|d| d.join(NAME))
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
struct IpcEvents(AppHandle);

#[cfg(unix)]
impl ipc::Events for IpcEvents {
    fn greeting(&self) -> Vec<Value> {
        self.0
            .state::<VoiceBridge>()
            .0
            .lock()
            .unwrap()
            .manager
            .resume_events()
    }

    fn upstream(&self, line: &str) {
        match upstream_to_reply(line) {
            Some(reply) => {
                trace(&format!("plugin -> {}", describe(&reply)));
                let _ = self.0.emit(EVENT_UPSTREAM, reply.to_string());
            }
            None => trace(&format!("plugin -> dropped invalid line bytes={}", line.len())),
        }
    }

    fn clients_changed(&self, count: usize) {
        trace(&format!("ime plugin clients={count}"));
        emit_state(&self.0);
    }
}

/// 开/关接收。开:起 Unix Socket 等输入法插件来连;关:作废当前会话并撤掉 Socket。
#[tauri::command]
pub fn voice_bridge_set_enabled(app: AppHandle, enabled: bool) -> Result<BridgeState, String> {
    let bridge = app.state::<VoiceBridge>();
    let state = {
        let mut inner = bridge.0.lock().unwrap();
        if enabled && !inner.enabled {
            #[cfg(unix)]
            {
                let path = socket_path(&app)?;
                let server = ipc::Server::start(&path, std::sync::Arc::new(IpcEvents(app.clone())))
                    .map_err(|e| e.to_string())?;
                inner.server = Some(server);
            }
            inner.enabled = true;
            trace("receiver enabled");
        } else if !enabled && inner.enabled {
            trace("receiver disabled");
            let cancel = inner.manager.abort();
            inner.broadcast(&cancel);
            #[cfg(unix)]
            {
                inner.server = None;
            }
            inner.enabled = false;
        }
        inner.snapshot()
    };
    let _ = app.emit(EVENT_STATE, state.clone());
    Ok(state)
}

/// 重启系统输入法(fcitx5),让它加载刚随安装包装上 / 升级的插件。插件连上后经 clients_changed 推送新状态。
#[tauri::command]
pub fn voice_bridge_restart_ime() -> Result<(), String> {
    trace("restart fcitx5 to load the plugin");
    crate::ime_setup::restart()
}

/// WebView 侧(输入通道 WS 连接/断开等)的诊断行,统一进同一条 stderr 日志。
#[tauri::command]
pub fn voice_bridge_trace(line: String) {
    let line: String = line.chars().take(300).collect();
    trace(&format!("webview {line}"));
}

#[tauri::command]
pub fn voice_bridge_status(app: AppHandle) -> BridgeState {
    app.state::<VoiceBridge>().0.lock().unwrap().snapshot()
}

/// WebView 把输入通道收到的每条消息原样交进来;返回要回给手机的消息(JSON 字符串)。
#[tauri::command]
pub fn voice_bridge_message(app: AppHandle, json: String) -> Vec<String> {
    let bridge = app.state::<VoiceBridge>();
    let (replies, state) = {
        let mut inner = bridge.0.lock().unwrap();
        if !inner.enabled {
            return vec![];
        }
        let ime_connected = inner.ime_clients() > 0;
        let incoming = serde_json::from_str::<Value>(&json)
            .map(|v| describe(&v))
            .unwrap_or_else(|_| format!("unparsable bytes={}", json.len()));
        let outcome = inner.manager.handle_json(&json, ime_connected);
        let delivered = inner.broadcast(&outcome.ipc);
        trace(&format!(
            "in {incoming} | ime_clients={} delivered={delivered} ipc=[{}] replies=[{}]",
            inner.ime_clients(),
            outcome.ipc.iter().map(describe).collect::<Vec<_>>().join("; "),
            outcome.replies.iter().map(describe).collect::<Vec<_>>().join("; ")
        ));
        (outcome.replies, inner.snapshot())
    };
    let _ = app.emit(EVENT_STATE, state);
    replies.iter().map(Value::to_string).collect()
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn start(id: &str, seq: u64) -> String {
        json!({ "type": "session.start", "session_id": id, "seq": seq }).to_string()
    }
    fn snap(id: &str, seq: u64, rev: u64, text: &str) -> String {
        json!({
            "v": 1, "type": "text.snapshot", "session_id": id, "seq": seq, "revision": rev,
            "text": text, "selection_start": 0, "selection_end": 0,
            "composing_start": null, "composing_end": null,
            "from": { "device_id": "d", "label": "App · Android" }
        })
        .to_string()
    }
    fn finish(id: &str, seq: u64, rev: u64, text: &str) -> String {
        json!({ "type": "session.finish", "session_id": id, "seq": seq, "revision": rev, "text": text })
            .to_string()
    }
    fn types(values: &[Value]) -> Vec<&str> {
        values.iter().map(|v| v["type"].as_str().unwrap()).collect()
    }

    #[test]
    fn rewrite_replaces_preedit_then_commit_uses_final_text() {
        let mut m = SessionManager::default();
        assert_eq!(types(&m.handle_json(&start("s1", 0), true).ipc), ["session.start"]);

        let o = m.handle_json(&snap("s1", 1, 1, "帮我创建一个明天下午三点开会的认物"), true);
        assert_eq!(types(&o.ipc), ["preedit.update"]);
        assert_eq!(o.replies[0]["injected"], true);

        // 识别修正:整体替换,不追加
        let o = m.handle_json(&snap("s1", 2, 2, "帮我创建一个明天下午三点开会的任务"), true);
        assert_eq!(o.ipc[0]["text"], "帮我创建一个明天下午三点开会的任务");

        // 末帧快照没到也无妨:finish 自带终稿
        let o = m.handle_json(&finish("s1", 9, 5, "帮我创建一个明天下午三点开会的任务。"), true);
        assert_eq!(types(&o.ipc), ["session.commit"]);
        assert_eq!(o.ipc[0]["text"], "帮我创建一个明天下午三点开会的任务。");
        assert_eq!(types(&o.replies), ["ack"]);
        assert!(m.current.is_none());
    }

    #[test]
    fn stale_and_duplicate_frames_are_dropped() {
        let mut m = SessionManager::default();
        m.handle_json(&start("s1", 0), true);
        m.handle_json(&snap("s1", 5, 5, "新"), true);

        let o = m.handle_json(&snap("s1", 3, 3, "旧"), true);
        assert!(o.ipc.is_empty() && o.replies.is_empty());
        let o = m.handle_json(&snap("s1", 5, 5, "新"), true);
        assert!(o.ipc.is_empty());
        // seq 更高但 revision 回退:同样丢弃
        let o = m.handle_json(&snap("s1", 6, 4, "旧"), true);
        assert!(o.ipc.is_empty());
        assert_eq!(m.current.as_ref().unwrap().text, "新");
    }

    #[test]
    fn unknown_session_snapshot_is_rejected_but_finish_still_commits() {
        let mut m = SessionManager::default();
        // 中间快照:未声明的会话不显示
        let o = m.handle_json(&snap("ghost", 1, 1, "桌面重启前的旧会话"), true);
        assert!(o.ipc.is_empty());
        assert_eq!(o.replies[0]["status"], "unknown_session");
        // 「发送」是显式操作且自带终稿:即时开会话并提交(插件再按焦点决定是否真的写入)
        let o = m.handle_json(&finish("ghost", 2, 2, "终稿"), true);
        assert_eq!(types(&o.ipc), ["session.start", "session.commit"]);
        assert_eq!(o.ipc[1]["text"], "终稿");
        assert!(m.current.is_none());
    }

    #[test]
    fn finish_replaces_other_active_session_and_ignores_stale_seq() {
        let mut m = SessionManager::default();
        m.handle_json(&start("s1", 0), true);
        m.handle_json(&snap("s1", 1, 1, "残缺"), true);
        // 另一个会话的 finish:旧会话先取消再提交终稿
        let o = m.handle_json(&finish("s2", 1, 1, "完整终稿"), true);
        assert_eq!(types(&o.ipc), ["session.cancel", "session.start", "session.commit"]);
        assert_eq!(o.ipc[0]["session_id"], "s1");

        // 同一会话但 seq 不比已收到的大(乱序到达):仍以终稿提交,不丢
        m.handle_json(&start("s3", 0), true);
        m.handle_json(&snap("s3", 5, 5, "半句"), true);
        let o = m.handle_json(&finish("s3", 5, 6, "整句话"), true);
        assert_eq!(types(&o.ipc), ["session.commit"]);
        assert_eq!(o.ipc[0]["text"], "整句话");
    }

    #[test]
    fn fnv_matches_reference_vectors() {
        // 与 Kotlin VoiceLog.fnv / JS / C++ 同一算法(FNV-1a 32 over UTF-8)
        assert_eq!(fnv(""), "811c9dc5");
        assert_eq!(fnv("a"), "e40c292c");
        assert_eq!(meta("你好"), format!("bytes=6 chars=2 h={}", fnv("你好")));
    }

    #[test]
    fn restart_of_same_session_is_idempotent_and_new_session_cancels_old() {
        let mut m = SessionManager::default();
        m.handle_json(&start("s1", 0), true);
        m.handle_json(&snap("s1", 1, 1, "你好"), true);

        // 重连重发 start:不清空
        let o = m.handle_json(&start("s1", 2), true);
        assert!(o.ipc.is_empty());
        assert_eq!(m.current.as_ref().unwrap().text, "你好");
        assert_eq!(types(&m.resume_events()), ["session.start", "preedit.update"]);

        let o = m.handle_json(&start("s2", 0), true);
        assert_eq!(types(&o.ipc), ["session.cancel", "session.start"]);
        assert_eq!(o.ipc[0]["session_id"], "s1");
    }

    #[test]
    fn cancel_clears_and_no_plugin_reports_not_injected() {
        let mut m = SessionManager::default();
        m.handle_json(&start("s1", 0), false);
        let o = m.handle_json(&snap("s1", 1, 1, "a"), false);
        assert_eq!(o.replies[0]["injected"], false);

        let o = m.handle_json(
            &json!({ "type": "session.cancel", "session_id": "s1", "seq": 2 }).to_string(),
            false,
        );
        assert_eq!(types(&o.ipc), ["session.cancel"]);
        assert_eq!(o.replies[1]["status"], "cancelled");

        m.handle_json(&start("s2", 0), false);
        let o = m.handle_json(&finish("s2", 1, 1, "终稿"), false);
        assert_eq!(o.replies[1]["status"], "not_injected");

        // 垃圾输入不 panic、不产生任何动作
        let o = m.handle_json("{not json", false);
        assert!(o.ipc.is_empty() && o.replies.is_empty());
        let o = m.handle_json(r#"{"type":"ack","session_id":"s","seq":1}"#, false);
        assert!(o.ipc.is_empty() && o.replies.is_empty());
    }

    #[test]
    fn upstream_status_is_whitelisted() {
        let ok = upstream_to_reply(
            r#"{"type":"status","session_id":"s1","status":"suspended","reason":"focus_lost","text":"x"}"#,
        )
        .unwrap();
        assert_eq!(ok["type"], "session.status");
        assert_eq!(ok["reason"], "focus_lost");
        assert!(ok.get("text").is_none());

        assert!(upstream_to_reply(r#"{"type":"status","session_id":"s1","status":"pwned"}"#).is_none());
        assert!(upstream_to_reply(r#"{"type":"preedit.update","session_id":"s1"}"#).is_none());
        assert!(upstream_to_reply("garbage").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn ipc_roundtrip_over_unix_socket() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;

        struct Probe {
            upstream: Mutex<mpsc::Sender<String>>,
            counts: Mutex<mpsc::Sender<usize>>,
        }
        impl ipc::Events for Probe {
            fn greeting(&self) -> Vec<Value> {
                vec![json!({ "type": "session.start", "session_id": "resumed" })]
            }
            fn upstream(&self, line: &str) {
                let _ = self.upstream.lock().unwrap().send(line.to_string());
            }
            fn clients_changed(&self, count: usize) {
                let _ = self.counts.lock().unwrap().send(count);
            }
        }

        let dir = std::env::temp_dir().join(format!("pv-{}", std::process::id()));
        let path = dir.join("t.sock");
        let (up_tx, up_rx) = mpsc::channel();
        let (cnt_tx, cnt_rx) = mpsc::channel();
        let server = ipc::Server::start(
            &path,
            Arc::new(Probe {
                upstream: Mutex::new(up_tx),
                counts: Mutex::new(cnt_tx),
            }),
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // 同一路径不能被第二个实例抢占
        assert!(ipc::Server::start(&path, Arc::new(Probe {
            upstream: Mutex::new(mpsc::channel().0),
            counts: Mutex::new(mpsc::channel().0),
        }))
        .is_err());

        let wait = Duration::from_secs(3);
        let mut client = UnixStream::connect(&path).unwrap();
        client.set_read_timeout(Some(wait)).unwrap();
        let mut lines = BufReader::new(client.try_clone().unwrap()).lines();
        assert_eq!(cnt_rx.recv_timeout(wait).unwrap(), 1);

        let hello: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        assert_eq!(hello["type"], "hello");
        let resumed: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        assert_eq!(resumed["session_id"], "resumed");

        let delivered = server.broadcast(&[json!({ "type": "preedit.update", "text": "你好\n世界" })]);
        assert_eq!(delivered, 1);
        let ev: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        assert_eq!(ev["text"], "你好\n世界"); // 换行在 JSON 里转义,不破坏按行分帧

        client
            .write_all(b"{\"type\":\"status\",\"session_id\":\"s1\",\"status\":\"committed\"}\n")
            .unwrap();
        let line = up_rx.recv_timeout(wait).unwrap();
        assert_eq!(upstream_to_reply(&line).unwrap()["status"], "committed");

        drop(lines);
        drop(client);
        assert_eq!(cnt_rx.recv_timeout(wait).unwrap(), 0);

        drop(server);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
