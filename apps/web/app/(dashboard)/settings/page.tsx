import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { parseTheme } from "../../../lib/theme";
import { ThemeSwitch } from "../../../components/theme/ThemeSwitch";
import { WorkspaceDeleteSection } from "./WorkspaceDeleteSection";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const rawTheme = cookieStore.get("utir-theme")?.value;
  const initialTheme = parseTheme(rawTheme);

  const { orgRole, orgSlug } = await auth();
  const isAdmin = orgRole === "org:admin";
  // Use orgSlug as a fallback display name when the full org name isn't available
  const orgName = orgSlug ?? "";

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "680px", display: "flex", flexDirection: "column", gap: "32px" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h1 style={{ margin: 0, fontSize: "30px", lineHeight: "36px", fontWeight: 600, letterSpacing: "-0.02em" }}>
          Settings
        </h1>
      </header>

      <section aria-labelledby="appearance-h" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2 id="appearance-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
          Appearance
        </h2>
        <ThemeSwitch initialTheme={initialTheme} />
      </section>

      {isAdmin && orgName && <WorkspaceDeleteSection orgName={orgName} />}
    </div>
  );
}
