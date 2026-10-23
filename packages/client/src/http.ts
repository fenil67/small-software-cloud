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

/** Extracts a user-facing message from an Axios error. */
export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as
      | Record<string, unknown>
      | undefined;
    const msg =
      body?.message ?? body?.error ?? err.message;
    return String(msg);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
