'use strict';
// Loopback HTTP/JSON client used for node-to-node and node-to-gateway calls. Never rejects.
const http = require('http');

const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 64, keepAliveMsecs: 1000 });
const port = () => Number(process.env.PORT || 8180);
const MAX_RESPONSE = 1 << 20;

function call(method, path, body, opts = {}) {
  const { timeoutMs = 2000, headers = {}, signal } = opts;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let req = null;
    const onAbort = () => { finish({ status: 0, body: null, aborted: true }); try { if (req) req.destroy(); } catch { /* ignore */ } };
    function finish(r) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(r);
    }
    if (signal && signal.aborted) { finish({ status: 0, body: null, aborted: true }); return; }
    try {
      const data = body === undefined ? null : JSON.stringify(body);
      const h = { 'content-type': 'application/json', ...headers };
      if (data !== null) h['content-length'] = Buffer.byteLength(data);
      req = http.request({ host: '127.0.0.1', port: port(), path, method, agent, headers: h }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= MAX_RESPONSE) chunks.push(c); });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
          finish({ status: res.statusCode, body: j });
        });
        res.on('error', () => finish({ status: 0, body: null, neterr: true }));
      });
      req.on('error', () => finish({ status: 0, body: null, neterr: true }));
      timer = setTimeout(() => {
        try { finish({ status: 0, body: null, timeout: true }); if (req) req.destroy(); } catch { /* ignore */ }
      }, Math.max(1, Math.floor(timeoutMs)));
      if (timer.unref) timer.unref();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (data !== null) req.end(data); else req.end();
    } catch {
      finish({ status: 0, body: null, neterr: true });
    }
  });
}

module.exports = { call, agent };
