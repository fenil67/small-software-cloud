"use server";

import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type { ApiKeyCreated } from "../../../lib/api-types";

export async function createKey(
  name: string,
  scopes: string[],
): Promise<{ key?: ApiKeyCreated; error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    const key = await apiFetch<ApiKeyCreated>("/v1/api-keys", {
      method: "POST",
      body: { name: name.trim(), scopes },
      token,
    });
    return { key };
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "create_failed" };
  }
}

export async function revokeKey(
  keyId: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch(`/v1/api-keys/${keyId}`, {
      method: "DELETE",
      token,
    });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "revoke_failed" };
  }
}
