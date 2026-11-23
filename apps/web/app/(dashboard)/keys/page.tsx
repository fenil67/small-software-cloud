import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type { ApiKey } from "../../../lib/api-types";
import { KeysClient } from "./KeysClient";
import { ErrorCard } from "../../../components/dashboard/ErrorCard";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const { getToken, orgRole } = await auth();
  const token = await getToken();
  if (!token) return null;

  const isAdmin = orgRole === "org:admin";

  let keys: ApiKey[] = [];
  let error: string | null = null;
  try {
    keys = await apiFetch<ApiKey[]>("/v1/api-keys", { token });
  } catch (e: unknown) {
    const status = (e as { status?: number }).status ?? 0;
    console.error(`[keys] GET /v1/api-keys failed with status ${status}`);
    error = "We could not load your API keys. Try again in a moment.";
  }

  return (
    error
      ? <ErrorCard message={error} />
      : <KeysClient keys={keys} isAdmin={isAdmin} />
  );
}
