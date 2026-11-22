import { cookies } from "next/headers";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { parseTheme } from "../../../lib/theme";
import { ThemeSwitch } from "../../../components/theme/ThemeSwitch";
import { WorkspaceDeleteSection } from "./WorkspaceDeleteSection";
import { ProfileSection } from "./ProfileSection";
import { EmailSection } from "./EmailSection";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";
import { ActiveSessionsSection } from "./ActiveSessionsSection";
import { DeleteAccountSection } from "./DeleteAccountSection";

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
  if (orgId) {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    orgName = org.name;
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

      {/* 6. Workspace danger zone (admins only) */}
      {isAdmin && orgName && <WorkspaceDeleteSection orgName={orgName} />}

      {/* 7. Delete account */}
      <DeleteAccountSection />
    </div>
  );
}
