"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useClerk, useUser, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { Logo } from "../brand/Logo";
import { navigateHard } from "../../lib/navigate";

interface SidebarProps {
  isAdmin?: boolean;
  openAlertCount?: number;
}

export function Sidebar({ isAdmin = false, openAlertCount = 0 }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const clerk = useClerk();
  const { signOut } = clerk;
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships, setActive } = useOrganizationList({
    userMemberships: { pageSize: 20 },
  });

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? "";

  const initials = displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

  return (
    <nav
      aria-label="Sidebar"
      style={{
        flex: "1 1 232px",
        maxWidth: "232px",
        minWidth: "180px",
        display: "flex",
        flexDirection: "column",
        padding: "24px 16px",
        gap: "32px",
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      {/* Logo */}
      <div style={{ padding: "0 8px" }}>
        <Logo height={28} />
      </div>

      {/* Nav items */}
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <NavItem href="/apps" active={pathname.startsWith("/apps")} icon={<AppsIcon />} label="Apps" />
        <NavItem href="/keys" active={pathname.startsWith("/keys")} icon={<KeyIcon />} label="API keys" />
        <NavItem href="/settings" active={pathname.startsWith("/settings")} icon={<SettingsIcon />} label="Settings" />
      </div>

      {/* Admin section */}
      {isAdmin && (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <div style={{ padding: "0 8px", fontSize: "12px", color: "var(--fg-3)", fontWeight: 500, marginBottom: "4px" }}>
            Admin
          </div>
          <NavItem
            href="/admin"
            active={pathname === "/admin"}
            icon={<ShieldIcon />}
            label="Overview"
            badge={openAlertCount > 0 ? openAlertCount : undefined}
          />
          <NavItem
            href="/admin/activity"
            active={pathname.startsWith("/admin/activity")}
            icon={<WaveformIcon />}
            label="Activity"
          />
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Workspace switcher */}
      <WorkspaceSwitcher
        currentOrgName={organization?.name ?? null}
        currentOrgId={organization?.id ?? null}
        memberships={(userMemberships?.data ?? []).map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
        }))}
        onSwitch={async (orgId) => {
          try {
            await setActive?.({ organization: orgId, redirectUrl: "/apps" });
          } catch {
            navigateHard("/apps");
          }
        }}
      />

      {/* User block */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "8px",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "999px",
            background: "var(--surface-3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: 600,
            flex: "none",
          }}
        >
          {initials || displayName.charAt(0).toUpperCase()}
        </span>
        <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" }}>
          <span
            style={{
              fontSize: "14px",
              lineHeight: "20px",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              fontSize: "12px",
              lineHeight: "16px",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {organization?.name ?? "No workspace"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => signOut()}
          style={{
            padding: 0,
            border: 0,
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
            flex: "none",
          }}
          aria-label="Sign out"
        >
          <SignOutIcon />
        </button>
      </div>
    </nav>
  );
}

// ── WorkspaceSwitcher ─────────────────────────────────────────────────────────

interface WorkspaceSwitcherProps {
  currentOrgName: string | null;
  currentOrgId: string | null;
  memberships: Array<{ id: string; name: string }>;
  onSwitch: (orgId: string) => Promise<void>;
}

function WorkspaceSwitcher({
  currentOrgName,
  currentOrgId,
  memberships,
  onSwitch,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Close on Escape; return focus to trigger
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        listRef.current &&
        !listRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function handleSwitch(orgId: string) {
    if (orgId === currentOrgId) { setOpen(false); return; }
    setSwitching(orgId);
    try {
      await onSwitch(orgId);
    } finally {
      setSwitching(null);
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative", marginBottom: "4px" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={switching ? "Switching workspace…" : `Current workspace: ${currentOrgName ?? "None"}. Switch workspace`}
        disabled={switching !== null}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 8px",
          borderRadius: "8px",
          border: 0,
          background: open ? "var(--surface-3)" : "transparent",
          color: "var(--fg-2)",
          fontSize: "12px",
          cursor: switching !== null ? "wait" : "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {switching !== null ? "Switching\u2026" : (currentOrgName ?? "No workspace")}
        </span>
        {switching === null && <ChevronIcon open={open} />}
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Workspaces"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            right: 0,
            margin: 0,
            padding: "4px",
            listStyle: "none",
            background: "var(--surface)",
            border: "1px solid var(--line-strong)",
            borderRadius: "10px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            zIndex: 100,
          }}
        >
          {memberships.map((m) => {
            const isCurrent = m.id === currentOrgId;
            return (
              <li key={m.id} role="option" aria-selected={isCurrent}>
                <button
                  type="button"
                  onClick={() => handleSwitch(m.id)}
                  disabled={switching === m.id}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "6px 8px",
                    borderRadius: "7px",
                    border: 0,
                    background: isCurrent ? "var(--surface-3)" : "transparent",
                    color: "var(--fg)",
                    fontSize: "13px",
                    cursor: switching === m.id ? "wait" : "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "20px",
                      height: "20px",
                      borderRadius: "6px",
                      background: "var(--surface-4)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "11px",
                      fontWeight: 600,
                      flex: "none",
                    }}
                  >
                    {m.name.charAt(0).toUpperCase()}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name}
                  </span>
                  {isCurrent && <CheckIcon />}
                </button>
              </li>
            );
          })}

          <li role="option" aria-selected={false} style={{ borderTop: memberships.length > 0 ? "1px solid var(--line)" : "none", marginTop: memberships.length > 0 ? "4px" : 0, paddingTop: memberships.length > 0 ? "4px" : 0 }}>
            {/* Plain <a> so this triggers a full page load, not a client navigation that
                could prefetch stale RSC data while a workspace switch is in progress. */}
            <a
              href="/onboarding?new=1"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 8px",
                borderRadius: "7px",
                color: "var(--fg-2)",
                fontSize: "13px",
                textDecoration: "none",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "6px",
                  border: "1.5px dashed var(--line-strong)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                  flex: "none",
                  color: "var(--fg-3)",
                }}
              >
                +
              </span>
              Create workspace
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

// ── Nav item ──────────────────────────────────────────────────────────────────

interface NavItemProps {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

function NavItem({ href, active, icon, label, badge }: NavItemProps) {
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        height: "40px",
        padding: "0 12px",
        borderRadius: "10px",
        background: active ? "var(--surface-3)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-2)",
        fontSize: "14px",
        fontWeight: 500,
        textDecoration: "none",
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && (
        <span
          aria-label={`${badge} open alerts`}
          style={{
            background: "var(--red)", color: "var(--btn-fg)",
            borderRadius: "999px", fontSize: "12px", fontWeight: 600,
            padding: "0 6px", minWidth: "20px", height: "20px",
            display: "flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1,
          }}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function AppsIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5L2 4v4c0 3 2.5 5.5 6 6 3.5-.5 6-3 6-6V4L8 1.5z" />
    </svg>
  );
}

function WaveformIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8h2M5 4v8M9 2v12M13 5v6M15 8h-2" />
    </svg>
  );
}
