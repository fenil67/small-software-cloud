import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  FakeApiServer,
  FakeAppServer,
  startProxy,
  type ProxyProcess,
  type ProxyEnv,
  getFreePort,
  httpRequest,
  sleep,
  buildClientWsFrame,
  parseWsFrame,
} from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Shared state: one FakeApi + FakeApp + proxy for most tests.
// A second proxy with ACCESS_CACHE_SECONDS=1 is used for cache tests.
// ─────────────────────────────────────────────────────────────────────────────

const fakeApi = new FakeApiServer();
const fakeApp = new FakeAppServer();
let proxy: ProxyProcess;
let proxyUrl: string;

const APP_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PROXY_TOKEN = 'test-proxy-token-xyz';

function makeEnv(extra: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    SSC_APP_ID: APP_ID,
    SSC_API_URL: `http://127.0.0.1:${fakeApi.port}`,
    SSC_PROXY_TOKEN: PROXY_TOKEN,
    SSC_LOGIN_URL: `http://127.0.0.1:${fakeApi.port}/login`,
    LISTEN_PORT: String(proxy?.port ?? 0), // overridden by caller
    APP_PORT: String(fakeApp.port),
    SESSION_TTL_SECONDS: '3600',
    ACCESS_CACHE_SECONDS: '60',
    ...extra,
  };
}

/** Obtain a session cookie by going through the callback flow. */
async function getSession(code = 'code-' + Math.random()): Promise<string> {
  const res = await httpRequest({
    url: `${proxyUrl}/__ssc/callback?code=${encodeURIComponent(code)}&return=/`,
  });
  assert.equal(res.status, 302);
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'Set-Cookie missing');
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sscCookie = cookies.find((c) => c.startsWith('__ssc_session='));
  assert.ok(sscCookie, '__ssc_session cookie missing');
  const value = sscCookie.split(';')[0].replace('__ssc_session=', '');
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite setup
// ─────────────────────────────────────────────────────────────────────────────

before(async () => {
  await fakeApi.start();
  await fakeApp.start();

  const listenPort = await getFreePort();
  const env: ProxyEnv = {
    SSC_APP_ID: APP_ID,
    SSC_API_URL: `http://127.0.0.1:${fakeApi.port}`,
    SSC_PROXY_TOKEN: PROXY_TOKEN,
    SSC_LOGIN_URL: `http://127.0.0.1:${fakeApi.port}/login`,
    LISTEN_PORT: String(listenPort),
    APP_PORT: String(fakeApp.port),
    SESSION_TTL_SECONDS: '3600',
    ACCESS_CACHE_SECONDS: '60',
  };

  proxy = await startProxy(env);
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
});

after(async () => {
  await proxy.stop();
  await fakeApi.stop();
  await fakeApp.stop();
});

beforeEach(() => {
  fakeApi.reset();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Health + reserved paths never forwarded
// ─────────────────────────────────────────────────────────────────────────────

describe('health', () => {
  it('GET /__ssc/health returns 200 "ok" with X-SSC-Proxy header', async () => {
    const res = await httpRequest({ url: `${proxyUrl}/__ssc/health` });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });

  it('/__ssc/ paths are never forwarded to the app', async () => {
    // After a successful health call, fakeApp.lastHeaders should not be set
    // from that call (the proxy should handle it internally).
    const appHeadersBefore = { ...fakeApp.lastHeaders };
    await httpRequest({ url: `${proxyUrl}/__ssc/health` });
    // The app's lastHeaders should be unchanged (health was served by proxy)
    assert.deepEqual(fakeApp.lastHeaders, appHeadersBefore);
  });

  it('unknown /__ssc/ path returns 404 with X-SSC-Proxy', async () => {
    const res = await httpRequest({ url: `${proxyUrl}/__ssc/unknown` });
    assert.equal(res.status, 404);
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Unauthenticated requests
// ─────────────────────────────────────────────────────────────────────────────

describe('unauthenticated', () => {
  it('HTML GET redirects to login URL with app= and encoded return=', async () => {
    const res = await httpRequest({
      url: `${proxyUrl}/some/path?q=1`,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.status, 302);
    const loc = res.headers.location ?? '';
    assert.ok(loc.includes(`app=${encodeURIComponent(APP_ID)}`), `location: ${loc}`);
    assert.ok(loc.includes('return='), `location missing return: ${loc}`);
    assert.ok(loc.includes(encodeURIComponent('/some/path?q=1')), `location: ${loc}`);
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });

  it('GET with non-HTML Accept returns 401 JSON', async () => {
    const res = await httpRequest({
      url: `${proxyUrl}/api/data`,
      headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 401);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'unauthenticated');
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });

  it('POST without session returns 401 JSON', async () => {
    const res = await httpRequest({
      method: 'POST',
      url: `${proxyUrl}/api/data`,
      headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'unauthenticated');
  });

  it('GET with no Accept header redirects (treat as HTML)', async () => {
    const res = await httpRequest({ url: `${proxyUrl}/page` });
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('login'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Callback
// ─────────────────────────────────────────────────────────────────────────────

describe('callback', () => {
  it('valid code sets session cookie with correct attributes and redirects', async () => {
    const res = await httpRequest({
      url: `${proxyUrl}/__ssc/callback?code=abc&return=/dashboard`,
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/dashboard');
    assert.equal(res.headers['x-ssc-proxy'], '1');

    const setCookie = [res.headers['set-cookie'] ?? ''].flat().join(', ');
    assert.ok(setCookie.includes('__ssc_session='), 'cookie name');
    assert.ok(setCookie.includes('HttpOnly'), 'HttpOnly');
    assert.ok(setCookie.includes('Secure'), 'Secure');
    assert.ok(setCookie.includes('SameSite=Lax'), 'SameSite=Lax');
    assert.ok(setCookie.includes('Path=/'), 'Path=/');
    assert.ok(!setCookie.includes('Domain='), 'no Domain attribute');
    assert.ok(setCookie.includes('Max-Age='), 'Max-Age present');
  });

  it('callback sends correct Authorization header to exchange endpoint', async () => {
    await httpRequest({ url: `${proxyUrl}/__ssc/callback?code=tok1&return=/` });
    assert.equal(fakeApi.receivedExchangeToken, `Bearer ${PROXY_TOKEN}`);
  });

  it('invalid code (API returns non-200) gives 401 with no session cookie', async () => {
    fakeApi.exchange = { status: 400, body: { error: 'bad code' } };
    const res = await httpRequest({
      url: `${proxyUrl}/__ssc/callback?code=bad&return=/`,
    });
    assert.equal(res.status, 401);
    const setCookie = [res.headers['set-cookie'] ?? ''].flat().join('');
    assert.ok(!setCookie.includes('__ssc_session='), 'no session cookie on failure');
  });

  it('reused code gives 401 and no new session cookie', async () => {
    // First use — succeeds
    await httpRequest({ url: `${proxyUrl}/__ssc/callback?code=once&return=/` });
    // Second use — should fail (fakeApi tracks used codes)
    const res2 = await httpRequest({
      url: `${proxyUrl}/__ssc/callback?code=once&return=/`,
    });
    assert.equal(res2.status, 401);
  });

  it('missing code gives 401', async () => {
    const res = await httpRequest({ url: `${proxyUrl}/__ssc/callback?return=/` });
    assert.equal(res.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Open-redirect protection
// ─────────────────────────────────────────────────────────────────────────────

describe('open-redirect protection', () => {
  async function callbackReturnLoc(ret: string): Promise<string> {
    const res = await httpRequest({
      url: `${proxyUrl}/__ssc/callback?code=r-${Math.random()}&return=${encodeURIComponent(ret)}`,
    });
    return res.headers.location ?? '';
  }

  it('//evil.com is redirected to /', async () => {
    assert.equal(await callbackReturnLoc('//evil.com'), '/');
  });

  it('https://evil.com is redirected to /', async () => {
    assert.equal(await callbackReturnLoc('https://evil.com'), '/');
  });

  it('/\\evil.com is redirected to /', async () => {
    assert.equal(await callbackReturnLoc('/\\evil.com'), '/');
  });

  it('path with %0d%0a (CRLF injection) is redirected to /', async () => {
    assert.equal(await callbackReturnLoc('/%0d%0aSet-Cookie:x'), '/');
  });

  it('3000-character path is redirected to /', async () => {
    assert.equal(await callbackReturnLoc('/' + 'a'.repeat(3000)), '/');
  });

  it('valid path /foo/bar is preserved', async () => {
    assert.equal(await callbackReturnLoc('/foo/bar'), '/foo/bar');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Forwarding: header rewriting
// ─────────────────────────────────────────────────────────────────────────────

describe('forwarding', () => {
  it('app never sees __ssc_session cookie; other cookies survive', async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/echo`,
      headers: {
        Cookie: `__ssc_session=${sid}; other_cookie=hello`,
      },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { headers: Record<string, string> };
    const fwdCookie = body.headers.cookie ?? '';
    assert.ok(!fwdCookie.includes('__ssc_session'), 'session cookie stripped');
    assert.ok(fwdCookie.includes('other_cookie=hello'), 'other cookie preserved');
  });

  it('spoofed x-ssc-* headers are stripped before forwarding', async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/echo`,
      headers: {
        Cookie: `__ssc_session=${sid}`,
        'X-SSC-User-Id': 'evil-spoof',
        'x-ssc-custom': 'spoof',
      },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { headers: Record<string, string> };
    assert.equal(body.headers['x-ssc-user-id'], 'user-abc');
    assert.ok(!body.headers['x-ssc-custom'], 'spoofed header stripped');
  });

  it('X-SSC-User-Id and X-SSC-User-Email are set from the session', async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/echo`,
      headers: { Cookie: `__ssc_session=${sid}` },
    });
    const body = JSON.parse(res.body) as { headers: Record<string, string> };
    assert.equal(body.headers['x-ssc-user-id'], 'user-abc');
    assert.equal(body.headers['x-ssc-user-email'], 'alice@example.com');
  });

  it('forwarded response carries X-SSC-Proxy: 1', async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/echo`,
      headers: { Cookie: `__ssc_session=${sid}` },
    });
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });

  it("app's Set-Cookie for __ssc_session is stripped from response", async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/set-ssc-cookie`,
      headers: { Cookie: `__ssc_session=${sid}` },
    });
    const setCookieHeader = [res.headers['set-cookie'] ?? []].flat();
    const hasSessionCookie = setCookieHeader.some((c) =>
      c.startsWith('__ssc_session='),
    );
    assert.ok(!hasSessionCookie, `__ssc_session should be stripped: ${setCookieHeader}`);
    // 'other' cookie should survive
    const hasOther = setCookieHeader.some((c) => c.startsWith('other='));
    assert.ok(hasOther, 'other cookie should survive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Access revocation + cache
// ─────────────────────────────────────────────────────────────────────────────

describe('access revocation (short TTL proxy)', () => {
  let shortProxy: ProxyProcess;
  let shortUrl: string;
  let shortApi: FakeApiServer;
  let shortApp: FakeAppServer;

  before(async () => {
    shortApi = new FakeApiServer();
    shortApp = new FakeAppServer();
    await shortApi.start();
    await shortApp.start();

    const port = await getFreePort();
    shortProxy = await startProxy({
      SSC_APP_ID: APP_ID,
      SSC_API_URL: `http://127.0.0.1:${shortApi.port}`,
      SSC_PROXY_TOKEN: PROXY_TOKEN,
      SSC_LOGIN_URL: `http://127.0.0.1:${shortApi.port}/login`,
      LISTEN_PORT: String(port),
      APP_PORT: String(shortApp.port),
      SESSION_TTL_SECONDS: '3600',
      ACCESS_CACHE_SECONDS: '1', // 1 second TTL for fast testing
    });
    shortUrl = `http://127.0.0.1:${shortProxy.port}`;
  });

  after(async () => {
    await shortProxy.stop();
    await shortApi.stop();
    await shortApp.stop();
  });

  it('within cache window: API called once even on multiple requests', async () => {
    shortApi.reset();
    const sid = await (async () => {
      const res = await httpRequest({
        url: `${shortUrl}/__ssc/callback?code=c1&return=/`,
      });
      const sc = [res.headers['set-cookie'] ?? ''].flat().find(c => c.startsWith('__ssc_session='))!;
      return sc.split(';')[0].replace('__ssc_session=', '');
    })();

    shortApi.accessCallCount = 0;
    // Two requests within the 1s window
    await httpRequest({ url: `${shortUrl}/`, headers: { Cookie: `__ssc_session=${sid}` } });
    await httpRequest({ url: `${shortUrl}/`, headers: { Cookie: `__ssc_session=${sid}` } });
    assert.equal(shortApi.accessCallCount, 1, 'API should be called once within cache TTL');
  });

  it('after cache expires and API returns denied, session is removed', async () => {
    shortApi.reset();
    const sid = await (async () => {
      const res = await httpRequest({
        url: `${shortUrl}/__ssc/callback?code=c2&return=/`,
      });
      const sc = [res.headers['set-cookie'] ?? ''].flat().find(c => c.startsWith('__ssc_session='))!;
      return sc.split(';')[0].replace('__ssc_session=', '');
    })();

    // First request — allowed, caches the result
    const r1 = await httpRequest({ url: `${shortUrl}/`, headers: { Cookie: `__ssc_session=${sid}` } });
    assert.equal(r1.status, 200);

    // Switch API to deny
    shortApi.accessState = { status: 200, body: { allowed: false }, reachable: true };

    // Wait for cache to expire (> 1s)
    await sleep(1200);

    // Next request — cache expired, API returns denied → 302 or 401
    const r2 = await httpRequest({ url: `${shortUrl}/`, headers: { Cookie: `__ssc_session=${sid}`, Accept: 'text/html' } });
    assert.ok(r2.status === 302 || r2.status === 401, `expected redirect or 401, got ${r2.status}`);

    // Session should be gone: even with API back to allowed, old session is dead
    shortApi.accessState = { status: 200, body: { allowed: true }, reachable: true };
    const r3 = await httpRequest({ url: `${shortUrl}/`, headers: { Cookie: `__ssc_session=${sid}`, Accept: 'text/html' } });
    assert.equal(r3.status, 302, 'session should be gone after revocation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Fail closed: API unreachable with no cache
// ─────────────────────────────────────────────────────────────────────────────

describe('fail closed', () => {
  let fcProxy: ProxyProcess;
  let fcUrl: string;
  let fcApi: FakeApiServer;
  let fcApp: FakeAppServer;

  before(async () => {
    fcApi = new FakeApiServer();
    fcApp = new FakeAppServer();
    await fcApi.start();
    await fcApp.start();

    const port = await getFreePort();
    fcProxy = await startProxy({
      SSC_APP_ID: APP_ID,
      SSC_API_URL: `http://127.0.0.1:${fcApi.port}`,
      SSC_PROXY_TOKEN: PROXY_TOKEN,
      SSC_LOGIN_URL: `http://127.0.0.1:${fcApi.port}/login`,
      LISTEN_PORT: String(port),
      APP_PORT: String(fcApp.port),
      SESSION_TTL_SECONDS: '3600',
      ACCESS_CACHE_SECONDS: '1',
    });
    fcUrl = `http://127.0.0.1:${fcProxy.port}`;
  });

  after(async () => {
    await fcProxy.stop();
    await fcApi.stop();
    await fcApp.stop();
  });

  it('API unreachable with nothing cached → denied (fail closed)', async () => {
    fcApi.reset();
    const sid = await (async () => {
      const res = await httpRequest({
        url: `${fcUrl}/__ssc/callback?code=fc1&return=/`,
      });
      const sc = [res.headers['set-cookie'] ?? ''].flat().find(c => c.startsWith('__ssc_session='))!;
      return sc.split(';')[0].replace('__ssc_session=', '');
    })();

    // Make API unreachable before any access check is cached
    fcApi.accessState = { status: 200, body: { allowed: true }, reachable: false };
    // Wait for 1s cache TTL to pass (so there's definitely no fresh cache)
    await sleep(1200);

    const res = await httpRequest({
      url: `${fcUrl}/`,
      headers: { Cookie: `__ssc_session=${sid}`, Accept: 'application/json' },
    });
    assert.ok(res.status === 401 || res.status === 302, `expected denied, got ${res.status}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('streaming', () => {
  it('first chunk arrives before response ends (no buffering)', async () => {
    const sid = await getSession();

    // Use a raw socket so we can read chunks as they arrive
    const chunks: Buffer[] = [];
    let firstChunkTime = 0;
    let endTime = 0;

    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(proxy.port, '127.0.0.1', () => {
        const req =
          `GET /stream HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Cookie: __ssc_session=${sid}\r\n` +
          `Connection: close\r\n` +
          `\r\n`;
        sock.write(req);
      });
      sock.on('data', (d: Buffer) => {
        if (firstChunkTime === 0) firstChunkTime = Date.now();
        chunks.push(d);
      });
      sock.on('end', () => { endTime = Date.now(); resolve(); });
      sock.on('error', reject);
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('stream timeout')); });
    });

    const full = Buffer.concat(chunks).toString();
    // Parse the response body (after the headers)
    const bodyStart = full.indexOf('\r\n\r\n');
    assert.ok(bodyStart >= 0, 'HTTP response has headers');
    // Should contain chunk0
    assert.ok(full.includes('chunk0'), 'chunk0 received');
    // The total time from first chunk to end should be > 50ms (the app sends 3 chunks with 50ms delay)
    assert.ok(endTime - firstChunkTime >= 50, 'response arrived incrementally');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. WebSocket
// ─────────────────────────────────────────────────────────────────────────────

describe('websocket', () => {
  it('upgrade without session is refused with 401', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection(proxy.port, '127.0.0.1', () => {
        sock.write(
          `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
        );
      });
      let data = '';
      sock.on('data', (d: Buffer) => { data += d.toString(); sock.destroy(); });
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
      sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('ws timeout')); });
    });
    assert.ok(response.includes('401'), `expected 401, got: ${response.slice(0, 200)}`);
    assert.ok(response.includes('X-SSC-Proxy: 1'), 'missing X-SSC-Proxy header');
  });

  it('upgrade with valid session tunnels and messages round-trip', async () => {
    const sid = await getSession();

    const result = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection(proxy.port, '127.0.0.1', () => {
        sock.write(
          `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Cookie: __ssc_session=${sid}\r\n` +
          `\r\n`,
        );
      });

      let gotUpgrade = false;
      let received = '';

      sock.on('data', (d: Buffer) => {
        if (!gotUpgrade) {
          const str = d.toString();
          if (str.includes('101')) {
            gotUpgrade = true;
            // Send a masked text frame with "hello"
            sock.write(buildClientWsFrame('hello'));
          }
          return;
        }
        // Parse incoming frame
        const frame = parseWsFrame(d);
        if (frame) {
          received = frame.payload.toString('utf8');
          sock.destroy();
        }
      });
      sock.on('close', () => resolve(received));
      sock.on('error', reject);
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('ws timeout')); });
    });

    assert.equal(result, 'hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Logout
// ─────────────────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('logout expires the cookie and redirects to /', async () => {
    const sid = await getSession();
    const res = await httpRequest({
      url: `${proxyUrl}/__ssc/logout`,
      headers: { Cookie: `__ssc_session=${sid}` },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
    const setCookie = [res.headers['set-cookie'] ?? ''].flat().join(' ');
    assert.ok(setCookie.includes('Max-Age=0'), 'cookie expired');
    assert.equal(res.headers['x-ssc-proxy'], '1');
  });

  it('after logout the session is invalid', async () => {
    const sid = await getSession();
    await httpRequest({
      url: `${proxyUrl}/__ssc/logout`,
      headers: { Cookie: `__ssc_session=${sid}` },
    });
    const res = await httpRequest({
      url: `${proxyUrl}/`,
      headers: { Cookie: `__ssc_session=${sid}`, Accept: 'text/html' },
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.location?.includes('login'));
  });
});
