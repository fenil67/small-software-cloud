import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ErrorCard } from "../../../../components/dashboard/ErrorCard";
import { apiFetch, isAppAccessResponse, isDeploymentArray } from "../../../../lib/api";
import type { App, AppAccess, AppAccessResponse } from "../../../../lib/api-types";
import type { Deployment } from "../../../../lib/api-types";
import { resolveAppStatus } from "../../../../lib/status";
import { AppStatusBadge } from "../../../../components/dashboard/AppStatusBadge";
import { AppDetailClient } from "./AppDetailClient";
import { CopyButton } from "../../../../components/dashboard/CopyButton";
import { DeploymentRow } from "./DeploymentRow";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AppDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { getToken, orgRole } = await auth();
  const token = await getToken();
  if (!token) return null;

  const isAdmin = orgRole === "org:admin";

  let app: App | null = null;
  let appError: string | null = null;
  try {
    app = await apiFetch<App>(`/v1/apps/${id}`, { token });
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 404) notFound();
    const status = (e as { status?: number }).status ?? 0;
    console.error(`[apps/${id}] GET /v1/apps/${id} failed with status ${status}`);
    appError = "We could not load this app. Try again in a moment.";
  }

  if (appError || !app) {
    return (
      <div style={{ padding: "32px 40px" }}>
        <ErrorCard message={appError ?? "We could not load this app. Try again in a moment."} />
      </div>
    );
  }

  const [rawDeployments, rawAccess] = await Promise.all([
    apiFetch<unknown>(`/v1/apps/${id}/deployments`, { token }).catch((): unknown => []),
    isAdmin
      ? apiFetch<unknown>(`/v1/apps/${id}/access`, { token }).catch((): unknown => null)
      : Promise.resolve(null),
  ]);

  let deployments: Deployment[] = [];
  if (isDeploymentArray(rawDeployments)) {
    deployments = rawDeployments;
  } else if (rawDeployments !== null) {
    console.error(`[apps/${id}] GET /v1/apps/${id}/deployments shape mismatch: expected array, got ${typeof rawDeployments}`);
  }

  let accessList: AppAccess[] = [];
  if (rawAccess !== null) {
    if (isAppAccessResponse(rawAccess)) {
      const r = rawAccess as AppAccessResponse;
      accessList = [
        ...r.users.map((u) => ({ email: u.email, display_name: null, granted_at: u.granted_at, status: "active" as const })),
        ...r.pending.map((p) => ({ email: p.email, display_name: null, granted_at: p.granted_at, status: "pending" as const })),
      ];
    } else {
      console.error(`[apps/${id}] GET /v1/apps/${id}/access shape mismatch: expected {users, pending}, got ${JSON.stringify(Object.keys(rawAccess as Record<string, unknown>))}`);
    }
  }

  const resolved = resolveAppStatus(app.suspended, app.status, app.latest_deployment_status);
  const appUrl = app.subdomain ? `https://${app.subdomain}` : null;

  return (
    <div style={{ padding: "32px 40px", maxWidth: "1100px" }}>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" style={{ marginBottom: "16px", fontSize: "13px", color: "var(--fg-3)" }}>
        <Link href="/apps" style={{ color: "var(--fg-3)", textDecoration: "none" }}>Apps</Link>
        <span style={{ margin: "0 6px" }}>/</span>
        <span style={{ color: "var(--fg)" }}>{app.name}</span>
      </nav>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", marginBottom: "24px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600, letterSpacing: "-0.01em" }}>
              {app.name}
            </h1>
            <StatusPill resolved={resolved} />
          </div>
          {appUrl && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <a
                href={appUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "14px", color: "var(--fg-2)", textDecoration: "none" }}
              >
                {appUrl}
              </a>
              <CopyButton value={appUrl} label="Copy app URL" />
            </div>
          )}
        </div>

        {appUrl && (
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                height: "36px",
                padding: "0 16px",
                borderRadius: "10px",
                background: "var(--btn-bg)",
                color: "var(--btn-fg)",
                fontSize: "13px",
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              Open app
            </a>
          </div>
        )}
      </div>

      {/* Main two-column layout */}
      <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Deployments column */}
        <div style={{ flex: "2 1 520px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Deployments</h2>
          {deployments.length === 0 ? (
            <p style={{ color: "var(--fg-3)", fontSize: "14px", margin: 0 }}>No deployments yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {deployments.map((d, i) => (
                <DeploymentRow key={d.id} deployment={d} isLatest={i === 0} />
              ))}
            </div>
          )}
        </div>

        {/* Right column */}
        <div style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Who can open it — admin only */}
          {isAdmin ? (
            <AppDetailClient
              appId={app.id}
              appName={app.name}
              accessList={accessList}
              isAdmin={isAdmin}
            />
          ) : (
            <div
              style={{
                padding: "16px",
                borderRadius: "12px",
                background: "var(--surface)",
                border: "1px solid var(--line)",
              }}
            >
              <h2 style={{ margin: "0 0 8px", fontSize: "14px", fontWeight: 600 }}>Access</h2>
              <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)" }}>
                Only admins can manage app access.
              </p>
            </div>
          )}

          {/* Delete app — admin only */}
          {isAdmin && (
            <div
              style={{
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid var(--danger-line)",
              }}
            >
              <h2 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 600, color: "var(--red)" }}>
                Delete app
              </h2>
              <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--fg-3)", lineHeight: "18px" }}>
                This permanently destroys the app and all its deployments.
              </p>
              <AppDetailClient
                appId={app.id}
                appName={app.name}
                accessList={accessList}
                isAdmin={isAdmin}
                showDeleteOnly
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ resolved }: { resolved: ReturnType<typeof resolveAppStatus> }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: "100px",
        background: "var(--surface-2)",
        fontSize: "13px",
      }}
    >
      <AppStatusBadge status={resolved} />
    </span>
  );
}

