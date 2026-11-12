import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { loadConfig } from './config';
import { SessionStore } from './session';
import { AccessCache } from './access';

// ── Config ────────────────────────────────────────────────────────────────────

const config = loadConfig();
const sessions = new SessionStore(config.SESSION_TTL_SECONDS);
const access = new AccessCache(
  config.ACCESS_CACHE_SECONDS,
  config.API_URL,
  config.PROXY_TOKEN,
);

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) map.set(key, val);
  }
  return map;
}

/** Serialise a cookie Map back to a Cookie header value. */
function serializeCookies(map: Map<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Validate a return-path from the query string.
 * Accepts only paths that start with exactly one "/", have no backslashes,
 * no control chars, and are under 2048 chars. Anything else becomes "/".
 */
function safeReturnPath(raw: string | null): string {
  if (!raw || raw.length > 2048) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!decoded.startsWith('/')) return '/';
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return '/';
  if (decoded.includes('\\')) return '/';
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) < 32) return '/';
  }
  return raw; // return original URL-encoded value for Location header
}

/** Make an outbound JSON POST to the SSC API (exchange endpoint). */
function apiPost(
  urlStr: string,
  token: string,
  body: object,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = null; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('exchange timeout')));
    req.write(payload);
    req.end();
  });
}

/** Expire the session cookie immediately. */
const EXPIRED_COOKIE =
  `__ssc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
  `Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

function proxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-SSC-Proxy': '1', ...extra };
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  const headers = proxyHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    ...extra,
  });
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: object,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  const headers = proxyHeaders({
    'Content-Type': 'application/json',
    ...extra,
  });
  res.writeHead(status, headers);
  res.end(payload);
}

function send302(res: http.ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, proxyHeaders({ Location: location, ...extra }));
  res.end();
}

// ── Unauthenticated response ──────────────────────────────────────────────────

function handleUnauth(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method ?? 'GET';
  const accept = req.headers.accept ?? '';

  // Non-GET/HEAD or non-HTML accept → 401 JSON
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 401, { error: 'unauthenticated' });
    return;
  }
  if (!accept.includes('text/html') && accept !== '') {
    sendJson(res, 401, { error: 'unauthenticated' });
    return;
  }

  const rawPath = (req.url ?? '/');
  const returnParam = encodeURIComponent(rawPath);
  const loginUrl = `${config.LOGIN_URL}?app=${encodeURIComponent(config.APP_ID)}&return=${returnParam}`;
  send302(res, loginUrl);
}

// ── Reserved path handlers ────────────────────────────────────────────────────

function handleHealth(res: http.ServerResponse): void {
  res.writeHead(200, proxyHeaders({ 'Content-Type': 'text/plain' }));
  res.end('ok');
}

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const code = url.searchParams.get('code');
  const returnPath = safeReturnPath(url.searchParams.get('return'));

  if (!code) {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>');
    return;
  }

  try {
    const result = await apiPost(
      `${config.API_URL}/v1/proxy/exchange`,
      config.PROXY_TOKEN,
      { code },
    );

    if (result.status !== 200) {
      sendHtml(res, 401, '<h1>401 Unauthorized</h1>');
      return;
    }

    const body = result.body as { user_id?: string; email?: string };
    if (!body.user_id || !body.email) {
      sendHtml(res, 401, '<h1>401 Unauthorized</h1>');
      return;
    }

    const sessionId = sessions.create(body.user_id, body.email);
    const cookie =
      `__ssc_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
      `Max-Age=${config.SESSION_TTL_SECONDS}`;
    send302(res, returnPath, { 'Set-Cookie': cookie });
  } catch {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>');
  }
}

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.get('__ssc_session');
  if (sid) sessions.delete(sid);
  send302(res, '/', { 'Set-Cookie': EXPIRED_COOKIE });
}

// ── Forwarding ────────────────────────────────────────────────────────────────

function buildForwardHeaders(
  req: http.IncomingMessage,
  userId: string,
  email: string,
): Record<string, string | string[]> {
  // Copy headers, using lowercase keys
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k] = v as string | string[];
  }

  // Strip any spoofed x-ssc-* headers
  for (const k of Object.keys(out)) {
    if (k.toLowerCase().startsWith('x-ssc-')) delete out[k];
  }

  // Rewrite Cookie: remove __ssc_session
  const cookieStr = Array.isArray(out.cookie)
    ? out.cookie.join('; ')
    : (out.cookie as string | undefined);
  if (cookieStr) {
    const jar = parseCookies(cookieStr);
    jar.delete('__ssc_session');
    if (jar.size === 0) {
      delete out.cookie;
    } else {
      out.cookie = serializeCookies(jar);
    }
  }

  // SSC context headers
  out['x-ssc-user-id'] = userId;
  out['x-ssc-user-email'] = email;
  out['x-forwarded-proto'] = 'https';
  out['x-forwarded-host'] = (req.headers.host as string) ?? '';

  return out;
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  email: string,
): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const fwdHeaders = buildForwardHeaders(req, userId, email);

  const appReq = http.request(
    {
      hostname: '127.0.0.1',
      port: config.APP_PORT,
      path: url.pathname + url.search,
      method: req.method,
      headers: fwdHeaders,
    },
    (appRes) => {
      // Build outbound headers: filter Set-Cookie for __ssc_session, inject X-SSC-Proxy
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(appRes.headers)) {
        if (k.toLowerCase() === 'set-cookie') {
          const cookies = Array.isArray(v) ? v : [v as string];
          const filtered = cookies.filter(
            (c) => !/^__ssc_session\s*=/i.test(c),
          );
          if (filtered.length > 0) outHeaders[k] = filtered;
        } else {
          outHeaders[k] = v;
        }
      }
      outHeaders['x-ssc-proxy'] = '1';

      res.writeHead(appRes.statusCode ?? 502, appRes.statusMessage, outHeaders);
      appRes.pipe(res);
    },
  );

  appReq.on('error', () => {
    if (!res.headersSent) {
      sendHtml(res, 502, '<h1>502 Bad Gateway</h1>');
    }
  });

  req.pipe(appReq);
}

// ── WebSocket tunnel ──────────────────────────────────────────────────────────

function tunnelWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  userId: string,
  email: string,
): void {
  const fwdHeaders = buildForwardHeaders(req, userId, email);

  const appSocket = net.createConnection(
    { host: '127.0.0.1', port: config.APP_PORT },
    () => {
      let upgradeReq = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(fwdHeaders)) {
        if (Array.isArray(v)) {
          for (const val of v) upgradeReq += `${k}: ${val}\r\n`;
        } else {
          upgradeReq += `${k}: ${v}\r\n`;
        }
      }
      upgradeReq += '\r\n';
      appSocket.write(upgradeReq);
      if (head.length > 0) appSocket.write(head);
      socket.pipe(appSocket);
      appSocket.pipe(socket);
    },
  );

  appSocket.on('error', () => {
    socket.write(
      'HTTP/1.1 502 Bad Gateway\r\nX-SSC-Proxy: 1\r\nContent-Length: 0\r\n\r\n',
    );
    socket.destroy();
  });

  socket.on('error', () => appSocket.destroy());
}

// ── Main request handler ──────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const start = Date.now();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  try {
    const url = new URL(rawUrl, 'http://localhost');
    const pathname = url.pathname;

    // ── Reserved /__ssc/* paths ──────────────────────────────────────────────
    if (pathname === '/__ssc/health') {
      handleHealth(res);
      log(method, rawUrl, 200, start);
      return;
    }
    if (pathname === '/__ssc/callback' && method === 'GET') {
      await handleCallback(req, res);
      log(method, rawUrl, res.statusCode, start);
      return;
    }
    if (pathname === '/__ssc/logout' && method === 'GET') {
      handleLogout(req, res);
      log(method, rawUrl, res.statusCode, start);
      return;
    }
    if (pathname.startsWith('/__ssc/')) {
      sendHtml(res, 404, '<h1>404 Not Found</h1>');
      log(method, rawUrl, 404, start);
      return;
    }

    // ── Session check ────────────────────────────────────────────────────────
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.get('__ssc_session');
    const session = sid ? sessions.get(sid) : undefined;

    if (!session) {
      handleUnauth(req, res);
      log(method, rawUrl, res.statusCode, start);
      return;
    }

    // ── Access check ─────────────────────────────────────────────────────────
    const { allowed, deleteSession } = await access.check(session.userId);
    if (!allowed) {
      if (deleteSession && sid) {
        sessions.delete(sid);
      }
      // Expire the cookie
      res.setHeader('Set-Cookie', EXPIRED_COOKIE);
      handleUnauth(req, res);
      log(method, rawUrl, res.statusCode, start);
      return;
    }

    // ── Forward ──────────────────────────────────────────────────────────────
    forwardRequest(req, res, session.userId, session.email);
    // Status is logged after the response finishes (pipe ends)
    res.on('finish', () => log(method, rawUrl, res.statusCode, start));
  } catch (err) {
    console.error('[proxy] unhandled error:', err);
    if (!res.headersSent) {
      sendHtml(res, 500, '<h1>500 Internal Server Error</h1>');
    }
    log(method, rawUrl, res.statusCode, start);
  }
}

// ── WebSocket upgrade handler ─────────────────────────────────────────────────

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> {
  const start = Date.now();
  const rawUrl = req.url ?? '/';

  try {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.get('__ssc_session');
    const session = sid ? sessions.get(sid) : undefined;

    if (!session) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nX-SSC-Proxy: 1\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      log('UPGRADE', rawUrl, 401, start);
      return;
    }

    const { allowed, deleteSession } = await access.check(session.userId);
    if (!allowed) {
      if (deleteSession && sid) sessions.delete(sid);
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nX-SSC-Proxy: 1\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      log('UPGRADE', rawUrl, 401, start);
      return;
    }

    tunnelWebSocket(req, socket, head, session.userId, session.email);
    log('UPGRADE', rawUrl, 101, start);
  } catch (err) {
    console.error('[proxy] upgrade error:', err);
    socket.write(
      'HTTP/1.1 500 Internal Server Error\r\nX-SSC-Proxy: 1\r\nContent-Length: 0\r\n\r\n',
    );
    socket.destroy();
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(method: string, path: string, status: number, start: number): void {
  // Scrub anything that looks like a code or session from the logged path
  const safePath = path.replace(/([?&]code=)[^&]*/gi, '$1[redacted]');
  console.log(`[proxy] ${method} ${safePath} ${status} ${Date.now() - start}ms`);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[proxy] fatal handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, proxyHeaders());
      res.end();
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket as net.Socket, head).catch((err) => {
    console.error('[proxy] fatal upgrade error:', err);
    (socket as net.Socket).destroy();
  });
});

server.listen(config.LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on :${config.LISTEN_PORT}`);
});
