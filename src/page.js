export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的网盘</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222}
  header{background:#fff;padding:12px 16px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #e5e5e5;position:sticky;top:0}
  header h1{font-size:18px;margin:0;flex:1}
  button{border:0;border-radius:8px;padding:8px 12px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
  button.ghost{background:#eef2ff;color:#2563eb}
  button.danger{background:#fee2e2;color:#b91c1c}
  main{max-width:900px;margin:0 auto;padding:12px}
  .crumbs{margin:8px 0 12px;font-size:14px}
  .crumbs a{color:#2563eb;text-decoration:none;cursor:pointer}
  .row{background:#fff;border-radius:10px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;gap:8px}
  .row .name{flex:1;word-break:break-all;cursor:pointer}
  .row .meta{color:#888;font-size:12px;white-space:nowrap}
  .row .acts{display:flex;gap:4px}
  .row .acts button{padding:6px 8px;font-size:12px}
  #drop{border:2px dashed #c7d2fe;border-radius:10px;padding:14px;text-align:center;color:#6b7280;margin-bottom:12px}
  #drop.over{background:#eef2ff}
  #progress{font-size:13px;color:#2563eb;margin-bottom:8px;white-space:pre-line}
  #login{max-width:320px;margin:20vh auto;background:#fff;padding:24px;border-radius:12px}
  #login input{width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;margin:12px 0;font-size:16px}
  #login button{width:100%}
  .hidden{display:none}
</style>
</head>
<body>
<div id="login" class="hidden">
  <h2 style="margin:0">登录网盘</h2>
  <input id="pw" type="password" placeholder="密码" autocomplete="current-password">
  <button onclick="login()">登录</button>
  <p id="loginErr" style="color:#b91c1c;font-size:13px"></p>
</div>

<div id="app" class="hidden">
  <header>
    <h1>我的网盘</h1>
    <button class="ghost" onclick="mkdir()">新建文件夹</button>
    <button onclick="document.getElementById('file').click()">上传</button>
    <button class="ghost" onclick="location.href='/api/logout'">退出</button>
    <input id="file" type="file" multiple class="hidden" onchange="uploadFiles(this.files);this.value=''">
  </header>
  <main>
    <div class="crumbs" id="crumbs"></div>
    <div id="drop">把文件拖到这里上传</div>
    <div id="progress"></div>
    <div id="list"></div>
  </main>
</div>

<script>
const CHUNK = 20 * 1024 * 1024; // 分片大小 20MB
const SMALL = 50 * 1024 * 1024; // 小于 50MB 直接上传
let prefix = decodeURIComponent(location.hash.slice(1) || "");

const $ = (id) => document.getElementById(id);
const fmt = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n/1024).toFixed(1) + " KB"
  : n < 1073741824 ? (n/1048576).toFixed(1) + " MB" : (n/1073741824).toFixed(2) + " GB";
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const enc = encodeURIComponent;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error("未登录"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function showLogin() { $("app").classList.add("hidden"); $("login").classList.remove("hidden"); }

async function login() {
  const r = await fetch("/api/login", { method: "POST", headers: {"content-type":"application/json"},
    body: JSON.stringify({ password: $("pw").value }) });
  if (r.ok) { $("login").classList.add("hidden"); load(); }
  else $("loginErr").textContent = "密码错误";
}
$("pw").addEventListener("keydown", (e) => e.key === "Enter" && login());

function go(p) { prefix = p; location.hash = enc(p); load(); }
window.addEventListener("hashchange", () => { const p = decodeURIComponent(location.hash.slice(1)); if (p !== prefix) { prefix = p; load(); } });

async function load() {
  let data;
  try { data = await api("/api/list?prefix=" + enc(prefix)); } catch (e) { return; }
  $("app").classList.remove("hidden");
  const parts = prefix.split("/").filter(Boolean);
  let acc = "", html = '<a onclick="go(\\'\\')">全部文件</a>';
  for (const p of parts) { acc += p + "/"; const a = acc; html += ' / <a data-p="' + esc(a) + '">' + esc(p) + "</a>"; }
  $("crumbs").innerHTML = html;
  $("crumbs").querySelectorAll("a[data-p]").forEach((a) => a.onclick = () => go(a.dataset.p));

  const list = $("list"); list.innerHTML = "";
  if (!data.folders.length && !data.files.length) list.innerHTML = '<p style="color:#888;text-align:center">空文件夹</p>';
  for (const f of data.folders) {
    const name = f.slice(prefix.length).replace(/\\/$/, "");
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<span class="name">📁 ' + esc(name) + '</span><span class="acts"><button class="danger">删除</button></span>';
    row.querySelector(".name").onclick = () => go(f);
    row.querySelector(".danger").onclick = async () => {
      if (!confirm("删除文件夹「" + name + "」及其中所有文件？")) return;
      await api("/api/file?key=" + enc(f), { method: "DELETE" }); load();
    };
    list.appendChild(row);
  }
  for (const f of data.files) {
    const name = f.key.slice(prefix.length);
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<span class="name">📄 ' + esc(name) + '</span><span class="meta">' + fmt(f.size) +
      '</span><span class="acts"><button class="ghost" data-a="dl">下载</button><button class="ghost" data-a="share">分享</button><button class="danger" data-a="del">删除</button></span>';
    row.querySelector(".name").onclick = () => window.open("/api/file?key=" + enc(f.key));
    row.querySelector('[data-a="dl"]').onclick = () => location.href = "/api/file?dl=1&key=" + enc(f.key);
    row.querySelector('[data-a="share"]').onclick = async () => {
      const days = prompt("分享链接有效天数（1-365）", "7"); if (!days) return;
      const r = await api("/api/share?days=" + enc(days) + "&key=" + enc(f.key));
      try { await navigator.clipboard.writeText(r.url); alert("链接已复制：\\n" + r.url); } catch { prompt("复制这个链接", r.url); }
    };
    row.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm("删除「" + name + "」？")) return;
      await api("/api/file?key=" + enc(f.key), { method: "DELETE" }); load();
    };
    list.appendChild(row);
  }
}

async function mkdir() {
  const name = prompt("文件夹名称"); if (!name) return;
  await api("/api/mkdir?path=" + enc(prefix + name.replace(/\\//g, "")), { method: "POST" }); load();
}

function setProgress(lines) { $("progress").textContent = lines.join("\\n"); }

async function uploadOne(file, report) {
  const key = prefix + (file.webkitRelativePath || file.name);
  const type = file.type || "application/octet-stream";
  if (file.size <= SMALL) {
    report(0);
    await api("/api/file?key=" + enc(key), { method: "PUT", headers: {"content-type": type}, body: file });
    report(100); return;
  }
  const { uploadId } = await api("/api/mpu/create?key=" + enc(key) + "&type=" + enc(type), { method: "POST" });
  const total = Math.ceil(file.size / CHUNK);
  const parts = [];
  try {
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
      let tries = 0;
      while (true) {
        try {
          const part = await api("/api/mpu/part?key=" + enc(key) + "&uploadId=" + enc(uploadId) + "&part=" + (i + 1), { method: "PUT", body: blob });
          parts.push(part); break;
        } catch (e) { if (++tries >= 3) throw e; }
      }
      report(Math.round((i + 1) / total * 100));
    }
    await api("/api/mpu/complete?key=" + enc(key) + "&uploadId=" + enc(uploadId),
      { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ parts }) });
  } catch (e) {
    await api("/api/mpu/abort?key=" + enc(key) + "&uploadId=" + enc(uploadId), { method: "POST" }).catch(() => {});
    throw e;
  }
}

async function uploadFiles(files) {
  const status = [...files].map((f) => f.name + "：等待");
  for (let i = 0; i < files.length; i++) {
    try {
      await uploadOne(files[i], (pct) => { status[i] = files[i].name + "：" + pct + "%"; setProgress(status); });
      status[i] = files[i].name + "：完成 ✓";
    } catch (e) { status[i] = files[i].name + "：失败 " + e.message; }
    setProgress(status);
  }
  load();
  setTimeout(() => setProgress([]), 4000);
}

const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });

load();
</script>
</body>
</html>`;
