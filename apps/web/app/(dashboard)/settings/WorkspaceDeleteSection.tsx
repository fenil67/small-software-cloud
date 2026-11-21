"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { WorkspaceDeletePreview } from "../../../lib/api-types";
import { fetchDeletePreview, deleteWorkspace } from "./actions";

interface Props {
  orgName: string;
}

export function WorkspaceDeleteSection({ orgName }: Props) {
  const router = useRouter();
  const { setActive } = useClerk();
  const { organization: currentOrg } = useOrganization();
  const { userMemberships } = useOrganizationList({ userMemberships: { infinite: true } });
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<WorkspaceDeletePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [loadingPreview, startPreviewTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();

  function openDialog() {
    setConfirmName("");
    setDeleteError(undefined);
    setPreviewError(undefined);
    setPreview(null);
    setOpen(true);
    startPreviewTransition(async () => {
      const result = await fetchDeletePreview();
      if ("error" in result) {
        setPreviewError(result.error);
      } else {
        setPreview(result.preview);
      }
    });
  }

  function closeDialog() {
    if (deleting) return;
    setOpen(false);
  }

  function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (confirmName.trim() !== orgName || deleting) return;
    setDeleteError(undefined);
    startDeleteTransition(async () => {
      const result = await deleteWorkspace(confirmName.trim());
      if (result.error) {
        if (result.error === "name_mismatch") {
          setDeleteError("Workspace name does not match.");
        } else if (result.error === "org_admin_required") {
          setDeleteError("Only admins can delete the workspace.");
        } else {
          setDeleteError("Could not delete workspace.");
        }
        return;
      }

      // Find another workspace to switch into, excluding the one just deleted
      const currentOrgId = currentOrg?.id;
      const others = (userMemberships?.data ?? []).filter(
        (m) => m.organization.id !== currentOrgId,
      );

      if (others.length > 0) {
        // Switch to the first available workspace and go to /apps
        await setActive({ organization: others[0].organization.id, redirectUrl: "/apps" });
      } else {
        // No other workspace — go to onboarding to create or join one
        router.push("/onboarding");
      }
    });
  }

  const canDelete = confirmName.trim() === orgName && !deleting;

  return (
    <section
      aria-labelledby="danger-h"
      style={{ display: "flex", flexDirection: "column", gap: "16px" }}
    >
      <h2
        id="danger-h"
        style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}
      >
        Danger zone
      </h2>

      <div
        style={{
          padding: "16px",
          borderRadius: "10px",
          border: "1px solid var(--red)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 500 }}>Delete workspace</p>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--fg-3)" }}>
            Permanently removes all apps, API keys, and access. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={openDialog}
          style={{
            flexShrink: 0,
            height: "34px",
            padding: "0 14px",
            borderRadius: "8px",
            border: "1px solid var(--red)",
            background: "transparent",
            color: "var(--red)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Delete workspace
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
        >
          <div
            style={{
              width: "min(480px, calc(100vw - 32px))",
              borderRadius: "14px",
              background: "var(--bg)",
              border: "1px solid var(--line)",
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <h3
              id="delete-dialog-title"
              style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}
            >
              Delete workspace?
            </h3>

            {loadingPreview && (
              <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)" }}>
                Loading…
              </p>
            )}
            {previewError && (
              <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)" }}>
                Could not load preview: {previewError}
              </p>
            )}
            {preview && (
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  fontSize: "13px",
                  color: "var(--fg-2)",
                }}
              >
                <li>{preview.apps} app{preview.apps !== 1 ? "s" : ""} will be deleted</li>
                <li>{preview.keys} API key{preview.keys !== 1 ? "s" : ""} will be revoked</li>
                {preview.pending_invites > 0 && (
                  <li>{preview.pending_invites} pending invite{preview.pending_invites !== 1 ? "s" : ""} will be cancelled</li>
                )}
              </ul>
            )}

            <form
              onSubmit={handleDelete}
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <label
                htmlFor="confirm-name"
                style={{ fontSize: "12px", color: "var(--fg-3)", lineHeight: "16px" }}
              >
                Type <strong style={{ color: "var(--fg)" }}>{orgName}</strong> to confirm
              </label>
              <input
                id="confirm-name"
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={orgName}
                disabled={deleting}
                style={{
                  height: "36px",
                  padding: "0 10px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "var(--bg)",
                  color: "var(--fg)",
                  fontSize: "13px",
                }}
              />
              {deleteError && (
                <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>
                  {deleteError}
                </p>
              )}
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={closeDialog}
                  disabled={deleting}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid var(--line-strong)",
                    background: "transparent",
                    color: "var(--fg)",
                    fontSize: "13px",
                    cursor: deleting ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canDelete}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: 0,
                    background: canDelete ? "var(--red)" : "var(--surface-3)",
                    color: canDelete ? "#fff" : "var(--fg-3)",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: canDelete ? "pointer" : "not-allowed",
                  }}
                >
                  {deleting ? "Deleting…" : "Delete workspace"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
