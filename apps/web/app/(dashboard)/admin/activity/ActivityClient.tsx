"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";
import type { ActivityEvent, ActivityListResponse, ActivitySummaryItem } from "../../../../lib/api-types";
import { EVENT_META, CHIP_EVENT_TYPES, simpleDevice, type EventChip } from "../../../../lib/activity-events";
import { ErrorCard } from "../../../../components/dashboard/ErrorCard";

interface ActivityClientProps {
  initialSummary: ActivitySummaryItem[];
}

type WhenOption = "today" | "7d" | "30d" | "all";

function timeAgo(iso: string): string {
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

function fmtEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
}

function getFromParam(when: WhenOption): string | null {
  const now = new Date();
  if (when === "today") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString();
  }
  if (when === "7d") {
    return new Date(Date.now() - 7 * 86_400_000).toISOString();
  }
  if (when === "30d") {
    return new Date(Date.now() - 30 * 86_400_000).toISOString();
  }
  return null;
}

export function ActivityClient({ initialSummary }: ActivityClientProps) {
  const { getToken } = useAuth();

  const [q, setQ] = useState("");
  const [when, setWhen] = useState<WhenOption>("all");
  const [chip, setChip] = useState<EventChip | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ActivityEvent | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseEmail, setEraseEmail] = useState("");
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [eraseLoading, setEraseLoading] = useState(false);
  const [eraseMessage, setEraseMessage] = useState<string | null>(null);
  const [eraseError, setEraseError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Chip counts from summary (last 7d)
  const chipCounts: Partial<Record<EventChip, number>> = {};
  for (const item of initialSummary) {
    for (const [ch, types] of Object.entries(CHIP_EVENT_TYPES) as [EventChip, string[]][]) {
      if (types.includes(item.event_type)) {
        chipCounts[ch] = (chipCounts[ch] ?? 0) + item.count_7d;
      }
    }
  }

  const buildParams = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (chip) params.set("event_type", CHIP_EVENT_TYPES[chip].join(","));
    const from = getFromParam(when);
    if (from) params.set("from", from);
    params.set("limit", "50");
    if (cursor) params.set("cursor", cursor);
    return params;
  }, [q, when, chip]);

  const fetchEvents = useCallback(async (replace: boolean) => {
    if (replace) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const token = await getToken();
      const params = replace ? buildParams() : buildParams(nextCursor ?? undefined);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ""}/v1/admin/activity?${params}`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );
      if (!res.ok) {
        setError("Could not load activity events.");
        return;
      }
      const data = (await res.json()) as ActivityListResponse;
      if (replace) {
        setEvents(data.events);
      } else {
        setEvents((prev) => [...prev, ...data.events]);
      }
      setNextCursor(data.next_cursor);
    } catch {
      setError("Could not load activity events.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [getToken, buildParams, nextCursor]);

  // Initial load and filter changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, when, chip]);

  // Live mode polling
  useEffect(() => {
    if (!liveMode) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchEvents(true);
      }
    }, 15_000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [liveMode, fetchEvents]);

  // Build export href
  const exportParams = new URLSearchParams();
  if (q.trim()) exportParams.set("q", q.trim());
  if (chip) exportParams.set("event_type", CHIP_EVENT_TYPES[chip].join(","));
  const from = getFromParam(when);
  if (from) exportParams.set("from", from);
  const exportHref = `/admin/activity/export?${exportParams}`;

  async function handleErase() {
    setEraseLoading(true);
    setEraseError(null);
    setEraseMessage(null);
    try {
      const token = await getToken();
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/v1/admin/activity/erase`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: eraseEmail }),
      });
      const data = (await res.json()) as { erased?: number; error?: string };
      if (!res.ok) {
        if (data.error === "rate_limit_exceeded" || data.error === "rate_limited") {
          setEraseError("Too many erase requests. Try again later.");
        } else if (data.error === "validation_error") {
          setEraseError("Invalid email address.");
        } else {
          setEraseError("Something went wrong. Try again.");
        }
      } else {
        setEraseMessage(`Removed ${data.erased ?? 0} events.`);
        setEraseEmail("");
        setEraseConfirm("");
      }
    } catch {
      setEraseError("Something went wrong. Try again.");
    } finally {
      setEraseLoading(false);
    }
  }

  const chips: Array<EventChip | null> = [null, "Visits", "Refused", "Deploys", "Sharing", "People", "API keys", "Watchdog", "Admin"];

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "1400px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "30px", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Activity</h1>
          <p style={{ margin: "4px 0 0", fontSize: "14px", color: "var(--fg-2)" }}>
            Every sign in, deploy, share, visit and refusal. Kept forever.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setEraseOpen(true)}
            style={{
              fontSize: "13px",
              color: "var(--red)",
              background: "transparent",
              border: "1px solid var(--red)",
              borderRadius: "8px",
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Erase a person
          </button>
          <a
            href={exportHref}
            download
            style={{
              fontSize: "13px",
              color: "var(--fg-2)",
              background: "transparent",
              border: "1px solid var(--line-strong)",
              borderRadius: "8px",
              padding: "6px 12px",
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            Export CSV
          </a>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--fg-2)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={liveMode}
              onChange={(e) => setLiveMode(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Live
          </label>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1", minWidth: "200px" }}>
          <svg aria-hidden="true" style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-3)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search events..."
            aria-label="Search activity events"
            style={{
              width: "100%",
              paddingLeft: "36px",
              padding: "8px 12px 8px 36px",
              borderRadius: "8px",
              border: "1px solid var(--line-strong)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              fontSize: "14px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
        <select
          value={when}
          onChange={(e) => setWhen(e.target.value as WhenOption)}
          aria-label="Time range"
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            border: "1px solid var(--line-strong)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            fontSize: "14px",
            cursor: "pointer",
          }}
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>

      {/* Chip filters */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "24px", flexWrap: "wrap" }} role="group" aria-label="Filter by category">
        {chips.map((c) => {
          const label = c ?? "All";
          const active = chip === c;
          const count = c ? chipCounts[c] : undefined;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={active}
              onClick={() => setChip(c)}
              style={{
                padding: "4px 12px",
                borderRadius: "999px",
                border: "1px solid var(--line-strong)",
                background: active ? "var(--fg)" : "var(--surface-2)",
                color: active ? "var(--btn-fg)" : "var(--fg-2)",
                fontSize: "13px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {label}
              {count !== undefined && count > 0 && (
                <span style={{ fontSize: "11px", color: active ? "var(--btn-fg)" : "var(--fg-3)" }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Layout: feed + detail */}
      <div style={{ display: "flex", gap: "24px", alignItems: "flex-start" }}>
        {/* Event feed */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            borderRadius: "16px",
            border: "1px solid var(--line)",
            background: "var(--surface)",
            overflow: "hidden",
          }}>
            {/* Live header */}
            <div style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "12px 20px",
              fontSize: "12px", color: "var(--fg-3)",
              background: "var(--surface-2)",
              borderBottom: "1px solid var(--line)",
            }}>
              <span aria-hidden="true" style={{ width: "6px", height: "6px", borderRadius: "999px", background: "var(--green)", flex: "none" }} />
              Live · new events appear at the top
            </div>
            {loading ? (
              <p style={{ fontSize: "14px", color: "var(--fg-3)", padding: "16px 20px", margin: 0 }}>Loading...</p>
            ) : error ? (
              <div style={{ padding: "16px 20px" }}><ErrorCard message={error} /></div>
            ) : events.length === 0 ? (
              <p style={{ fontSize: "14px", color: "var(--fg-3)", padding: "16px 20px", margin: 0 }}>No events found.</p>
            ) : (
              <ol
                aria-live="polite"
                aria-label="Activity events"
                style={{ listStyle: "none", margin: 0, padding: 0 }}
              >
                {events.map((ev) => {
                  const meta = EVENT_META[ev.event_type];
                  const isSelected = selectedEvent?.id === ev.id;
                  return (
                    <li
                      key={ev.id}
                      tabIndex={0}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelectedEvent(isSelected ? null : ev)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedEvent(isSelected ? null : ev); } }}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px 90px 1fr",
                        gap: "8px",
                        padding: "8px 12px",
                        borderRadius: "8px",
                        background: isSelected ? "var(--surface-3)" : "transparent",
                        cursor: "pointer",
                        alignItems: "baseline",
                        outline: "none",
                      }}
                    >
                      <span style={{ fontSize: "12px", color: "var(--fg-3)", fontFamily: "monospace" }}>
                        {fmtEventTime(ev.occurred_at)}
                      </span>
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: meta?.labelWeight ?? 400,
                          color: meta?.labelColor ? `var(${meta.labelColor})` : "var(--fg-2)",
                        }}
                      >
                        {meta?.label ?? ev.event_type}
                      </span>
                      <span style={{ fontSize: "14px", color: "var(--fg)" }}>
                        {meta ? meta.sentence(ev) : ev.event_type}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            {nextCursor && !loading && (
              <div style={{ padding: "12px 20px 16px" }}>
                <button
                  type="button"
                  onClick={() => { void fetchEvents(false); }}
                  disabled={loadingMore}
                  style={{
                    fontSize: "13px",
                    color: "var(--fg-2)",
                    background: "transparent",
                    border: "1px solid var(--line-strong)",
                    borderRadius: "8px",
                    padding: "8px 16px",
                    cursor: "pointer",
                  }}
                >
                  {loadingMore ? "Loading..." : "Load older events"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Event detail panel */}
        {selectedEvent && (
          <EventDetailPanel
            event={selectedEvent}
            onFilterByActor={(email) => { setQ(email); setChip(null); setSelectedEvent(null); }}
          />
        )}
      </div>

      {/* Erase dialog */}
      {eraseOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="erase-dialog-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setEraseOpen(false); }}
        >
          <div
            style={{
              background: "var(--surface)",
              borderRadius: "12px",
              padding: "32px",
              width: "400px",
              maxWidth: "90vw",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="erase-dialog-title" style={{ fontSize: "18px", fontWeight: 600, color: "var(--fg)", margin: 0, marginBottom: "12px" }}>
              Erase a person
            </h2>
            <p style={{ fontSize: "14px", color: "var(--fg-2)", marginBottom: "24px" }}>
              This removes all activity events associated with this email address. This action cannot be undone.
            </p>
            <label style={{ display: "block", marginBottom: "12px" }}>
              <span style={{ fontSize: "13px", color: "var(--fg-2)", display: "block", marginBottom: "4px" }}>Email</span>
              <input
                type="email"
                value={eraseEmail}
                onChange={(e) => setEraseEmail(e.target.value)}
                placeholder="user@example.com"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "var(--surface-2)",
                  color: "var(--fg)",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </label>
            <label style={{ display: "block", marginBottom: "24px" }}>
              <span style={{ fontSize: "13px", color: "var(--fg-2)", display: "block", marginBottom: "4px" }}>Confirm email</span>
              <input
                type="email"
                value={eraseConfirm}
                onChange={(e) => setEraseConfirm(e.target.value)}
                placeholder="user@example.com"
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "var(--surface-2)",
                  color: "var(--fg)",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </label>
            {eraseError && <p style={{ fontSize: "13px", color: "var(--red)", marginBottom: "12px" }}>{eraseError}</p>}
            {eraseMessage && <p style={{ fontSize: "13px", color: "var(--green)", marginBottom: "12px" }}>{eraseMessage}</p>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => { setEraseOpen(false); setEraseEmail(""); setEraseConfirm(""); setEraseError(null); setEraseMessage(null); }}
                style={{
                  fontSize: "13px",
                  color: "var(--fg-2)",
                  background: "transparent",
                  border: "1px solid var(--line-strong)",
                  borderRadius: "8px",
                  padding: "8px 16px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={eraseLoading || !eraseEmail || !eraseConfirm || eraseEmail !== eraseConfirm}
                onClick={handleErase}
                style={{
                  fontSize: "13px",
                  color: "var(--btn-fg)",
                  background: "var(--red)",
                  border: "none",
                  borderRadius: "8px",
                  padding: "8px 16px",
                  cursor: eraseLoading || !eraseEmail || !eraseConfirm || eraseEmail !== eraseConfirm ? "not-allowed" : "pointer",
                  opacity: eraseLoading || !eraseEmail || !eraseConfirm || eraseEmail !== eraseConfirm ? 0.5 : 1,
                }}
              >
                {eraseLoading ? "Erasing..." : "Erase"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface EventDetailPanelProps {
  event: ActivityEvent;
  onFilterByActor: (email: string) => void;
}

function EventDetailPanel({ event, onFilterByActor }: EventDetailPanelProps) {
  const meta = EVENT_META[event.event_type];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    } catch {
      // Clipboard not available
    }
  }

  const whyText =
    event.event_type === "access.refused"
      ? "Email is not on the app's list"
      : null;

  return (
    <aside
      aria-label="Event detail"
      style={{
        width: "320px",
        flex: "none",
        background: "var(--surface-2)",
        borderRadius: "12px",
        padding: "20px",
        fontSize: "13px",
        color: "var(--fg-2)",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 500,
          color: event.event_type === "access.refused" ? "var(--orange)" : "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "8px",
        }}
      >
        {meta?.chip ?? "Event"}
      </div>
      <div style={{ fontSize: "15px", fontWeight: 500, color: "var(--fg)", marginBottom: "16px" }}>
        {meta ? meta.sentence(event) : event.event_type}
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "80px 1fr",
          gap: "8px 12px",
          margin: 0,
        }}
      >
        <dt style={{ color: "var(--fg-3)" }}>When</dt>
        <dd style={{ margin: 0 }}>{new Date(event.occurred_at).toUTCString()}</dd>

        {event.actor_email && (
          <>
            <dt style={{ color: "var(--fg-3)" }}>Who</dt>
            <dd style={{ margin: 0, wordBreak: "break-all" }}>{event.actor_email}</dd>
          </>
        )}

        {event.app_id && (
          <>
            <dt style={{ color: "var(--fg-3)" }}>App</dt>
            <dd style={{ margin: 0 }}>{event.app_name ?? (typeof event.metadata.app_name === "string" ? event.metadata.app_name : event.app_id)}</dd>
          </>
        )}

        {whyText && (
          <>
            <dt style={{ color: "var(--fg-3)" }}>Why</dt>
            <dd style={{ margin: 0 }}>{whyText}</dd>
          </>
        )}

        {event.ip && (
          <>
            <dt style={{ color: "var(--fg-3)" }}>IP</dt>
            <dd style={{ margin: 0, fontFamily: "monospace", fontSize: "12px" }}>{event.ip}</dd>
          </>
        )}

        {event.user_agent && (
          <>
            <dt style={{ color: "var(--fg-3)" }}>Device</dt>
            <dd style={{ margin: 0 }}>{simpleDevice(event.user_agent)}</dd>
          </>
        )}

        <dt style={{ color: "var(--fg-3)" }}>Event ID</dt>
        <dd style={{ margin: 0, fontFamily: "monospace", fontSize: "11px", color: "var(--fg-2)", wordBreak: "break-all" }}>{event.id}</dd>
      </dl>

      <div style={{ display: "flex", gap: "8px", marginTop: "16px", flexWrap: "wrap" }}>
        {event.actor_email && (
          <button
            type="button"
            onClick={() => onFilterByActor(event.actor_email!)}
            style={{
              fontSize: "12px",
              color: "var(--fg-2)",
              background: "transparent",
              border: "1px solid var(--line-strong)",
              borderRadius: "8px",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Everything from this person
          </button>
        )}
        <button
          type="button"
          onClick={() => { void handleCopy(); }}
          style={{
            fontSize: "12px",
            color: "var(--fg-3)",
            background: "transparent",
            border: "none",
            borderRadius: "8px",
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Copy as JSON
        </button>
      </div>
    </aside>
  );
}
