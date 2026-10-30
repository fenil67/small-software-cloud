import axios, { AxiosInstance } from "axios";
import type { SscConfig } from "./config";

export function makeAxios(config: SscConfig): AxiosInstance {
  return axios.create({
    baseURL: config.apiUrl,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });
}

/** Extracts a user-facing message from an Axios error, including the server error code. */
export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as Record<string, unknown> | undefined;
    const code = typeof body?.error === "string" ? body.error : null;
    const msg = typeof body?.message === "string" ? body.message : null;
    // Surface both code and message when available, e.g.:
    //   "An app named 'foo' already exists. (name_taken)"
    if (code && msg) return `${msg} (${code})`;
    if (msg) return msg;
    if (code) return code;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
