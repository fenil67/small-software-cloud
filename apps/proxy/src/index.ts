import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

// ── Hop-by-hop headers ────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Returns the set of header names that must NOT be forwarded end-to-end.
 * Includes the static hop-by-hop set plus any extra names listed in the
 * Connection header value (HTTP/1.1 §14.10).
 */
function hopByHopSet(headers: http.IncomingHttpHeaders): Set<string> {
  const result = new Set(HOP_BY_HOP);
  const conn = headers.connection;
  if (conn) {
    const val = Array.isArray(conn) ? conn.join(',') : conn;
    for (const name of val.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) result.add(trimmed);
    }
  }
  return result;
}

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

/** Extract the pathname portion (before ?) from a raw URL string. */
function getPathname(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q >= 0 ? rawUrl.slice(0, q) : rawUrl;
}

/** Extract query string from a raw URL string (without leading ?). */
function getSearch(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q >= 0 ? rawUrl.slice(q) : '';
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

/** Expire the CSRF state cookie immediately. */
const EXPIRED_STATE_COOKIE =
  `__ssc_state=; Path=/__ssc/; HttpOnly; Secure; SameSite=Lax; ` +
  `Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

function proxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-SSC-Proxy': '1', ...extra };
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string | string[]> = {},
): void {
  const headers = proxyHeaders({
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.writeHead(status, { ...headers, ...extra });
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

function send302(
  res: http.ServerResponse,
  location: string,
  extra: Record<string, string | string[]> = {},
): void {
  res.writeHead(302, { ...proxyHeaders({ Location: location }), ...extra });
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

  // Generate CSRF state: 16 random bytes as base64url
  const state = randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const rawPath = (req.url ?? '/');
  const returnParam = encodeURIComponent(rawPath);
  const loginUrl =
    `${config.LOGIN_URL}?app=${encodeURIComponent(config.APP_ID)}` +
    `&return=${returnParam}&state=${encodeURIComponent(state)}`;

  const stateCookie =
    `__ssc_state=${state}; Path=/__ssc/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

  send302(res, loginUrl, { 'Set-Cookie': stateCookie });
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
  const rawUrl = req.url ?? '/';
  const qs = getSearch(rawUrl);
  const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
  const code = params.get('code');
  const returnPath = safeReturnPath(params.get('return'));
  const stateParam = params.get('state') ?? '';

  // Always expire the state cookie, whatever the outcome
  const expireState = EXPIRED_STATE_COOKIE;

  if (!code) {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
    return;
  }

  // Verify CSRF state: must match __ssc_state cookie
  const cookies = parseCookies(req.headers.cookie);
  const stateCookie = cookies.get('__ssc_state') ?? '';

  if (!stateParam || !stateCookie) {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
    return;
  }

  // Constant-time comparison (pad to equal length)
  const a = Buffer.from(stateParam);
  const b = Buffer.from(stateCookie);
  const maxLen = Math.max(a.length, b.length);
  const aPadded = Buffer.concat([a, Buffer.alloc(maxLen - a.length)]);
  const bPadded = Buffer.concat([b, Buffer.alloc(maxLen - b.length)]);
  const stateOk = a.length === b.length && timingSafeEqual(aPadded, bPadded);

  if (!stateOk) {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
    return;
  }

  try {
    const result = await apiPost(
      `${config.API_URL}/v1/proxy/exchange`,
      config.PROXY_TOKEN,
      { code, state: stateParam },
    );

    if (result.status !== 200) {
      sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
      return;
    }

    const body = result.body as { user_id?: string; email?: string };
    if (!body.user_id || !body.email) {
      sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
      return;
    }

    const sessionId = sessions.create(body.user_id, body.email);
    const sessionCookie =
      `__ssc_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
      `Max-Age=${config.SESSION_TTL_SECONDS}`;

    // Set both cookies: expire state, set session
    send302(res, returnPath, { 'Set-Cookie': [expireState, sessionCookie] });
  } catch {
    sendHtml(res, 401, '<h1>401 Unauthorized</h1>', { 'Set-Cookie': expireState });
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
  const hbh = hopByHopSet(req.headers);
  const out: Record<string, string | string[]> = {};

  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    // Drop hop-by-hop (but keep Connection: Upgrade / Upgrade for WebSocket)
    if (hbh.has(k.toLowerCase())) continue;
    out[k] = v as string | string[];
  }

  // Strip any spoofed x-ssc-* headers
  for (const k of Object.keys(out)) {
    if (k.toLowerCase().startsWith('x-ssc-')) delete out[k];
  }

  // Rewrite Cookie: remove all __ssc_* cookies (proxy namespace)
  const cookieStr = Array.isArray(out.cookie)
    ? out.cookie.join('; ')
    : (out.cookie as string | undefined);
  if (cookieStr) {
    const jar = parseCookies(cookieStr);
    for (const name of jar.keys()) {
      if (name.toLowerCase().startsWith('__ssc_')) jar.delete(name);
    }
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

/** Returns true if a Set-Cookie header value sets a cookie whose name starts with __ssc_. */
function isSscCookie(setCookieVal: string): boolean {
  // Cookie name is the part before the first = (leading whitespace trimmed)
  const eqIdx = setCookieVal.indexOf('=');
  if (eqIdx < 0) return false;
  const name = setCookieVal.slice(0, eqIdx).trimStart();
  return name.toLowerCase().startsWith('__ssc_');
}

/** Filter response headers: drop hop-by-hop, __ssc_* Set-Cookie values, inject X-SSC-Proxy. */
function filterResponseHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  // Build the hop-by-hop set from the app's response Connection header value
  const appConn = headers.connection;
  const hbh = new Set(HOP_BY_HOP);
  if (appConn) {
    const val = Array.isArray(appConn) ? appConn.join(',') : appConn;
    for (const name of val.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) hbh.add(trimmed);
    }
  }

  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    // Drop hop-by-hop headers from the app response (Transfer-Encoding etc.)
    if (hbh.has(lk)) continue;
    if (lk === 'set-cookie') {
      const cookies = Array.isArray(v) ? v : [v as string];
      const filtered = cookies.filter((c) => !isSscCookie(c));
      if (filtered.length > 0) out[k] = filtered;
    } else {
      out[k] = v;
    }
  }
  out['x-ssc-proxy'] = '1';
  return out;
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  email: string,
): void {
  const rawUrl = req.url ?? '/';
  const fwdHeaders = buildForwardHeaders(req, userId, email);

  const appReq = http.request(
    {
      hostname: '127.0.0.1',
      port: config.APP_PORT,
      path: rawUrl,
      method: req.method,
      headers: fwdHeaders,
    },
    (appRes) => {
      const outHeaders = filterResponseHeaders(appRes.headers);
      res.writeHead(appRes.statusCode ?? 502, appRes.statusMessage, outHeaders);
      appRes.pipe(res);
      appRes.on('error', () => res.destroy());
    },
  );

  appReq.on('error', () => {
    if (!res.headersSent) {
      sendHtml(res, 502, '<h1>502 Bad Gateway</h1>');
    } else {
      res.destroy();
    }
  });

  // Propagate client abort to the upstream request
  req.on('close', () => {
    if (!req.complete) appReq.destroy();
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
  // For WebSocket, we must keep Connection and Upgrade in the forwarded request
  fwdHeaders['connection'] = 'Upgrade';
  fwdHeaders['upgrade'] = req.headers.upgrade ?? 'websocket';

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

      // Buffer the app's response head, rewrite it, then pipe the rest
      let headBuf = Buffer.alloc(0);
      let headDone = false;

      appSocket.on('data', (chunk: Buffer) => {
        if (headDone) {
          socket.write(chunk);
          return;
        }

        headBuf = Buffer.concat([headBuf, chunk]);
        const sep = headBuf.indexOf('\r\n\r\n');
        if (sep < 0) return; // still accumulating head

        headDone = true;
        const headStr = headBuf.slice(0, sep).toString('utf8');
        const rest = headBuf.slice(sep + 4);

        // Rewrite: filter __ssc_* Set-Cookie lines, inject X-SSC-Proxy: 1
        const lines = headStr.split('\r\n');
        const rewritten: string[] = [];
        let hasProxy = false;
        for (const line of lines) {
          if (/^set-cookie\s*:/i.test(line)) {
            // Extract cookie name after "set-cookie:"
            const val = line.slice(line.indexOf(':') + 1).trimStart();
            if (isSscCookie(val)) continue;
          }
          if (/^x-ssc-proxy\s*:/i.test(line)) {
            hasProxy = true;
          }
          rewritten.push(line);
        }
        if (!hasProxy) rewritten.push('X-SSC-Proxy: 1');

        socket.write(rewritten.join('\r\n') + '\r\n\r\n');
        if (rest.length > 0) socket.write(rest);

        // Now pipe bidirectionally for the data phase
        appSocket.on('data', (d: Buffer) => socket.write(d));
      });

      // Cross-close: either side closing closes the other
      socket.on('data', (d: Buffer) => appSocket.write(d));
    },
  );

  appSocket.on('error', () => {
    if (!socket.destroyed) {
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\nX-SSC-Proxy: 1\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
    }
  });

  appSocket.on('close', () => { if (!socket.destroyed) socket.destroy(); });
  socket.on('error', () => { if (!appSocket.destroyed) appSocket.destroy(); });
  socket.on('close', () => { if (!appSocket.destroyed) appSocket.destroy(); });
}

// ── Main request handler ──────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const start = Date.now();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';

  // Reject any request whose URL doesn't start with /
  if (!rawUrl.startsWith('/')) {
    sendHtml(res, 400, '<h1>400 Bad Request</h1>');
    log(method, rawUrl, 400, start);
    return;
  }

  try {
    const pathname = getPathname(rawUrl);

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
  const safePath = path
    .replace(/([?&]code=)[^&]*/gi, '$1[redacted]')
    .replace(/([?&]state=)[^&]*/gi, '$1[redacted]');
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
