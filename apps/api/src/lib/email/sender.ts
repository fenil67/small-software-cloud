/**
 * Email sender interface + implementations.
 *
 * ResendSender  — production: POSTs to api.resend.com
 * MemorySender  — tests: stores sent emails in memory, supports fail mode
 *
 * The active sender is set at startup via setEmailSender().
 * Tests call setEmailSender(new MemorySender()) before the first send.
 * disableEmailSender() sets the active sender to null (simulates missing key).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /** If set, used as the reply-to address. Omitted when granter has no email. */
  replyTo?: string;
}

export interface SentEmail extends EmailMessage {
  sentAt: Date;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

// ── ResendSender ──────────────────────────────────────────────────────────────

export class ResendSender implements EmailSender {
  private readonly apiKey: string;
  private readonly fromAddress = "Utir <notifications@mail.utir.dev>";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(msg: EmailMessage): Promise<void> {
    const payload: Record<string, unknown> = {
      from: this.fromAddress,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    };
    if (msg.replyTo) {
      payload.reply_to = msg.replyTo;
    }
    const body = JSON.stringify(payload);

    const url = new URL("https://api.resend.com/emails");
    const options = {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        "Idempotency-Key": msg.idempotencyKey,
      },
    };

    await new Promise<void>((resolve, reject) => {
      const https = require("https") as typeof import("https");
      const req = https.request(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            const responseText = Buffer.concat(chunks).toString("utf8");
            reject(Object.assign(
              new Error(`Resend API error ${res.statusCode}`),
              { statusCode: res.statusCode, responseText },
            ));
          }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// ── MemorySender ──────────────────────────────────────────────────────────────

export class MemorySender implements EmailSender {
  private readonly sent: SentEmail[] = [];
  /** 0 = succeed, -1 = always fail, N > 0 = fail the next N calls then succeed */
  private failsRemaining = 0;

  /** Set fail mode: -1 = always fail, 0 = succeed, N = fail next N then succeed */
  setFailMode(n: number): void {
    this.failsRemaining = n;
  }

  async send(msg: EmailMessage): Promise<void> {
    if (this.failsRemaining === -1) {
      throw new Error("MemorySender: always-fail mode");
    }
    if (this.failsRemaining > 0) {
      this.failsRemaining--;
      throw new Error("MemorySender: forced failure");
    }
    this.sent.push({ ...msg, sentAt: new Date() });
  }

  drain(): SentEmail[] {
    return this.sent.splice(0);
  }

  peek(): SentEmail[] {
    return [...this.sent];
  }
}

// ── Active sender (singleton) ─────────────────────────────────────────────────

let _activeSender: EmailSender | null = null;

export function setEmailSender(sender: EmailSender): void {
  _activeSender = sender;
}

export function disableEmailSender(): void {
  _activeSender = null;
}

export function getEmailSender(): EmailSender | null {
  return _activeSender;
}
