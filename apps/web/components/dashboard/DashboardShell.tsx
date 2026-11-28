"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useUser, useClerk } from "@clerk/nextjs";
import { Logo } from "../brand/Logo";
import { Sidebar } from "./Sidebar";
import { navigateHard } from "../../lib/navigate";

interface DashboardShellProps {
  isAdmin: boolean;
  openAlertCount: number;
  children: React.ReactNode;
}

const ORG_SS_PREFIX = "org-activate-v1:";

function dsSsGet(key: string): string | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
  } catch { return null; }
}

function dsSsSet(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, value);
  } catch { /* private browsing */ }
}

function dropOrgParam(): void {
  const search = new URLSearchParams(window.location.search);
  search.delete("org");
  const qs = search.toString();
  history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

type OrgMembershipUser = {
  getOrganizationMemberships(params: {
    pageSize: number;
    initialPage: number;
  }): Promise<{ data: { organization: { id: string } }[]; total_count: number }>;
};

async function isMemberOfPagedDS(u: OrgMembershipUser, orgId: string): Promise<boolean> {
  const PAGE_SIZE = 50;
  for (let page = 1; page <= 20; page++) {
    const { data, total_count } = await u.getOrganizationMemberships({ pageSize: PAGE_SIZE, initialPage: page });
    if (data.some((m) => m.organization.id === orgId)) return true;
    if (data.length < PAGE_SIZE || page * PAGE_SIZE >= total_count) return false;
  }
  return false;
}

export function DashboardShell({ isAdmin, openAlertCount, children }: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  const orgParam = params.get("org");
  const { user, isLoaded } = useUser();
  const { setActive, session } = useClerk();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // Run-once guard: prevents the org-switch effect from firing again if
  // isLoaded toggles or orgParam identity changes after the first run.
  const hasOrgSwitchRan = useRef(false);

  // Org-switch on mount: if ?org= is present and not yet the active org,
  // verify membership and switch once.
  // Guarded by:
  //   (1) hasOrgSwitchRan ref — at most once per page load.
  //   (2) sessionStorage key org-activate-v1:<orgId> — at most once per org
  //       per browser tab, so a navigateHard("/apps") that re-renders this
  //       component does not trigger a second switch.
  useEffect(() => {
    if (!orgParam) return;
    if (!isLoaded) return;
    if (hasOrgSwitchRan.current) return;
    hasOrgSwitchRan.current = true;

    const ssKey = ORG_SS_PREFIX + orgParam;
    if (dsSsGet(ssKey)) {
      // sessionStorage guard: already activated this org in this tab session.
      dropOrgParam();
      return;
    }

    const activeOrgId = session?.lastActiveOrganizationId ?? null;
    if (activeOrgId === orgParam) {
      // Already on the correct org — just drop the param.
      dsSsSet(ssKey, "1");
      dropOrgParam();
      return;
    }

    if (!user) {
      dropOrgParam();
      return;
    }

    const currentUser = user;
    void (async () => {
      try {
        const isMember = await isMemberOfPagedDS(currentUser as OrgMembershipUser, orgParam);
        if (!isMember) {
          dropOrgParam();
          return;
        }
        dsSsSet(ssKey, "1");
        await setActive({ organization: orgParam });
        navigateHard("/apps");
      } catch {
        dropOrgParam();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgParam, isLoaded]);

  // Close on navigation
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Escape to close, focus trap
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen]);

  return (
    <div className="dashboard-shell">
      {/* Mobile top bar — hidden above 900px */}
      <div className="dashboard-topbar">
        <button
          ref={menuButtonRef}
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          className="dashboard-menu-btn"
        >
          <HamburgerIcon />
        </button>
        <div style={{ flex: 1 }} />
        <Logo height={22} />
        <div style={{ flex: 1 }} />
      </div>

      {/* Layout row */}
      <div className="dashboard-layout-row">
        {/* Overlay backdrop (mobile only, when open) */}
        {mobileOpen && (
          <div
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
            className="sidebar-backdrop"
          />
        )}

        {/* Sidebar — desktop: always visible; mobile: overlay panel */}
        <div className={`sidebar-panel${mobileOpen ? " sidebar-panel--open" : ""}`}>
          <Sidebar isAdmin={isAdmin} openAlertCount={openAlertCount} />
        </div>

        {/* Main scrollable area */}
        <main id="main-content" className="dashboard-main" tabIndex={-1}>
          {/* Max-width container for all content */}
          <div className="page-container">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function HamburgerIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
