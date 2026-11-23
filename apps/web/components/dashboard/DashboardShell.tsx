"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Logo } from "../brand/Logo";
import { Sidebar } from "./Sidebar";

interface DashboardShellProps {
  isAdmin: boolean;
  openAlertCount: number;
  children: React.ReactNode;
}

export function DashboardShell({ isAdmin, openAlertCount, children }: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

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
    <div style={{ height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
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
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
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
        <main id="main-content" style={{ flex: 1, minWidth: 0, overflowY: "auto" }} tabIndex={-1}>
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
