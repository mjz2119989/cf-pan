// 极简 S3 客户端（SigV4），用于 Backblaze B2 等 S3 兼容存储
// 需要环境变量：B2_ENDPOINT（如 s3.us-west-004.backblazeb2.com）、B2_BUCKET、B2_KEY_ID、B2_APP_KEY

const enc = new TextEncoder();

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data);
  return hex(buf);
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacRaw(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
function uriEncode(s, keepSlash) {
  return [...enc.encode(s)]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
      return "%" + b.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}
function xmlDecode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlDecode(m[1]) : null;
}
function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

export class S3 {
  constructor(env) {
    this.scheme = /^http:\/\//.test(env.B2_ENDPOINT) ? "http" : "https";
    this.host = env.B2_ENDPOINT.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.region = (this.host.match(/s3\.([a-z0-9-]+)\./) || [, "us-east-1"])[1];
    this.bucket = env.B2_BUCKET;
    this.keyId = env.B2_KEY_ID;
    this.secret = env.B2_APP_KEY;
  }

  // 发送签名请求；body 为流时需提供 contentLength
  async request(method, key, { query = {}, headers = {}, body = null, contentLength } = {}) {
    const path = "/" + uriEncode(this.bucket, false) + (key !== undefined ? "/" + uriEncode(key, true) : "");
    const qs = Object.keys(query)
      .sort()
      .map((k) => uriEncode(k, false) + "=" + uriEncode(String(query[k]), false))
      .join("&");
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);

    let payloadHash = "UNSIGNED-PAYLOAD";
    if (body === null) payloadHash = await sha256Hex("");
    else if (typeof body === "string") payloadHash = await sha256Hex(body);

    const h = { host: this.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
    for (const [k, v] of Object.entries(headers)) if (v != null) h[k.toLowerCase()] = String(v);
    const signed = Object.keys(h).sort();
    const canonical = [
      method,
      path,
      qs,
      signed.map((k) => `${k}:${h[k].trim()}\n`).join(""),
      signed.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
    let k = await hmacRaw("AWS4" + this.secret, date);
    k = await hmacRaw(k, this.region);
    k = await hmacRaw(k, "s3");
    k = await hmacRaw(k, "aws4_request");
    const sig = hex(await hmacRaw(k, toSign));
    const reqHeaders = new Headers(h);
    reqHeaders.delete("host");
    reqHeaders.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${sig}`
    );

    let sendBody = body;
    if (body && typeof body !== "string" && contentLength != null) {
      const { readable, writable } = new FixedLengthStream(Number(contentLength));
      body.pipeTo(writable);
      sendBody = readable;
    }
    return fetch(`${this.scheme}://${this.host}${path}${qs ? "?" + qs : ""}`, { method, headers: reqHeaders, body: sendBody });
  }

  async check(res) {
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`存储错误 ${res.status}: ${tag(t, "Message") || t.slice(0, 200)}`);
    }
    return res;
  }

  // 下载，透传 Range / 条件头
  async get(key, reqHeaders) {
    const headers = {};
    for (const n of ["range", "if-none-match", "if-modified-since"]) {
      const v = reqHeaders.get(n);
      if (v) headers[n] = v;
    }
    return this.request("GET", key, { headers });
  }

  async list({ prefix = "", delimiter, cursor } = {}) {
    const query = { "list-type": "2", prefix, "max-keys": "1000" };
    if (delimiter) query.delimiter = delimiter;
    if (cursor) query["continuation-token"] = cursor;
    const xml = await (await this.check(await this.request("GET", undefined, { query }))).text();
    return {
      objects: tags(xml, "Contents").map((c) => ({
        key: tag(c, "Key"),
        size: Number(tag(c, "Size")),
        uploaded: tag(c, "LastModified"),
      })),
      delimitedPrefixes: tags(xml, "CommonPrefixes").map((c) => tag(c, "Prefix")),
      truncated: tag(xml, "IsTruncated") === "true",
      cursor: tag(xml, "NextContinuationToken"),
    };
  }

  async put(key, body, contentType, contentLength) {
    const headers = { "content-type": contentType || "application/octet-stream" };
    if (typeof body === "string") return this.check(await this.request("PUT", key, { headers, body }));
    return this.check(await this.request("PUT", key, { headers, body, contentLength }));
  }

  async delete(key) {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) await this.check(res);
  }

  async createMultipart(key, contentType) {
    const xml = await (
      await this.check(
        await this.request("POST", key, {
          query: { uploads: "" },
          headers: { "content-type": contentType || "application/octet-stream" },
        })
      )
    ).text();
    return tag(xml, "UploadId");
  }

  async uploadPart(key, uploadId, partNumber, body, contentLength) {
    const res = await this.check(
      await this.request("PUT", key, { query: { partNumber, uploadId }, body, contentLength })
    );
    return { partNumber, etag: res.headers.get("etag") };
  }

  async completeMultipart(key, uploadId, parts) {
    const body =
      "<CompleteMultipartUpload>" +
      parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const res = await this.check(
      await this.request("POST", key, { query: { uploadId }, body, headers: { "content-type": "application/xml" } })
    );
    const t = await res.text();
    if (t.includes("<Error>")) throw new Error("合并分片失败: " + (tag(t, "Message") || ""));
  }

  async abortMultipart(key, uploadId) {
    await this.request("DELETE", key, { query: { uploadId } });
  }
}
