"use client";

import { useSession, useSessionList, useClerk } from "@clerk/nextjs";

// Clerk's useSessionList returns SessionResource[] whose TS type omits
// the runtime latestActivity / revoke members; we cast to this minimal shape.
interface SessionItem {
  id: string;
  status: string;
  lastActiveAt: Date | null;
  latestActivity: {
    browserName?: string | null;
    isMobile?: boolean;
    deviceType?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
  revoke(): Promise<unknown>;
}
type ActiveSessionResource = SessionItem & { status: "active" };

// ── Style primitives ──────────────────────────────────────────────────────────

const S = {
  section: { display: "flex", flexDirection: "column", gap: "16px" } as React.CSSProperties,
  h2: { margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 } as React.CSSProperties,
  card: {
    padding: "16px",
    borderRadius: "10px",
    border: "1px solid var(--line)",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column",
    gap: "0",
  } as React.CSSProperties,
};

function ghostBtn(overrides?: React.CSSProperties): React.CSSProperties {
  return {
    height: "30px",
    padding: "0 10px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--fg-3)",
    fontSize: "12px",
    cursor: "pointer",
    flexShrink: 0,
    ...overrides,
  };
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "Unknown";
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000)      return "Just now";
  if (diff < 3_600_000)   return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function deviceLabel(session: ActiveSessionResource): string {
  const a = session.latestActivity;
  if (!a) return "Unknown device";
  const browser = a.browserName ?? "Unknown browser";
  const device  = a.isMobile ? "Mobile" : (a.deviceType ?? "Desktop");
  return `${browser} · ${device}`;
}

function locationLabel(session: ActiveSessionResource): string {
  const a = session.latestActivity;
  if (!a) return "";
  if (a.city && a.country) return `${a.city}, ${a.country}`;
  if (a.country) return a.country;
  return "";
}

// ── Main component ────────────────────────────────────────────────────────────

export function ActiveSessionsSection() {
  const { session: currentSession } = useSession();
  const { sessions, isLoaded } = useSessionList();
  const { signOut } = useClerk();

  if (!isLoaded) return null;

  const activeSessions = ((sessions ?? []) as unknown as SessionItem[]).filter(
    (s): s is ActiveSessionResource => s.status === "active",
  );

  const otherSessions = activeSessions.filter(
    (s) => s.id !== currentSession?.id,
  );

  async function revokeSession(session: ActiveSessionResource) {
    await session.revoke();
  }

  async function revokeAllOthers() {
    await Promise.all(otherSessions.map((s) => s.revoke()));
  }

  return (
    <section aria-labelledby="sessions-h" style={S.section}>
      <h2 id="sessions-h" style={S.h2}>Active sessions</h2>

      <div style={S.card}>
        {activeSessions.length === 0 && (
          <p style={{ margin: 0, padding: "12px 0", fontSize: "13px", color: "var(--fg-3)" }}>
            No active sessions found.
          </p>
        )}

        {activeSessions.map((session, i) => {
          const isCurrent = session.id === currentSession?.id;
          const isLast = i === activeSessions.length - 1;

          return (
            <div
              key={session.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "16px",
                padding: "12px 0",
                borderBottom: isLast ? "none" : "1px solid var(--line)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--fg)" }}>
                    {deviceLabel(session)}
                  </span>
                  {isCurrent && (
                    <span style={{
                      display: "inline-block",
                      padding: "1px 8px",
                      borderRadius: "999px",
                      background: "var(--green)",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 500,
                    }}>
                      This device
                    </span>
                  )}
                </div>
                {locationLabel(session) && (
                  <span style={{ fontSize: "12px", color: "var(--fg-3)" }}>
                    {locationLabel(session)}
                  </span>
                )}
                <span style={{ fontSize: "12px", color: "var(--fg-3)" }}>
                  Last active {formatDate(session.lastActiveAt)}
                </span>
              </div>

              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => revokeSession(session)}
                  style={ghostBtn({ color: "var(--red)", borderColor: "var(--red)" })}
                  aria-label="Sign out this session"
                >
                  Sign out
                </button>
              )}
            </div>
          );
        })}

        {otherSessions.length > 1 && (
          <>
            <hr style={{ margin: "4px 0 0", border: 0, borderTop: "1px solid var(--line)" }} />
            <div style={{ paddingTop: "12px" }}>
              <button
                type="button"
                onClick={revokeAllOthers}
                style={ghostBtn({ color: "var(--red)", borderColor: "var(--red)", height: "34px", padding: "0 14px", fontSize: "13px" })}
              >
                Sign out of all other devices
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
