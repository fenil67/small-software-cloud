import { auth } from "@clerk/nextjs/server";
import type { AppAccessResponse, Deployment, App } from "./api-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

async function getToken(): Promise<string> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new Error("no_token");
  return token;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

export async function apiFetch<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const token = opts.token ?? (await getToken());
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; [k: string]: unknown };
    throw Object.assign(new Error(body.error ?? "api_error"), { status: res.status, code: body.error, body });
  }
  return res.json() as Promise<T>;
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isAppAccessResponse(val: unknown): val is AppAccessResponse {
  if (val === null || typeof val !== "object") return false;
  const v = val as Record<string, unknown>;
  return Array.isArray(v.users) && Array.isArray(v.pending);
}

export function isDeploymentArray(val: unknown): val is Deployment[] {
  return Array.isArray(val);
}

export function isAppArray(val: unknown): val is App[] {
  return Array.isArray(val);
}

export function isApp(val: unknown): val is App {
  if (val === null || typeof val !== "object") return false;
  const v = val as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string";
}
