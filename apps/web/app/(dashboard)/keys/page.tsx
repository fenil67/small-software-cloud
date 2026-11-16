import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type { ApiKey } from "../../../lib/api-types";
import { KeysClient } from "./KeysClient";

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
    } catch {
      error = "Could not load API keys.";
    }
  }

  return (
    <div style={{ padding: "32px 40px", maxWidth: "900px" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600, letterSpacing: "-0.01em" }}>
          API keys
        </h1>
      </div>

      {error ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: "14px" }}>{error}</p>
      ) : (
        <KeysClient keys={keys} isAdmin={isAdmin} />
      )}
    </div>
  );
}
