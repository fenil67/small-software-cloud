"use client";

import { useEffect } from "react";
import { useClerk } from "@clerk/nextjs";
import { navigateHard } from "../../../lib/navigate";

/**
 * Rendered when the server component detects the active org no longer exists
 * in Clerk (resource_not_found 404).  Clears the active org and hard-navigates
 * to /onboarding so the user can create or join a workspace.
 */
export function WorkspaceGoneRedirect() {
  const { setActive } = useClerk();

  useEffect(() => {
    setActive({ organization: null })
      .catch(() => {})
      .finally(() => { navigateHard("/onboarding"); });
  }, [setActive]);

  return (
    <div style={{ padding: "40px 48px 64px" }}>
      <p style={{ margin: 0, fontSize: "14px", color: "var(--fg-3)" }}>
        Workspace no longer exists — redirecting…
      </p>
    </div>
  );
}
