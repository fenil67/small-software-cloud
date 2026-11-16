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
  if (isAdmin) {
    try {
      keys = await apiFetch<ApiKey[]>("/v1/api-keys", { token });
    } catch (e: unknown) {
      const status = (e as { status?: number }).status ?? 0;
      console.error(`[keys] GET /v1/api-keys failed with status ${status}`);
      error = "We could not load your API keys. Try again in a moment.";
    }
  }

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "1200px", display: "flex", flexDirection: "column", gap: "32px" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h1 style={{ margin: 0, fontSize: "30px", lineHeight: "36px", fontWeight: 600, letterSpacing: "-0.02em" }}>
          API keys
        </h1>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
          Keys let the Utir command line and your AI assistant deploy for you.
        </p>
      </header>

      {error ? (
        <ErrorCard message={error} />
      ) : (
        <KeysClient keys={keys} isAdmin={isAdmin} />
      )}
    </div>
  );
}
