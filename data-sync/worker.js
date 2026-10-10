// 精简版 VLESS-over-WebSocket Worker
// 单文件、无 KV、无面板，仅保留核心转发逻辑
// 部署：粘贴到 Worker 编辑器，设置环境变量 UUID，部署即可

import { connect } from 'cloudflare:sockets';

const UUID_FALLBACK = ''; // 也可直接填在这里；优先用环境变量 UUID

export default {
  async fetch(request, env) {
    const uuid = ((env.UUID || UUID_FALLBACK || '').trim().toLowerCase().replace(/-/g, ''));
    if (!uuid || uuid.length !== 32) return new Response('missing uuid', { status: 500 });

    const url = new URL(request.url);

    // 订阅页： /<uuid> 返回 vless 链接文本
    if (url.pathname.slice(1).replace(/-/g, '') === uuid) {
      const host = request.headers.get('host');
      const uuidDash = `${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`;
      const link = `vless://${uuidDash}@${host}:443?encryption=none&security=tls&sni=${host}&fp=random&type=ws&host=${host}&path=%2F#worker`;
      return new Response(link, { headers: { 'content-type': 'text/plain;charset=utf-8' } });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('ok', { status: 200 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    handleConnection(server, uuid, request).catch(() => { try { server.close(); } catch {} });
    return new Response(null, { status: 101, webSocket: client });
  }
};

async function handleConnection(ws, uuidHex, request) {
  // 首包数据：优先取 WebSocket 握手里的 early data（Sec-WebSocket-Protocol 头 base64），
  // 没有则等第一条 WebSocket 消息
  let first = null;
  const early = request.headers.get('sec-websocket-protocol') || '';
  if (early) {
    try {
      const bin = atob(early.replace(/-/g, '+').replace(/_/g, '/'));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      first = u8.buffer;
    } catch {}
  }
  if (!first) {
    first = await new Promise((resolve) => {
      const onMsg = (e) => { ws.removeEventListener('message', onMsg); resolve(e.data); };
      const onClose = () => resolve(null);
      ws.addEventListener('message', onMsg);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onClose);
    });
  }
  if (!first) return;

  let buf;
  if (first instanceof ArrayBuffer) buf = new Uint8Array(first);
  else if (first instanceof Uint8Array) buf = first;
  else return;
  if (buf.length < 24) return;

  // 校验 UUID（第 1-16 字节）
  let got = '';
  for (let i = 1; i < 17; i++) got += buf[i].toString(16).padStart(2, '0');
  if (got !== uuidHex) return;

  const optLen = buf[17];
  const cmd = buf[18 + optLen]; // 1=TCP 2=UDP
  if (cmd === 2) return; // 精简版不支持 UDP

  let idx = 19 + optLen;
  const port = (buf[idx] << 8) | buf[idx + 1]; idx += 2;
  const atyp = buf[idx++];
  let address = '';
  if (atyp === 1) {
    address = `${buf[idx]}.${buf[idx+1]}.${buf[idx+2]}.${buf[idx+3]}`; idx += 4;
  } else if (atyp === 2) {
    const len = buf[idx++];
    address = new TextDecoder().decode(buf.slice(idx, idx + len)); idx += len;
  } else if (atyp === 3) {
    const p = [];
    for (let i = 0; i < 8; i++) { p.push(((buf[idx] << 8) | buf[idx+1]).toString(16)); idx += 2; }
    address = p.join(':');
  } else return;

  // 连接目标
  let remote;
  try {
    remote = connect({ hostname: address, port });
  } catch { return; }

  // 把首包剩余数据发给目标
  try {
    const w = remote.writable.getWriter();
    await w.write(buf.slice(idx));
    w.releaseLock();
  } catch { return; }

  // 目标 -> 客户端：加 VLESS 响应头后经 WebSocket 发回
  let headerSent = false;
  remote.readable.pipeTo(new WritableStream({
    write(chunk) {
      if (ws.readyState !== 1) return;
      const data = new Uint8Array(chunk);
      if (!headerSent) {
        const out = new Uint8Array(2 + data.length);
        out[0] = 0; out[1] = 0; // 版本 + 附加长度
        out.set(data, 2);
        ws.send(out);
        headerSent = true;
      } else {
        ws.send(data);
      }
    },
    close() { try { ws.close(); } catch {} },
  })).catch(() => { try { ws.close(); } catch {} });

  // 客户端 -> 目标
  ws.addEventListener('message', async (e) => {
    try {
      const w = remote.writable.getWriter();
      await w.write(e.data);
      w.releaseLock();
    } catch {}
  });
  const closeBoth = () => { try { remote.close(); } catch {} };
  ws.addEventListener('close', closeBoth);
  ws.addEventListener('error', closeBoth);
}
