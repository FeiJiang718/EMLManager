import { invoke } from "@tauri-apps/api/core";
import { open as dlgOpen, save as dlgSave } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ============================ 状态 ============================
const state = {
  libPath: localStorage.getItem("eml.libPath") || "",
  summaries: [], // {path,fileName,sizeBytes,subject,fromName,fromEmail,to,cc,dateTs,attachmentCount}
  filtered: [],
  filter: "all", // all | inbox | sent | atts
  query: "",
  sort: "date-desc",
  selectedPath: null,
  cache: new Map(), // path -> EmlData
  viewMode: "html",
  busy: false,
  myAddr: localStorage.getItem("eml.myAddr") || "", // 我的邮箱地址（区分收/发件）
  theme: localStorage.getItem("eml.theme") === "light" ? "light" : "dark", // 全局主题（正文显示跟随）
  contact: null, // {email,name} 联系人筛选
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $("mailList"), listEmpty: $("listEmpty"), listLoading: $("listLoading"),
  libPath: $("libPath"), libStats: $("libStats"),
  cntAll: $("cntAll"), cntAtts: $("cntAtts"),
  cntInbox: $("cntInbox"), cntSent: $("cntSent"),
  myAddrText: $("myAddrText"), btnSetMyAddr: $("btnSetMyAddr"),
  contactList: $("contactList"), contactBanner: $("contactBanner"),
  contactName: $("contactName"), contactClear: $("contactClear"),
  btnTheme: $("btnTheme"),
  search: $("searchBox"), sort: $("sortSel"),
  reader: $("reader"), readerEmpty: $("readerEmpty"), readerLoading: $("readerLoading"),
  rdSubject: $("rdSubject"), rdFrom: $("rdFrom"), rdTo: $("rdTo"), rdCc: $("rdCc"),
  rdCcRow: document.querySelector(".rd-cc"), rdDate: $("rdDate"),
  viewSeg: $("viewSeg"), frame: $("bodyFrame"), bodyText: $("bodyText"), bodyWrap: $("bodyWrap"),
  attsBar: $("attsBar"), attsList: $("attsList"), attsCount: $("attsCount"),
  modalMask: $("modalMask"), modal: $("modal"), modalTitle: $("modalTitle"),
  modalBody: $("modalBody"), modalOk: $("modalOk"), modalCancel: $("modalCancel"),
  toasts: $("toasts"),
};

// ============================ 工具 ============================
function esc(s) { return String(s ?? ""); }
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDateFull(ts) {
  if (!ts) return "未知时间";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function toast(msg, type = "info", ms = 2600) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, ms);
}
const AV_COLORS = ["#7c6cff", "#0ea5e9", "#10b981", "#f59e0b", "#f4567a", "#8b5cf6", "#14b8a6", "#ec4899"];
function avColor(s) {
  let h = 0;
  for (const c of s || "?") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function fromLabel(s) {
  return s?.fromName || s?.fromEmail || "(未知发件人)";
}
// 我的邮箱地址匹配（不区分大小写、精确匹配）
const norm = (e) => (e || "").trim().toLowerCase();
function isInbox(s) {
  if (!state.myAddr) return false;
  const me = norm(state.myAddr);
  return [...(s.to || []), ...(s.cc || [])].some((a) => norm(a.email) === me);
}
function isSent(s) {
  if (!state.myAddr) return false;
  return norm(s.fromEmail) === norm(state.myAddr);
}
function extractPath(p) {
  // dialog 可能返回数组
  if (Array.isArray(p)) return p[0] || null;
  return p || null;
}

// ============================ 模态 ============================
function closeModal() {
  els.modalMask.classList.add("hidden");
  els.modalBody.innerHTML = "";
}
function openModal({ title, okText = "确定", danger = false, onOk }) {
  els.modalTitle.textContent = title;
  els.modalOk.textContent = okText;
  els.modal.classList.toggle("ok", danger);
  els.modalOk.classList.toggle("danger-hide", false);
  els.modalMask.classList.remove("hidden");
  els.modalOk.onclick = async () => {
    const keep = await onOk?.();
    if (!keep) closeModal();
  };
  els.modalCancel.onclick = closeModal;
  els.modalMask.onclick = (e) => { if (e.target === els.modalMask) closeModal(); };
}
function confirmDialog(title, msg, okText = "删除") {
  return new Promise((resolve) => {
    openModal({
      title, okText, danger: true,
      onOk: () => { resolve(true); },
    });
    els.modalBody.textContent = msg;
    const prev = els.modalCancel.onclick;
    els.modalCancel.onclick = () => { closeModal(); resolve(false); prev?.(); };
    els.modalMask.onclick = (e) => {
      if (e.target === els.modalMask) { closeModal(); resolve(false); }
    };
  });
}
function promptDialog(title, defaultValue) {
  return new Promise((resolve) => {
    openModal({
      title, okText: "保存",
      onOk: () => { resolve(input.value.trim()); },
    });
    els.modalBody.innerHTML = "";
    const input = document.createElement("input");
    input.value = defaultValue;
    input.spellcheck = false;
    els.modalBody.appendChild(input);
    setTimeout(() => { input.focus(); input.select(); }, 30);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { resolve(input.value.trim()); closeModal(); }
    });
    const prevCancel = els.modalCancel.onclick, prevMask = els.modalMask.onclick;
    els.modalCancel.onclick = () => { closeModal(); resolve(null); prevCancel?.(); };
    els.modalMask.onclick = (e) => { if (e.target === els.modalMask) { closeModal(); resolve(null); prevMask?.(e); } };
  });
}

// ============================ 数据流 ============================
async function rescan({ keepSelection = true } = {}) {
  if (!state.libPath) return;
  els.listLoading.classList.remove("hidden");
  els.listEmpty.classList.add("hidden");
  try {
    state.summaries = await invoke("scan_library", { dir: state.libPath });
    if (!keepSelection || !state.summaries.some((s) => s.path === state.selectedPath)) {
      state.selectedPath = null;
      showReaderEmpty();
    }
  } catch (e) {
    toast(`扫描失败：${e}`, "err");
  } finally {
    els.listLoading.classList.add("hidden");
    applyFilter();
  }
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  let arr = state.summaries;
  if (state.filter === "atts") arr = arr.filter((s) => s.attachmentCount > 0);
  else if (state.filter === "inbox") arr = state.myAddr ? arr.filter(isInbox) : [];
  else if (state.filter === "sent") arr = state.myAddr ? arr.filter(isSent) : [];
  if (state.contact) {
    const ce = norm(state.contact.email);
    arr = arr.filter((s) =>
      norm(s.fromEmail) === ce ||
      (s.to || []).some((a) => norm(a.email) === ce) ||
      (s.cc || []).some((a) => norm(a.email) === ce));
  }
  if (q) {
    const inAddrs = (a) =>
      (a.name || "").toLowerCase().includes(q) ||
      (a.email || "").toLowerCase().includes(q);
    arr = arr.filter((s) =>
      s.subject.toLowerCase().includes(q) ||
      (s.fromName || "").toLowerCase().includes(q) ||
      (s.fromEmail || "").toLowerCase().includes(q) ||
      s.fileName.toLowerCase().includes(q) ||
      (s.to || []).some(inAddrs) ||
      (s.cc || []).some(inAddrs));
  }
  const by = state.sort;
  arr = [...arr].sort((a, b) => {
    switch (by) {
      case "date-asc": return (a.dateTs ?? 0) - (b.dateTs ?? 0);
      case "subject": return a.subject.localeCompare(b.subject, "zh-Hans-CN");
      case "from": return fromLabel(a).localeCompare(fromLabel(b), "zh-Hans-CN");
      case "size-desc": return b.sizeBytes - a.sizeBytes;
      default: return (b.dateTs ?? 0) - (a.dateTs ?? 0);
    }
  });
  state.filtered = arr;
  renderList();
  renderContacts();
  els.cntAll.textContent = state.summaries.length;
  els.cntAtts.textContent = state.summaries.filter((s) => s.attachmentCount > 0).length;
  els.cntInbox.textContent = state.myAddr ? state.summaries.filter(isInbox).length : "—";
  els.cntSent.textContent = state.myAddr ? state.summaries.filter(isSent).length : "—";
  const total = state.summaries.reduce((n, s) => n + s.sizeBytes, 0);
  els.libStats.innerHTML = state.libPath
    ? `<span><b>${state.summaries.length}</b> 封</span><span><b>${fmtSize(total)}</b></span>`
    : "";
}

// ============================ 联系人 ============================
function collectContacts() {
  const map = new Map(); // email(小写) -> {email,name,count}
  const add = (name, email) => {
    const key = norm(email);
    if (!key || !key.includes("@")) return;
    let c = map.get(key);
    if (!c) { c = { email: email.trim(), name: "", count: 0 }; map.set(key, c); }
    if (!c.name && name && name !== email) c.name = name;
    c.count++;
  };
  for (const s of state.summaries) {
    add(s.fromName, s.fromEmail);
    (s.to || []).forEach((a) => add(a.name, a.email));
    (s.cc || []).forEach((a) => add(a.name, a.email));
  }
  return [...map.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function renderContacts() {
  const contacts = collectContacts();
  els.contactList.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of contacts.slice(0, 50)) {
    const btn = document.createElement("button");
    btn.className = "contact-item" +
      (state.contact && norm(state.contact.email) === norm(c.email) ? " active" : "");
    btn.title = `${c.name ? c.name + "\n" : ""}${c.email} · ${c.count} 封往来`;
    const av = document.createElement("span");
    av.className = "avatar";
    av.style.background = avColor(c.email);
    av.textContent = (c.name || c.email)[0].toUpperCase();
    const name = document.createElement("span");
    name.className = "ci-name";
    name.textContent = c.name || c.email;
    const n = document.createElement("span");
    n.className = "ci-count";
    n.textContent = c.count;
    btn.append(av, name, n);
    btn.addEventListener("click", () => setContact(c));
    frag.appendChild(btn);
  }
  if (!contacts.length) {
    const empty = document.createElement("div");
    empty.className = "contact-empty";
    empty.textContent = "打开邮件后\n自动汇总联系人";
    frag.appendChild(empty);
  }
  els.contactList.appendChild(frag);
}

function setContact(c) {
  state.contact = state.contact && norm(state.contact.email) === norm(c.email) ? null : c;
  updateContactBanner();
  applyFilter();
}

function updateContactBanner() {
  const c = state.contact;
  els.contactBanner.classList.toggle("hidden", !c);
  if (c) els.contactName.textContent = `${c.name || c.email}`;
}

function renderList() {
  els.list.innerHTML = "";
  els.listEmpty.classList.toggle("hidden", state.filtered.length > 0);
  const frag = document.createDocumentFragment();
  for (const s of state.filtered) {
    const li = document.createElement("li");
    li.className = "mail-item" + (s.path === state.selectedPath ? " selected" : "");
    li.dataset.path = s.path;

    const av = document.createElement("div");
    av.className = "avatar";
    const label = fromLabel(s);
    av.style.background = avColor(s.fromEmail || label);
    av.textContent = (label[0] || "?").toUpperCase();

    const main = document.createElement("div");
    main.className = "mi-main";

    const top = document.createElement("div");
    top.className = "mi-top";
    const f = document.createElement("span");
    f.className = "mi-from";
    f.textContent = label;
    f.title = s.fromEmail ? `${s.fromName || ""} <${s.fromEmail}>` : label;
    const d = document.createElement("span");
    d.className = "mi-date";
    d.textContent = fmtDate(s.dateTs);
    top.append(f, d);

    const bot = document.createElement("div");
    bot.className = "mi-bottom";
    const sub = document.createElement("span");
    sub.className = "mi-subject";
    sub.textContent = s.subject;
    sub.title = s.subject;
    bot.append(sub);
    if (s.attachmentCount > 0) {
      const clip = document.createElement("span");
      clip.className = "mi-clip";
      clip.title = `${s.attachmentCount} 个附件`;
      clip.innerHTML = `<svg viewBox="0 0 16 16"><path d="M12 7l-4.3 4.3a2.5 2.5 0 0 1-3.5-3.5L9 3a1.7 1.7 0 0 1 2.4 2.4L6.7 10a.9.9 0 0 1-1.3-1.3L9.5 4.6"/></svg>`;
      bot.append(clip);
    }
    main.append(top, bot);
    li.append(av, main);
    li.addEventListener("click", () => selectItem(s.path));
    frag.appendChild(li);
  }
  els.list.appendChild(frag);
}

async function selectItem(path) {
  if (state.busy) return;
  state.selectedPath = path;
  // 仅更新选中样式，避免整表重绘造成闪烁
  els.list.querySelectorAll(".mail-item.selected").forEach((el) =>
    el.classList.toggle("selected", el.dataset.path === path));
  state.cache.delete(path); // 重新解析，保证与磁盘一致
  await renderReader(path);
}

async function renderReader(path) {
  els.readerEmpty.classList.add("hidden");
  // 仅首次打开（当前无内容）时显示加载动画；切换邮件时原地刷新，避免右侧闪烁
  const firstOpen = els.reader.classList.contains("hidden") &&
    els.readerLoading.classList.contains("hidden");
  if (firstOpen) els.readerLoading.classList.remove("hidden");
  let data;
  try {
    data = state.cache.get(path) ?? (await invoke("parse_eml", { path }));
  } catch (e) {
    els.readerLoading.classList.add("hidden");
    showReaderEmpty();
    toast(`解析失败：${e}`, "err");
    return;
  }
  els.readerLoading.classList.add("hidden");
  state.cache.set(path, data);

  els.reader.classList.remove("hidden");
  els.rdSubject.textContent = data.subject || "(无主题)";
  const fr = data.from;
  els.rdFrom.innerHTML = "";
  if (fr) {
    const b = document.createElement("b");
    b.textContent = fr.name || fr.email;
    b.classList.add("addr-link");
    b.title = "点击查看往来邮件";
    b.addEventListener("click", () => setContact({ email: fr.email, name: fr.name || "" }));
    els.rdFrom.append(b);
    if (fr.name && fr.email) {
      const a = document.createElement("span");
      a.className = "addr addr-link";
      a.textContent = `<${fr.email}>`;
      a.title = "点击查看往来邮件";
      a.addEventListener("click", () => setContact({ email: fr.email, name: fr.name || "" }));
      els.rdFrom.append(a);
    }
  } else els.rdFrom.textContent = "(未知)";

  // 可点击地址：弹出联系人往来视图
  const addrChip = (a) => {
    const chip = document.createElement("span");
    chip.className = a.name && a.email ? "addr addr-link" : "addr-link";
    chip.title = "点击查看往来邮件";
    chip.textContent = (a.name || a.email) +
      (a.name && a.email ? ` <${a.email}>` : "");
    chip.addEventListener("click", () => setContact({ email: a.email, name: a.name || "" }));
    return chip;
  };
  const joinAddrs = (arr) => {
    if (!arr.length) return "—";
    const span = document.createElement("span");
    arr.forEach((a, i) => {
      if (i > 0) span.append(", ");
      span.append(addrChip(a));
    });
    return span;
  };
  els.rdTo.innerHTML = "";
  els.rdTo.append(joinAddrs(data.to));
  els.rdCcRow.classList.toggle("hidden", !(data.cc && data.cc.length));
  els.rdCc.innerHTML = "";
  if (data.cc && data.cc.length) els.rdCc.append(joinAddrs(data.cc));
  els.rdDate.textContent = fmtDateFull(data.dateTs);

  // 视图切换可用性
  const htmlBtn = els.viewSeg.querySelector('[data-mode="html"]');
  htmlBtn.disabled = !data.hasHtml;
  if (!data.hasHtml) state.viewMode = "text";
  els.viewSeg.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.viewMode));

  // 附件
  renderAttachments(data);

  // 正文
  await renderBody(data);
}

function renderAttachments(data) {
  els.attsList.innerHTML = "";
  const atts = data.attachments || [];
  els.attsBar.classList.toggle("hidden", atts.length === 0);
  els.attsCount.textContent = atts.length;
  for (const a of atts) {
    const chip = document.createElement("div");
    chip.className = "att-chip";
    // 图标+文件名+大小组成可点击区域：用默认程序打开
    const main = document.createElement("span");
    main.className = "att-main";
    main.title = `点击打开：${a.fileName}`;
    const icon = document.createElement("span");
    icon.innerHTML = `<svg viewBox="0 0 16 16" style="width:13px;height:13px;color:var(--faint)"><path d="M5 3h4.5A2.5 2.5 0 0 1 12 5.5V13M5 3v9.5A1.5 1.5 0 0 0 6.5 14H12M5 3H3.5A1.5 1.5 0 0 0 2 4.5V6"/></svg>`;
    const name = document.createElement("span");
    name.className = "att-name";
    name.textContent = a.fileName;
    name.title = `${a.fileName} · ${a.contentType}`;
    const size = document.createElement("span");
    size.className = "att-size";
    size.textContent = fmtSize(a.sizeBytes);
    main.append(icon, name, size);
    main.addEventListener("click", () => openAttachment(data.path, a));
    const openBtn = document.createElement("button");
    openBtn.title = "用默认程序打开";
    openBtn.innerHTML = `<svg viewBox="0 0 16 16"><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8A1.5 1.5 0 0 0 13 12.5V10M9 2h5v5m0-5L7 9"/></svg>`;
    openBtn.addEventListener("click", () => openAttachment(data.path, a));
    const btn = document.createElement("button");
    btn.title = "另存为…";
    btn.innerHTML = `<svg viewBox="0 0 16 16"><path d="M8 2v8m0 0L5.5 7.5M8 10l2.5-2.5M3 12.5h10"/></svg>`;
    btn.addEventListener("click", () => exportOne(data.path, a));
    chip.append(main, openBtn, btn);
    els.attsList.appendChild(chip);
  }
}

// 正文深浅跟随全局主题
const bodyIsDark = () => state.theme === "dark";

async function renderBody(data) {
  els.bodyWrap.classList.toggle("dark-body", bodyIsDark());
  if (state.viewMode === "html" && data.htmlBody) {
    els.bodyText.classList.add("hidden");
    els.frame.classList.remove("hidden");
    els.frame.srcdoc = await buildHtmlDoc(data);
  } else {
    els.frame.classList.add("hidden");
    els.bodyText.classList.remove("hidden");
    els.bodyText.textContent =
      data.textBody ||
      (data.htmlBody ? data.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(空邮件)");
  }
}

async function buildHtmlDoc(data) {
  let html = data.htmlBody;
  // 内嵌图片 cid: -> object URL
  const cids = (data.attachments || []).filter((a) => a.contentId);
  if (cids.length) {
    const map = {};
    await Promise.all(cids.map(async (a) => {
      try {
        const bytes = await invoke("read_attachment", { src: data.path, index: a.index });
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: a.contentType }));
        map[a.contentId.toLowerCase()] = url;
        if (a.fileName) map[a.fileName.toLowerCase()] = url;
      } catch { /* 忽略单个内嵌图失败 */ }
    }));
    html = html.replace(/cid:([^"'\s)>\\]+)/gi, (m, id) => {
      const key = decodeURIComponent(id).toLowerCase();
      return map[key] || map[id.toLowerCase()] || m;
    });
  }
  const base = `<base target="_blank"><style>body{margin:0;padding:18px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;color:#222;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#5b4ee0}pre{white-space:pre-wrap}</style>`;
  const dark = bodyIsDark()
    ? `<style>html,body{background:#14161f!important;color:#e2e6f2!important}
h1,h2,h3,h4,h5,h6,p,div,span,li,td,th,blockquote,label,dt,dd{color:#e2e6f2!important}
a{color:#a78bfa!important}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#2c3448;border-radius:6px}::-webkit-scrollbar-track{background:transparent}
</style>`
    : "";
  const inject = base + dark;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + `<head>${inject}</head>`);
  return inject + html;
}

function showReaderEmpty() {
  els.reader.classList.add("hidden");
  els.readerLoading.classList.add("hidden");
  els.readerEmpty.classList.remove("hidden");
}

// ============================ 管理操作 ============================
function updateMyAddrUi() {
  els.myAddrText.textContent = state.myAddr || "未设置";
  els.myAddrText.classList.toggle("unset", !state.myAddr);
}

async function setMyAddr() {
  const v = await promptDialog("设置我的邮箱地址（用于收件 / 发件分类）", state.myAddr);
  if (v === null) return;
  const trimmed = v.trim();
  if (trimmed && !/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    toast("请输入有效的邮箱地址，如 name@example.com", "err");
    return;
  }
  state.myAddr = trimmed;
  localStorage.setItem("eml.myAddr", trimmed);
  updateMyAddrUi();
  applyFilter();
  toast(state.myAddr ? `已设置我的邮箱：${state.myAddr}` : "已清除我的邮箱设置",
    state.myAddr ? "ok" : "info");
}

async function pickLibrary() {
  const p = await dlgOpen({ directory: true, title: "选择邮件库文件夹" });
  const dir = extractPath(p);
  if (!dir) return;
  state.libPath = dir;
  localStorage.setItem("eml.libPath", dir);
  updateLibPathUi();
  rescan({ keepSelection: false });
}
function updateLibPathUi() {
  els.libPath.textContent = state.libPath || "未选择文件夹";
  els.libPath.title = state.libPath;
  if (!state.libPath) els.libStats.innerHTML = "";
}

async function openEmlFiles() {
  const p = await dlgOpen({
    multiple: true,
    title: "打开 EML 文件",
    filters: [{ name: "EML 邮件", extensions: ["eml"] }],
  });
  const files = Array.isArray(p) ? p : p ? [p] : [];
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      const data = await invoke("parse_eml", { path: f });
      state.cache.set(f, data);
      if (!state.summaries.some((s) => s.path === f)) {
        state.summaries.push({
          path: f,
          fileName: data.fileName,
          sizeBytes: data.sizeBytes,
          subject: data.subject,
          fromName: data.from?.name ?? null,
          fromEmail: data.from?.email ?? null,
          to: data.to ?? [],
          cc: data.cc ?? [],
          dateTs: data.dateTs,
          attachmentCount: data.attachments.length,
        });
      }
      ok++;
    } catch (e) {
      toast(`打开失败：${f}（${e}）`, "err");
    }
  }
  applyFilter();
  if (files.length) selectItem(files[0]);
  if (ok > 1) toast(`已打开 ${ok} 封邮件`, "ok");
}

async function exportOne(src, a) {
  const dest = await dlgSave({ defaultPath: a.fileName });
  if (!dest) return;
  try {
    await invoke("export_attachment", { src, index: a.index, dest });
    toast(`已保存：${a.fileName}`, "ok");
  } catch (e) {
    toast(`保存失败：${e}`, "err");
  }
}

let openingAtt = false;
async function openAttachment(src, a) {
  if (openingAtt) return;
  openingAtt = true;
  try {
    await invoke("open_attachment", { src, index: a.index });
    toast(`正在打开：${a.fileName}`, "ok");
  } catch (e) {
    toast(`打开失败：${e}`, "err");
  } finally {
    setTimeout(() => { openingAtt = false; }, 800);
  }
}

async function exportAllAtts() {
  const path = state.selectedPath;
  if (!path) return toast("请先选择一封邮件", "err");
  const data = state.cache.get(path) ?? (await invoke("parse_eml", { path }));
  if (!data.attachments.length) return toast("该邮件没有附件", "err");
  const dir = extractPath(await dlgOpen({ directory: true, title: "选择保存附件的文件夹" }));
  if (!dir) return;
  let ok = 0, fail = 0;
  for (const a of data.attachments) {
    try {
      await invoke("export_attachment", { src: path, index: a.index, dest: `${dir}\\${a.fileName}` });
      ok++;
    } catch { fail++; }
  }
  toast(`导出完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`, fail ? "err" : "ok");
}

async function renameFlow() {
  const path = state.selectedPath;
  if (!path) return;
  const cur = path.split(/[\\/]/).pop();
  const name = await promptDialog("重命名邮件文件", cur);
  if (!name || name === cur) return;
  try {
    const newPath = await invoke("rename_eml", { path, newName: name });
    state.cache.delete(path);
    if (state.selectedPath === path) state.selectedPath = newPath;
    await rescan();
    toast("重命名成功", "ok");
  } catch (e) {
    toast(`重命名失败：${e}`, "err");
  }
}

async function moveFlow() {
  const path = state.selectedPath;
  if (!path) return;
  const destDir = extractPath(await dlgOpen({ directory: true, title: "移动到目标文件夹" }));
  if (!destDir) return;
  try {
    const r = await invoke("move_eml_files", { paths: [path], destDir });
    if (r[0]?.error) return toast(`移动失败：${r[0].error}`, "err");
    state.cache.delete(path);
    state.selectedPath = r[0]?.to ?? null;
    await rescan();
    toast("移动成功", "ok");
  } catch (e) {
    toast(`移动失败：${e}`, "err");
  }
}

async function deleteFlow() {
  const paths = state.selectedPath ? [state.selectedPath] : [];
  if (!paths.length) return;
  const yes = await confirmDialog("删除邮件", `将把这 ${paths.length} 封邮件移入回收站，此操作可在回收站中撤销。`, "移入回收站");
  if (!yes) return;
  try {
    const errs = await invoke("delete_eml_files", { paths });
    if (errs && errs.length) toast(`部分删除失败：${errs[0]}`, "err");
    else toast("已移入回收站", "ok");
    state.selectedPath = null;
    showReaderEmpty();
    await rescan();
  } catch (e) {
    toast(`删除失败：${e}`, "err");
  }
}

function showHeaders(data) {
  openModal({ title: "原始头信息", okText: "关闭", onOk: () => {} });
  els.modalBody.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "hdr-table";
  for (const h of data.rawHeaders || []) {
    const row = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = h.key;
    row.append(b, ": " + h.value);
    wrap.appendChild(row);
  }
  els.modalBody.appendChild(wrap);
  // 隐藏取消按钮：仅关闭
  els.modalCancel.classList.add("hidden");
  const obs = new MutationObserver(() => {
    if (els.modalMask.classList.contains("hidden")) {
      els.modalCancel.classList.remove("hidden");
      obs.disconnect();
    }
  });
  obs.observe(els.modalMask, { attributes: true });
}

// ============================ 事件绑定 ============================
function bindEvents() {
  // 窗口控制
  const win = getCurrentWindow();
  $("winMin").addEventListener("click", () => win.minimize());
  $("winMax").addEventListener("click", () => win.toggleMaximize());
  $("winClose").addEventListener("click", () => win.close());

  // 全局明亮 / 暗黑主题
  els.btnTheme.addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("eml.theme", state.theme);
    applyTheme();
  });

  $("btnPickLib").addEventListener("click", pickLibrary);
  $("btnOpenFiles").addEventListener("click", openEmlFiles);
  $("btnRescan").addEventListener("click", () => rescan());
  $("btnExportAll").addEventListener("click", exportAllAtts);

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    applyFilter();
  });
  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    applyFilter();
  });
  document.querySelectorAll("#filterNav .filter-item").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#filterNav .filter-item").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.filter = b.dataset.filter;
      applyFilter();
    });
  });

  // 我的邮箱设置
  els.btnSetMyAddr.addEventListener("click", setMyAddr);

  // 联系人筛选横幅
  els.contactClear.addEventListener("click", () => {
    state.contact = null;
    updateContactBanner();
    applyFilter();
  });

  els.viewSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    state.viewMode = btn.dataset.mode;
    els.viewSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    const data = state.cache.get(state.selectedPath);
    if (data) renderBody(data);
  });

  $("btnHeaders").addEventListener("click", () => {
    const d = state.cache.get(state.selectedPath);
    if (d) showHeaders(d);
  });
  $("btnReveal").addEventListener("click", () => {
    if (state.selectedPath) invoke("reveal_in_explorer", { path: state.selectedPath }).catch((e) => toast(String(e), "err"));
  });
  $("btnRename").addEventListener("click", renameFlow);
  $("btnMove").addEventListener("click", moveFlow);
  $("btnDelete").addEventListener("click", deleteFlow);

  // 键盘导航
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !els.modalMask.classList.contains("hidden")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.filtered.length) return;
      const idx = state.filtered.findIndex((s) => s.path === state.selectedPath);
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, state.filtered.length - 1) : Math.max(idx - 1, 0);
      const p = state.filtered[next < 0 ? 0 : next].path;
      selectItem(p);
      els.list.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Escape" && !els.modalMask.classList.contains("hidden")) {
      closeModal();
    }
  });
}

// ============================ 启动 ============================
function applyTheme() {
  document.body.classList.toggle("light", state.theme === "light");
  els.btnTheme.title = state.theme === "light" ? "切换到暗黑模式" : "切换到明亮模式";
  // 正文深浅跟随全局主题，切换后立即刷新当前邮件正文
  els.bodyWrap.classList.toggle("dark-body", state.theme === "dark");
  const data = state.cache.get(state.selectedPath);
  if (data) renderBody(data);
}

bindEvents();
applyTheme();
updateMyAddrUi();
updateLibPathUi();
if (state.libPath) rescan();
else { applyFilter(); showReaderEmpty(); }
