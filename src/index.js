// cf-pan: 基于 Cloudflare Workers + Backblaze B2（S3 兼容）的个人网盘
// Secrets：PASSWORD 登录密码，SECRET 签名密钥，B2_KEY_ID / B2_APP_KEY B2 应用密钥
// 变量：B2_ENDPOINT（如 s3.us-west-004.backblazeb2.com），B2_BUCKET 桶名

import { PAGE } from "./page.js";
import { S3 } from "./s3.js";

const COOKIE = "pan_auth";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64urlEncode(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function isAuthed(req, env) {
  const token = getCookie(req, COOKIE);
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Date.now() > Number(exp)) return false;
  return safeEqual(sig, await hmac(env.SECRET, "session:" + exp));
}

function cleanKey(k) {
  if (!k) return "";
  k = k.replace(/\\/g, "/").replace(/^\/+/, "");
  if (k.split("/").some((p) => p === "..")) throw new Error("非法路径");
  return k;
}

async function serveObject(req, env, key, asAttachment) {
  const res = await store(env).get(key, req.headers);
  if (res.status === 404) return new Response("文件不存在", { status: 404 });
  if (res.status === 304) return new Response(null, { status: 304 });
  if (!res.ok) return new Response("读取失败 " + res.status, { status: 502 });
  const headers = new Headers();
  for (const n of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
    const v = res.headers.get(n);
    if (v) headers.set(n, v);
  }
  headers.set("accept-ranges", "bytes");
  const name = key.split("/").pop();
  headers.set(
    "content-disposition",
    `${asAttachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  return new Response(res.body, { status: res.status, headers });
}

let _s3;
function store(env) {
  if (!_s3) _s3 = new S3(env);
  return _s3;
}

async function listDir(env, prefix) {
  const folders = new Set();
  const files = [];
  let cursor;
  do {
    const res = await store(env).list({ prefix, delimiter: "/", cursor });
    for (const p of res.delimitedPrefixes) folders.add(p);
    for (const o of res.objects) {
      if (o.key.endsWith("/.keep") || o.key === prefix) continue;
      files.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return { prefix, folders: [...folders].sort(), files };
}

async function deletePrefix(env, prefix) {
  let count = 0;
  for (;;) {
    const res = await store(env).list({ prefix });
    if (!res.objects.length) break;
    await Promise.all(res.objects.map((o) => store(env).delete(o.key)));
    count += res.objects.length;
    if (!res.truncated) break;
  }
  return count;
}

export default {
  async fetch(req, env) {
    if (!env.PASSWORD || !env.SECRET || !env.B2_KEY_ID || !env.B2_APP_KEY) {
      return new Response("请先设置 PASSWORD、SECRET、B2_KEY_ID、B2_APP_KEY 四个 Secret", { status: 500 });
    }
    const url = new URL(req.url);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      // 公开分享链接：/s/<key>?e=过期时间&sig=签名
      if (p.startsWith("/s/")) {
        const key = cleanKey(b64urlDecode(p.slice(3)));
        const e = q.get("e") || "";
        const sig = q.get("sig") || "";
        if (!e || Date.now() > Number(e)) return new Response("链接已过期", { status: 410 });
        if (!safeEqual(sig, await hmac(env.SECRET, `share:${key}:${e}`))) {
          return new Response("链接无效", { status: 403 });
        }
        return serveObject(req, env, key, q.get("dl") === "1");
      }

      if (p === "/api/login" && req.method === "POST") {
        const { password } = await req.json();
        if (typeof password !== "string" || !safeEqual(password, env.PASSWORD)) {
          return json({ error: "密码错误" }, 401);
        }
        const exp = Date.now() + SESSION_DAYS * 86400e3;
        const token = `${exp}.${await hmac(env.SECRET, "session:" + exp)}`;
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
          },
        });
      }

      if (p === "/api/logout") {
        return new Response(null, {
          status: 302,
          headers: { location: "/", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` },
        });
      }

      if (p === "/" || p === "/index.html") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (!p.startsWith("/api/")) return new Response("Not found", { status: 404 });
      if (!(await isAuthed(req, env))) return json({ error: "未登录" }, 401);

      // 列目录
      if (p === "/api/list") return json(await listDir(env, cleanKey(q.get("prefix") || "")));

      // 新建文件夹
      if (p === "/api/mkdir" && req.method === "POST") {
        const dir = cleanKey(q.get("path")).replace(/\/+$/, "");
        if (!dir) return json({ error: "名称为空" }, 400);
        await store(env).put(dir + "/.keep", "", "text/plain");
        return json({ ok: true });
      }

      // 单文件：GET 下载 / PUT 上传（小于 90MB）/ DELETE 删除
      if (p === "/api/file") {
        const key = cleanKey(q.get("key"));
        if (!key) return json({ error: "缺少 key" }, 400);
        if (req.method === "GET") return serveObject(req, env, key, q.get("dl") === "1");
        if (req.method === "PUT") {
          const len = req.headers.get("content-length");
          if (!len) return json({ error: "缺少 Content-Length" }, 411);
          await store(env).put(key, req.body || "", req.headers.get("content-type"), len);
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          if (key.endsWith("/")) return json({ deleted: await deletePrefix(env, key) });
          await store(env).delete(key);
          return json({ ok: true });
        }
      }

      // 大文件分片上传
      if (p === "/api/mpu/create" && req.method === "POST") {
        const key = cleanKey(q.get("key"));
        return json({ uploadId: await store(env).createMultipart(key, q.get("type")) });
      }
      if (p === "/api/mpu/part" && req.method === "PUT") {
        const len = req.headers.get("content-length");
        if (!len) return json({ error: "缺少 Content-Length" }, 411);
        return json(await store(env).uploadPart(cleanKey(q.get("key")), q.get("uploadId"), Number(q.get("part")), req.body, len));
      }
      if (p === "/api/mpu/complete" && req.method === "POST") {
        const { parts } = await req.json();
        await store(env).completeMultipart(cleanKey(q.get("key")), q.get("uploadId"), parts);
        return json({ ok: true });
      }
      if (p === "/api/mpu/abort" && req.method === "POST") {
        await store(env).abortMultipart(cleanKey(q.get("key")), q.get("uploadId"));
        return json({ ok: true });
      }

      // 生成分享链接
      if (p === "/api/share") {
        const key = cleanKey(q.get("key"));
        const days = Math.min(Math.max(Number(q.get("days")) || 7, 1), 365);
        const e = Date.now() + days * 86400e3;
        const sig = await hmac(env.SECRET, `share:${key}:${e}`);
        return json({ url: `${url.origin}/s/${b64urlEncode(key)}?e=${e}&sig=${sig}`, expires: e });
      }

      return json({ error: "未知接口" }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};
