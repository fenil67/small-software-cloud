import http from 'node:http';
import https from 'node:https';

interface CacheEntry {
  allowed: boolean;
  cachedAt: number;
}

export interface AccessResult {
  allowed: boolean;
  deleteSession: boolean;
}

function apiGet(
  urlStr: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('access check timeout')));
    req.end();
  });
}

export class AccessCache {
  private cache = new Map<string, CacheEntry>();
  // Extra grace period when API is unreachable: 5 minutes beyond normal TTL
  private static readonly STALE_GRACE_MS = 5 * 60 * 1000;

  constructor(
    private ttlSeconds: number,
    private apiUrl: string,
    private token: string,
  ) {}

  async check(userId: string): Promise<AccessResult> {
    const ttlMs = this.ttlSeconds * 1000;
    const now = Date.now();
    const cached = this.cache.get(userId);

    // Within normal TTL — return cached result without calling API
    if (cached && now - cached.cachedAt < ttlMs) {
      return { allowed: cached.allowed, deleteSession: !cached.allowed };
    }

    // TTL expired (or no cache) — make a fresh API call
    try {
      const url = `${this.apiUrl}/v1/proxy/access?user_id=${encodeURIComponent(userId)}`;
      const result = await apiGet(url, this.token);

      if (result.status === 200) {
        let parsed: { allowed?: boolean } = {};
        try { parsed = JSON.parse(result.body) as { allowed?: boolean }; } catch { /* */ }
        if (parsed.allowed === true) {
          this.cache.set(userId, { allowed: true, cachedAt: now });
          return { allowed: true, deleteSession: false };
        }
        // 200 with allowed:false
        this.cache.delete(userId);
        return { allowed: false, deleteSession: true };
      }

      // Definite denial codes
      if (result.status === 401 || result.status === 403 || result.status === 404) {
        this.cache.delete(userId);
        return { allowed: false, deleteSession: true };
      }

      // Other status (5xx etc.) — treat as unreachable
      return this.unreachable(cached, now, ttlMs);
    } catch {
      return this.unreachable(cached, now, ttlMs);
    }
  }

  private unreachable(
    cached: CacheEntry | undefined,
    now: number,
    ttlMs: number,
  ): AccessResult {
    // Use stale "allowed" for up to 5 extra minutes (fail open briefly, then closed)
    if (
      cached &&
      cached.allowed &&
      now - cached.cachedAt < ttlMs + AccessCache.STALE_GRACE_MS
    ) {
      return { allowed: true, deleteSession: false };
    }
    return { allowed: false, deleteSession: true };
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
