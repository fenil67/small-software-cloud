"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import type { AdminStats, AdminApp } from "../../../lib/api-types";
import { ErrorCard } from "../../../components/dashboard/ErrorCard";
import { AppStatusBadge } from "../../../components/dashboard/AppStatusBadge";
import { resolveAppStatus } from "../../../lib/status";
import type { DeployStatus } from "../../../lib/api-types";

interface AdminOverviewClientProps {
  stats: AdminStats | null;
  apps: AdminApp[];
  statsError: string | null;
  appsError: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}

function fmtBytes(n: number | null): string {
  if (n === null) return "Not available";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function alertKindLabel(kind: string): string {
  const map: Record<string, string> = {
    opened_without_auth: "App opened without sign in",
    unreachable: "App is not answering",
    metrics_unavailable: "CPU and traffic numbers unavailable",
  };
  return map[kind] ?? kind;
}

interface StatCardProps {
  value: number;
  label: string;
  sub: string;
  subColor?: string;
}

function StatCard({ value, label, sub, subColor }: StatCardProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "16px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      <span style={{ fontSize: "13px", color: "var(--fg-2)" }}>{label}</span>
      <span style={{ fontSize: "28px", fontWeight: 600, color: "var(--fg)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
      <span style={{ fontSize: "12px", color: subColor ? `var(${subColor})` : "var(--fg-3)" }}>{sub}</span>
    </div>
  );
}

export function AdminOverviewClient({ stats, apps, statsError, appsError }: AdminOverviewClientProps) {
  const router = useRouter();
  const { getToken } = useAuth();

  const [suspendingId, setSuspendingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleUnsuspend(appId: string) {
    if (confirmId !== appId) {
      setConfirmId(appId);
      return;
    }
    setConfirmId(null);
    setSuspendingId(appId);
    setActionError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/v1/admin/apps/${appId}/unsuspend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) setActionError("Could not unsuspend app.");
      else router.refresh();
    } catch {
      setActionError("Could not unsuspend app.");
    } finally {
      setSuspendingId(null);
    }
  }

  async function handleSuspend(appId: string, reason: string) {
    if (confirmId !== appId) {
      setConfirmId(appId);
      return;
    }
    setConfirmId(null);
    setSuspendingId(appId);
    setActionError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/v1/admin/apps/${appId}/suspend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) setActionError("Could not suspend app.");
      else router.refresh();
    } catch {
      setActionError("Could not suspend app.");
    } finally {
      setSuspendingId(null);
    }
  }

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "1200px" }}>
      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{ fontSize: "30px", fontWeight: 600, color: "var(--fg)", margin: 0, marginBottom: "8px" }}>
          Overview
        </h1>
        <p style={{ fontSize: "14px", color: "var(--fg-2)", margin: 0 }}>
          Every person, workspace and app on Utir.
        </p>
        {stats?.watchdog && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "12px",
              background: "var(--surface-2)",
              padding: "6px 12px",
              borderRadius: "999px",
              fontSize: "13px",
              color: "var(--fg-2)",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "999px",
                background: "var(--green)",
                animation: "pulse 2s infinite",
              }}
            />
            Watchdog checked {stats.watchdog.apps_checked} apps, {timeAgo(stats.watchdog.last_checked_at)}
          </div>
        )}
      </div>

      {/* Stat cards */}
      {statsError ? (
        <ErrorCard message={statsError} />
      ) : stats ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "16px",
            marginBottom: "40px",
          }}
        >
          <StatCard
            value={stats.people}
            label="People"
            sub={`${stats.people_joined_this_week} joined this week`}
          />
          <StatCard
            value={stats.workspaces}
            label="Workspaces"
            sub={`${stats.workspaces_with_teammates} with teammates`}
          />
          <StatCard
            value={stats.apps.total}
            label="Apps"
            sub={`${stats.apps.live} live · ${stats.apps.suspended} suspended`}
          />
          <StatCard
            value={stats.deploys_today.total}
            label="Deploys today"
            sub={`${stats.deploys_today.failed} failed`}
            subColor={stats.deploys_today.failed > 0 ? "--red" : undefined}
          />
          <StatCard
            value={stats.visits_today}
            label="App visits today"
            sub={`${stats.refused_today} refused at the door`}
          />
        </div>
      ) : null}

      {/* Open alerts */}
      {stats && stats.open_alerts.length > 0 && (
        <section aria-labelledby="open-alerts-heading" style={{ marginBottom: "40px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "16px" }}>
            <h2 id="open-alerts-heading" style={{ fontSize: "18px", fontWeight: 600, color: "var(--fg)", margin: 0 }}>
              Open alerts
            </h2>
            {stats.discord_configured && (
              <span style={{ fontSize: "12px", color: "var(--fg-3)" }}>Also sent to Discord</span>
            )}
            {stats.email_sending_configured && (
              <span style={{ fontSize: "12px", color: "var(--fg-3)" }}>Email sending on</span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {stats.open_alerts.map((alert) => {
              const isSuspended = apps.some((a) => a.id === alert.app_id && a.suspended);
              return (
                <div
                  key={alert.id}
                  style={{
                    background: "var(--surface-2)",
                    borderRadius: "10px",
                    padding: "16px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "12px",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "999px",
                      background:
                        alert.kind === "opened_without_auth"
                          ? "var(--red)"
                          : alert.kind === "unreachable"
                          ? "var(--orange)"
                          : "var(--fg-3)",
                      marginTop: "6px",
                      flex: "none",
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--fg)", marginBottom: "4px" }}>
                      {alertKindLabel(alert.kind)}
                    </div>
                    {alert.app_name && (
                      <div style={{ fontSize: "13px", color: "var(--fg-2)" }}>
                        {alert.app_name}
                        {alert.owner_email && ` · ${alert.owner_email}`}
                      </div>
                    )}
                    <div style={{ fontSize: "12px", color: "var(--fg-3)", marginTop: "4px" }}>
                      {timeAgo(alert.created_at)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    {alert.app_id && (
                      <a
                        href={`/apps/${alert.app_id}`}
                        style={{
                          fontSize: "13px",
                          color: "var(--fg-2)",
                          textDecoration: "none",
                          padding: "4px 10px",
                          border: "1px solid var(--line-strong)",
                          borderRadius: "8px",
                        }}
                      >
                        Review
                      </a>
                    )}
                    {alert.app_id && isSuspended && (
                      <button
                        type="button"
                        disabled={suspendingId === alert.app_id}
                        onClick={() => handleUnsuspend(alert.app_id!)}
                        style={{
                          fontSize: "13px",
                          color: "var(--fg)",
                          background: "var(--surface-3)",
                          border: "none",
                          borderRadius: "8px",
                          padding: "4px 10px",
                          cursor: "pointer",
                          outline: "none",
                        }}
                      >
                        {confirmId === alert.app_id ? "Confirm?" : suspendingId === alert.app_id ? "Unsuspending..." : "Unsuspend"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Deploy bar chart */}
      {stats?.deploy_series && (
        <section aria-labelledby="deploy-chart-heading" style={{ marginBottom: "40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" }}>
            <h2 id="deploy-chart-heading" style={{ fontSize: "18px", fontWeight: 600, color: "var(--fg)", margin: 0 }}>
              Deploys, last 14 days
            </h2>
            <div style={{ display: "flex", gap: "12px", fontSize: "12px", color: "var(--fg-3)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: "var(--chart)", display: "inline-block" }} />
                Success
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: "var(--red)", display: "inline-block" }} />
                Failed
              </span>
            </div>
          </div>
          {stats.deploy_series.every((d) => d.succeeded === 0 && d.failed === 0) ? (
            <p style={{ fontSize: "14px", color: "var(--fg-3)" }}>No deploys in the last 14 days.</p>
          ) : (
            <DeployBarChart series={stats.deploy_series} />
          )}
        </section>
      )}

      {/* Apps table */}
      {appsError ? (
        <ErrorCard message={appsError} />
      ) : (
        <section aria-labelledby="apps-table-heading" style={{ marginBottom: "40px" }}>
          <h2 id="apps-table-heading" style={{ fontSize: "18px", fontWeight: 600, color: "var(--fg)", margin: 0, marginBottom: "16px" }}>
            All apps
          </h2>
          {actionError && <ErrorCard message={actionError} />}
          {apps.length === 0 ? (
            <p style={{ fontSize: "14px", color: "var(--fg-3)" }}>No apps yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{ width: "100%", borderCollapse: "collapse", minWidth: "800px" }}
                aria-label="All apps"
              >
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    {["App", "Owner", "Status", "CPU, last 30 min", "Traffic out, 24 h", "Last visit", "Actions"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          fontSize: "12px",
                          fontWeight: 500,
                          color: "var(--fg-3)",
                          padding: "10px 12px",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {apps.map((app) => (
                    <tr key={app.id} style={{ borderBottom: "1px solid var(--line)" }}>
                      <td style={{ padding: "12px", fontSize: "14px", color: "var(--fg)", fontWeight: 500 }}>
                        {app.name}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: "var(--fg-2)" }}>
                        {app.owner_email ?? "—"}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <AppStatusBadge
                          status={resolveAppStatus(
                            app.suspended,
                            "running",
                            app.latest_deployment_status as DeployStatus | null,
                          )}
                        />
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: app.cpu_pct !== null ? "var(--fg)" : "var(--fg-3)" }}>
                        {app.cpu_pct !== null ? `${app.cpu_pct}%` : "Not available"}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: app.traffic_bytes_24h !== null ? "var(--fg)" : "var(--fg-3)" }}>
                        {fmtBytes(app.traffic_bytes_24h)}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: "var(--fg-2)" }}>
                        {app.last_visit_at ? timeAgo(app.last_visit_at) : "Never"}
                      </td>
                      <td style={{ padding: "12px" }}>
                        {app.suspended ? (
                          <button
                            type="button"
                            disabled={suspendingId === app.id}
                            onClick={() => handleUnsuspend(app.id)}
                            style={{
                              fontSize: "13px",
                              color: "var(--fg)",
                              background: "var(--surface-3)",
                              border: "none",
                              borderRadius: "8px",
                              padding: "4px 10px",
                              cursor: "pointer",
                              outline: "none",
                            }}
                          >
                            {confirmId === app.id ? "Confirm?" : suspendingId === app.id ? "Working..." : "Unsuspend"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={suspendingId === app.id}
                            onClick={() => handleSuspend(app.id, "Suspended by admin")}
                            style={{
                              fontSize: "13px",
                              color: "var(--fg-3)",
                              background: "transparent",
                              border: "1px solid var(--line-strong)",
                              borderRadius: "8px",
                              padding: "4px 10px",
                              cursor: "pointer",
                              outline: "none",
                            }}
                          >
                            {confirmId === app.id ? "Confirm?" : "Suspend"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function fmtChartDate(isoDate: string): string {
  try {
    const [year, month, day] = isoDate.split("-").map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return isoDate;
  }
}

function DeployBarChart({ series }: { series: Array<{ date: string; succeeded: number; failed: number }> }) {
  const maxVal = Math.max(...series.map((d) => d.succeeded + d.failed), 1);
  const W = 700;
  const H = 160;
  const barW = Math.floor(W / series.length) - 2;
  const total = series.reduce((acc, d) => acc + d.succeeded + d.failed, 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        aria-label={`Deploy bar chart, ${total} deploys over 14 days`}
        role="img"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {series.map((d, i) => {
          const x = i * (W / series.length) + 1;
          const totalH = ((d.succeeded + d.failed) / maxVal) * (H - 20);
          const failH = (d.failed / maxVal) * (H - 20);
          const succH = totalH - failH;
          return (
            <g key={d.date}>
              {succH > 0 && (
                <rect
                  x={x}
                  y={H - 20 - totalH + failH}
                  width={barW}
                  height={succH}
                  fill="var(--chart)"
                  rx="2"
                />
              )}
              {failH > 0 && (
                <rect
                  x={x}
                  y={H - 20 - failH}
                  width={barW}
                  height={failH}
                  fill="var(--red)"
                  rx="2"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--fg-3)", marginTop: "4px" }}>
        <span>{series[0] ? fmtChartDate(series[0].date) : ""}</span>
        <span>{series[6] ? fmtChartDate(series[6].date) : ""}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
