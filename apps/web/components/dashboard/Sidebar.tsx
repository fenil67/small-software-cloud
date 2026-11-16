"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useClerk, useUser, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { Logo } from "../brand/Logo";
import { ThemeSwitch } from "../theme/ThemeSwitch";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships, setActive } = useOrganizationList({
    userMemberships: { pageSize: 20 },
  });

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <nav
      aria-label="Sidebar"
      style={{
        flex: "1 1 232px",
        maxWidth: "232px",
        minWidth: "180px",
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        borderRight: "1px solid var(--line)",
        padding: "20px 12px",
        gap: "4px",
      }}
    >
      {/* Logo */}
      <div style={{ padding: "4px 8px 16px" }}>
        <Logo height={28} />
      </div>

      {/* Nav items */}
      <NavItem href="/apps" active={pathname.startsWith("/apps")} icon={<AppsIcon />} label="Apps" />
      <NavItem href="/keys" active={pathname.startsWith("/keys")} icon={<KeyIcon />} label="API keys" />

      <div style={{ flex: 1 }} />

      {/* Theme switch */}
      <div style={{ paddingBottom: "12px" }}>
        <ThemeSwitch />
      </div>

      {/* Workspace switcher */}
      <WorkspaceSwitcher
        currentOrgName={organization?.name ?? null}
        currentOrgId={organization?.id ?? null}
        memberships={(userMemberships?.data ?? []).map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
        }))}
        onSwitch={async (orgId) => {
          await setActive?.({ organization: orgId });
          router.refresh();
        }}
      />

      {/* User block */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px",
          borderTop: "1px solid var(--line)",
          marginTop: "4px",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            background: "var(--surface-3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: 600,
            flex: "none",
          }}
        >
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "13px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayName}
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
        aria-label={`Current workspace: ${currentOrgName ?? "None"}. Switch workspace`}
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
          cursor: "pointer",
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
          {currentOrgName ?? "No workspace"}
        </span>
        <ChevronIcon open={open} />
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
            <Link
              href="/onboarding"
              onClick={() => setOpen(false)}
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
            </Link>
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
}

function NavItem({ href, active, icon, label }: NavItemProps) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 8px",
        borderRadius: "8px",
        background: active ? "var(--surface-3)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-2)",
        fontSize: "14px",
        fontWeight: active ? 500 : 400,
        textDecoration: "none",
      }}
    >
      {icon}
      {label}
    </Link>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function AppsIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6" />
      <path d="M15.5 7.5l3 3" />
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
