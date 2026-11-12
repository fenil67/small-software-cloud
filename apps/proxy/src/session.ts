import { randomBytes } from 'node:crypto';

export interface Session {
  userId: string;
  email: string;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private ttlSeconds: number) {
    this.timer = setInterval(() => this.cleanup(), 60_000);
    // Don't hold the event loop open
    if (this.timer.unref) this.timer.unref();
  }

  create(userId: string, email: string): string {
    const id = randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    this.sessions.set(id, {
      userId,
      email,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
    return id;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(id);
    }
  }

  close(): void {
    clearInterval(this.timer);
  }
}
