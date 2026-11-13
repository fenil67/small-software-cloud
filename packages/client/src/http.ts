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

/**
 * Like extractErrorMessage but maps sharing-endpoint status codes to canonical
 * CLI-facing strings before falling back to the generic message.
 */
export function extractSharingError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as Record<string, unknown> | undefined;
    if (status === 404) return "App not found";
    if (status === 403) return "Not allowed: org admin or an API key of the app's org is required";
    if (status === 400) {
      const msg = typeof body?.message === "string" ? body.message : null;
      if (msg) return msg;
    }
  }
  return extractErrorMessage(err);
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
