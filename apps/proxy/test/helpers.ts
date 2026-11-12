import http from 'node:http';
import net from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// ── Port allocation ───────────────────────────────────────────────────────────

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ── Fake API server ───────────────────────────────────────────────────────────

export interface ExchangeState {
  status: number;
  body: object;
}

export interface AccessState {
  status: number;
  body: object;
  reachable: boolean;
}

export class FakeApiServer {
  public exchange: ExchangeState = {
    status: 200,
    body: { user_id: 'user-abc', email: 'alice@example.com' },
  };
  public accessState: AccessState = {
    status: 200,
    body: { allowed: true },
    reachable: true,
  };
  public usedCodes = new Set<string>();
  public receivedExchangeToken: string | null = null;
  public receivedAccessToken: string | null = null;
  public accessCallCount = 0;

  private server: http.Server;
  public port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.accessState.reachable) {
      // Simulate network error by destroying the socket
      req.socket.destroy();
      return;
    }

    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'POST' && url.pathname === '/v1/proxy/exchange') {
        this.receivedExchangeToken = req.headers.authorization ?? null;
        let parsed: { code?: string } = {};
        try { parsed = JSON.parse(body) as { code?: string }; } catch { /* */ }

        if (parsed.code && this.usedCodes.has(parsed.code)) {
          // Reused code — deny
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'code already used' }));
          return;
        }
        if (parsed.code) this.usedCodes.add(parsed.code);

        res.writeHead(this.exchange.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.exchange.body));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/proxy/access') {
        this.receivedAccessToken = req.headers.authorization ?? null;
        this.accessCallCount++;
        res.writeHead(this.accessState.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.accessState.body));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  reset(): void {
    this.exchange = {
      status: 200,
      body: { user_id: 'user-abc', email: 'alice@example.com' },
    };
    this.accessState = { status: 200, body: { allowed: true }, reachable: true };
    this.usedCodes = new Set();
    this.receivedExchangeToken = null;
    this.receivedAccessToken = null;
    this.accessCallCount = 0;
  }
}

// ── Fake app server ───────────────────────────────────────────────────────────

export class FakeAppServer {
  private server: http.Server;
  public port = 0;
  // Headers received on the most recent request (for assertion)
  public lastHeaders: http.IncomingHttpHeaders = {};

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // WebSocket upgrade: echo each frame back
    this.server.on('upgrade', (req, socket) => {
      this.lastHeaders = req.headers;
      // Send 101 Switching Protocols
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'] ?? '')}\r\n` +
        `\r\n`,
      );
      // Echo each received frame back unmasked
      socket.on('data', (data: Buffer) => {
        const frame = parseWsFrame(data);
        if (frame) {
          socket.write(buildWsFrame(frame.payload));
        }
      });
      socket.on('error', () => { /* ignore */ });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.lastHeaders = req.headers;
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Slow streaming endpoint: sends "chunk\n" every 50ms, 3 times
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      let n = 0;
      const send = () => {
        if (n >= 3) { res.end(); return; }
        res.write(`chunk${n}\n`);
        n++;
        setTimeout(send, 50);
      };
      send();
      return;
    }

    // Sets __ssc_session in Set-Cookie (should be stripped by proxy)
    if (url.pathname === '/set-ssc-cookie') {
      res.writeHead(200, {
        'Set-Cookie': [
          '__ssc_session=evil; Path=/',
          'other=ok; Path=/',
        ],
      });
      res.end('ok');
      return;
    }

    // Default: echo received headers as JSON
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, body }));
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function wsAccept(key: string): string {
  // The key needs to be combined with the magic string and SHA-1'd.
  // We use node:crypto for this.
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  return createHash('sha1').update(key + MAGIC).digest('base64');
}

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

export function parseWsFrame(data: Buffer): WsFrame | null {
  if (data.length < 2) return null;
  const opcode = data[0] & 0x0f;
  const masked = (data[1] & 0x80) !== 0;
  let payloadLen = data[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { payloadLen = data.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(data.readBigUInt64BE(2)); offset = 10; }
  if (data.length < offset + (masked ? 4 : 0) + payloadLen) return null;
  let payload: Buffer;
  if (masked) {
    const mask = data.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = data[offset + i] ^ mask[i % 4];
    }
  } else {
    payload = data.slice(offset, offset + payloadLen);
  }
  return { opcode, payload };
}

/** Build an unmasked text frame. */
export function buildWsFrame(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/** Build a masked client frame. */
export function buildClientWsFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  const header = Buffer.from([0x81, 0x80 | data.length]);
  return Buffer.concat([header, mask, masked]);
}

// ── Proxy process ─────────────────────────────────────────────────────────────

export interface ProxyEnv {
  SSC_APP_ID: string;
  SSC_API_URL: string;
  SSC_PROXY_TOKEN: string;
  SSC_LOGIN_URL: string;
  LISTEN_PORT: string;
  APP_PORT: string;
  SESSION_TTL_SECONDS?: string;
  ACCESS_CACHE_SECONDS?: string;
}

export interface ProxyProcess {
  port: number;
  stop(): Promise<void>;
}

export async function startProxy(env: ProxyEnv): Promise<ProxyProcess> {
  // __dirname at runtime is dist/test/; the compiled entry is dist/src/index.js
  const entryPoint = join(__dirname, '..', 'src', 'index.js');

  const proc: ChildProcess = spawn(process.execPath, [entryPoint], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (d: Buffer) => {
    if (process.env.PROXY_LOG) process.stdout.write(d);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    if (process.env.PROXY_LOG) process.stderr.write(d);
  });

  // Wait for the health endpoint to respond
  const port = parseInt(env.LISTEN_PORT, 10);
  await waitForHealth(port, 5000);

  return {
    port,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        // Force-kill after 2s
        setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000);
      });
    },
  };
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await httpGetStatus(`http://127.0.0.1:${port}/__ssc/health`);
      if (status === 200) return;
    } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error(`Proxy on :${port} did not become healthy within ${timeoutMs}ms`);
}

function httpGetStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTTP request helper ───────────────────────────────────────────────────────

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function httpRequest(options: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  followRedirects?: false;
}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    };
    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
