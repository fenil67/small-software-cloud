"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList, useClerk } from "@clerk/nextjs";
import { Logo } from "../../../components/brand/Logo";
import { ThemeSwitch } from "../../../components/theme/ThemeSwitch";
import { navigateHard } from "../../../lib/navigate";

interface Props {
  firstName: string | null;
  forceNew?: boolean;
}

export function OnboardingClient({ firstName, forceNew = false }: Props) {
  const router = useRouter();
  const clerk = useClerk();
  const { createOrganization, setActive, userInvitations } = useOrganizationList({
    userInvitations: { pageSize: 10 },
  });

  const defaultName = forceNew ? "" : (firstName ? `${firstName}'s workspace` : "");
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const trimmed = name.trim();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed) { setError("Workspace name is required."); return; }
    if (trimmed.length > 64) { setError("Name must be 64 characters or fewer."); return; }
    setError(undefined);
    setLoading(true);
    try {
      console.info("[workspace] create start");
      const org = await createOrganization?.({ name: trimmed });
      if (!org) throw new Error("create_failed");
      console.info("[workspace] created");
      try {
        // redirectUrl tells Clerk to call routerPush("/apps") as part of the switch.
        // __internal_onAfterSetActive then calls router.refresh() on /apps, not the old page.
        await setActive?.({ organization: org.id, redirectUrl: "/apps" });
        console.info("[workspace] setActive done (Clerk navigating to /apps)");
      } catch {
        // setActive failed — Clerk did not navigate; fall back to hard navigation.
        console.info("[workspace] setActive failed, navigating fallback");
        navigateHard("/apps");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin(invitationId: string, orgId: string) {
    setJoiningId(invitationId);
    try {
      console.info("[workspace] create start");
      const inv = userInvitations?.data?.find((i) => i.id === invitationId);
      if (inv) await inv.accept();
      console.info("[workspace] created");
      try {
        await setActive?.({ organization: orgId, redirectUrl: "/apps" });
        console.info("[workspace] setActive done (Clerk navigating to /apps)");
      } catch {
        console.info("[workspace] setActive failed, navigating fallback");
        navigateHard("/apps");
      }
    } catch {
      setJoiningId(null);
    }
  }

  const invitations = forceNew ? [] : (userInvitations?.data ?? []);

  return (
    <main
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        background: "var(--bg)",
        color: "var(--fg)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 16px",
        gap: "32px",
      }}
    >
      <Logo height={40} />

      <section
        style={{
          width: "100%",
          maxWidth: "440px",
          boxSizing: "border-box",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "24px",
          padding: "40px 32px 32px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: "24px", lineHeight: "32px", fontWeight: 600, letterSpacing: "-0.01em" }}>
            {forceNew ? "Create a workspace" : "Name your workspace"}
          </h1>
          <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
            Your apps, keys and the people you share with live here. You can rename it later.
          </p>
        </div>

        <form
          onSubmit={handleCreate}
          style={{ display: "flex", flexDirection: "column", gap: "12px", margin: 0 }}
        >
          <label
            htmlFor="ws-name"
            style={{ fontSize: "13px", lineHeight: "16px", fontWeight: 500, color: "var(--fg-2)" }}
          >
            Workspace name
          </label>
          <input
            id="ws-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            autoComplete="organization"
            style={{
              height: "44px",
              boxSizing: "border-box",
              borderRadius: "12px",
              border: "1px solid var(--line-strong)",
              background: "var(--bg)",
              color: "var(--fg)",
              padding: "0 16px",
              font: "400 15px/20px var(--font-sans, system-ui, sans-serif)",
            }}
          />
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)" }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading || !trimmed}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "44px",
              borderRadius: "12px",
              background: "var(--btn-bg)",
              color: "var(--btn-fg)",
              font: "600 14px/20px var(--font-sans, system-ui, sans-serif)",
              border: 0,
              marginTop: "4px",
              cursor: loading ? "wait" : "pointer",
              opacity: loading || !trimmed ? 0.6 : 1,
            }}
          >
            {loading ? "Creating..." : "Continue"}
          </button>
        </form>

        {invitations.length > 0 && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                color: "var(--fg-3)",
                fontSize: "12px",
                lineHeight: "16px",
              }}
            >
              <span style={{ flex: 1, height: "1px", background: "var(--surface-3)" }} />
              or join one you were invited to
              <span style={{ flex: 1, height: "1px", background: "var(--surface-3)" }} />
            </div>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
              {invitations.map((inv) => {
                const orgName = inv.publicOrganizationData.name;
                const initial = orgName.charAt(0).toUpperCase();
                return (
                  <li
                    key={inv.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "12px 16px",
                      borderRadius: "12px",
                      background: "var(--surface-2)",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: "32px",
                        height: "32px",
                        flex: "none",
                        borderRadius: "10px",
                        background: "var(--surface-4)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "13px",
                        fontWeight: 600,
                      }}
                    >
                      {initial}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <span style={{ fontSize: "14px", lineHeight: "20px", fontWeight: 500 }}>
                        {orgName}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={joiningId === inv.id}
                      onClick={() => handleJoin(inv.id, inv.publicOrganizationData.id)}
                      style={{
                        height: "32px",
                        padding: "0 12px",
                        borderRadius: "8px",
                        border: "1px solid var(--line-strong)",
                        background: "transparent",
                        color: "var(--fg)",
                        font: "500 13px/16px var(--font-sans, system-ui, sans-serif)",
                        cursor: joiningId === inv.id ? "wait" : "pointer",
                      }}
                    >
                      {joiningId === inv.id ? "Joining..." : "Join"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <ThemeSwitch />
    </main>
  );
}
