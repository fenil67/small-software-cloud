import { cookies } from "next/headers";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { parseTheme } from "../../../lib/theme";
import { ThemeSwitch } from "../../../components/theme/ThemeSwitch";
import { WorkspaceDeleteSection } from "./WorkspaceDeleteSection";
import { WorkspaceGoneRedirect } from "./WorkspaceGoneRedirect";
import { ProfileSection } from "./ProfileSection";
import { EmailSection } from "./EmailSection";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";
import { ActiveSessionsSection } from "./ActiveSessionsSection";
import { DeleteAccountSection } from "./DeleteAccountSection";
import { MembersSection } from "./MembersSection";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get("utir-theme")?.value;
  const initialTheme = parseTheme(rawTheme);

  const { orgRole, orgId } = await auth();
  const isAdmin = orgRole === "org:admin";

  // Fetch the current display name from Clerk — the slug stored in auth() is not
  // the human-readable name shown in the dialog, so we must fetch org.name directly.
  let orgName = "";
  let orgGone = false;
  let orgFetchFailed = false;

  if (orgId) {
    try {
      const client = await clerkClient();
      const org = await client.organizations.getOrganization({ organizationId: orgId });
      orgName = org.name;
    } catch (err: unknown) {
      const e = err as { status?: number; errors?: Array<{ code?: string }> };
      if (e.status === 404 && e.errors?.[0]?.code === "resource_not_found") {
        // Org was deleted in Clerk — redirect client-side to clear it
        orgGone = true;
      } else {
        // Transient Clerk error — render settings without workspace-specific sections
        orgFetchFailed = true;
      }
    }
  }

  // Org gone: render a client component that clears the active org and redirects
  if (orgGone) {
    return <WorkspaceGoneRedirect />;
  }

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "680px", display: "flex", flexDirection: "column", gap: "32px" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h1 style={{ margin: 0, fontSize: "30px", lineHeight: "36px", fontWeight: 600, letterSpacing: "-0.02em" }}>
          Settings
        </h1>
      </header>

      {/* 1. Profile */}
      <ProfileSection />

      {/* 2. Email addresses */}
      <EmailSection />

      {/* 3. Connected accounts */}
      <ConnectedAccountsSection />

      {/* 4. Active sessions */}
      <ActiveSessionsSection />

      {/* 5. Appearance */}
      <section aria-labelledby="appearance-h" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2 id="appearance-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
          Appearance
        </h2>
        <ThemeSwitch initialTheme={initialTheme} />
      </section>

      {/* 6. Workspace settings (admins only, skip if Clerk fetch failed) */}
      {orgFetchFailed && (
        <section aria-labelledby="workspace-error-h" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <h2 id="workspace-error-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
            Workspace
          </h2>
          <div style={{ padding: "16px", borderRadius: "10px", border: "1px solid var(--line)", background: "var(--surface)" }}>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)" }}>
              Could not load workspace settings.
            </p>
          </div>
        </section>
      )}

      {/* 7. Members section (visible to all workspace members, hidden if fetch failed) */}
      {!orgFetchFailed && orgId && <MembersSection isAdmin={isAdmin} />}

      {/* 8. Workspace danger zone (admins only) */}
      {!orgFetchFailed && isAdmin && orgName && <WorkspaceDeleteSection orgName={orgName} />}

      {/* 9. Delete account */}
      <DeleteAccountSection />
    </div>
  );
}
