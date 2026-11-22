"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useUser } from "@clerk/nextjs";

// ── Shared style primitives (match existing WorkspaceDeleteSection patterns) ──

const S = {
  section: { display: "flex", flexDirection: "column", gap: "16px" } as React.CSSProperties,
  h2: { margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 } as React.CSSProperties,
  card: {
    padding: "16px",
    borderRadius: "10px",
    border: "1px solid var(--line)",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  } as React.CSSProperties,
  fieldCol: { display: "flex", flexDirection: "column", gap: "6px" } as React.CSSProperties,
  label: { fontSize: "12px", color: "var(--fg-3)", lineHeight: "16px" } as React.CSSProperties,
  input: {
    height: "36px",
    padding: "0 10px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "var(--bg)",
    color: "var(--fg)",
    fontSize: "13px",
    width: "100%",
    boxSizing: "border-box",
  } as React.CSSProperties,
  error: { margin: 0, fontSize: "12px", color: "var(--red)" } as React.CSSProperties,
  row: { display: "flex", gap: "12px" } as React.CSSProperties,
  actions: { display: "flex", justifyContent: "flex-end", gap: "8px" } as React.CSSProperties,
};

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    height: "36px",
    padding: "0 14px",
    borderRadius: "8px",
    border: 0,
    background: disabled ? "var(--surface-3)" : "var(--btn-bg)",
    color: disabled ? "var(--fg-3)" : "var(--btn-fg)",
    fontSize: "13px",
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

/** Map Clerk API error code (and fallback message) to plain user-facing strings. */
function mapClerkError(code: string, msg: string): string {
  // Code-first mapping — precise and future-proof
  if (code === "form_identifier_exists")            return "That username is already taken.";
  if (code === "form_username_invalid_length")       return "Username length is out of range.";
  if (code === "form_username_invalid_character")    return "Username can only contain letters, numbers, underscores and hyphens.";
  if (code === "form_param_format_invalid" && /username/i.test(msg)) return "Username format is invalid.";
  if (code === "form_param_max_length_exceeded" && /first.*name/i.test(msg)) return "First name is too long.";
  if (code === "form_param_max_length_exceeded" && /last.*name/i.test(msg))  return "Last name is too long.";
  if (code === "form_param_max_length_exceeded")     return "One of the name fields is too long.";
  // Fallback: message-based matching for unknown / legacy codes
  if (/username.*taken/i.test(msg) || /already.*taken/i.test(msg)) return "That username is already taken.";
  if (/username.*invalid/i.test(msg) || /invalid.*username/i.test(msg)) return "Username can only contain letters, numbers, underscores and hyphens.";
  if (/username.*too short/i.test(msg)) return "Username is too short.";
  if (/username.*too long/i.test(msg))  return "Username is too long.";
  if (/first.*name/i.test(msg))         return "First name is too long.";
  if (/last.*name/i.test(msg))          return "Last name is too long.";
  return "Could not save changes. Please try again.";
}

export function ProfileSection() {
  const { user, isLoaded } = useUser();

  // Undefined = user has not changed this field yet (saves = no change signal)
  const [firstName, setFirstName] = useState<string | undefined>(undefined);
  const [lastName, setLastName]   = useState<string | undefined>(undefined);
  const [username, setUsername]   = useState<string | undefined>(undefined);

  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [photoError, setPhotoError] = useState<string | undefined>();
  const [photoUploading, setPhotoUploading] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const origFirstName = user?.firstName ?? "";
  const origLastName  = user?.lastName  ?? "";
  const origUsername  = user?.username  ?? "";

  const displayFirst  = firstName  ?? origFirstName;
  const displayLast   = lastName   ?? origLastName;
  const displayUser   = username   ?? origUsername;

  const hasChanges =
    (firstName  !== undefined && firstName  !== origFirstName) ||
    (lastName   !== undefined && lastName   !== origLastName)  ||
    (username   !== undefined && username   !== origUsername);

  async function handleSave() {
    if (!user || !hasChanges || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await user.update({
        firstName: displayFirst,
        lastName:  displayLast,
        ...(user.username !== undefined ? { username: displayUser } : {}),
      });
      // Reset dirty flags — values are now the new baseline
      setFirstName(undefined);
      setLastName(undefined);
      setUsername(undefined);
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ code?: string; message?: string }> }).errors;
      const code = clerkErrors?.[0]?.code ?? "";
      const msg  = clerkErrors?.[0]?.message ?? "";
      if (code) console.error("[profile] save error code:", code);
      setSaveError(mapClerkError(code, msg));
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoFile(file: File) {
    setPhotoError(undefined);
    if (!file.type.startsWith("image/")) {
      setPhotoError("Please select an image file (JPEG, PNG, WebP, GIF).");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setPhotoError("Image must be 10 MB or less.");
      return;
    }
    if (!user) return;
    setPhotoUploading(true);
    try {
      await user.setProfileImage({ file });
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ code?: string; message?: string }> }).errors;
      const code = clerkErrors?.[0]?.code ?? "";
      const msg  = clerkErrors?.[0]?.message ?? "";
      setPhotoError(mapClerkError(code, msg) || "Could not upload photo.");
    } finally {
      setPhotoUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handlePhotoRemove() {
    if (!user || photoUploading) return;
    setPhotoError(undefined);
    setPhotoUploading(true);
    try {
      // Clerk v7: setProfileImage with null removes the custom image
      await user.setProfileImage({ file: null as unknown as File });
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ code?: string; message?: string }> }).errors;
      const code = clerkErrors?.[0]?.code ?? "";
      const msg  = clerkErrors?.[0]?.message ?? "";
      setPhotoError(mapClerkError(code, msg) || "Could not remove photo.");
    } finally {
      setPhotoUploading(false);
    }
  }

  if (!isLoaded) return null;

  return (
    <section aria-labelledby="profile-h" style={S.section}>
      <h2 id="profile-h" style={S.h2}>Profile</h2>

      <div style={S.card}>
        {/* ── Photo ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "50%",
              background: "var(--surface-3)",
              overflow: "hidden",
              flexShrink: 0,
              border: "1px solid var(--line)",
            }}
          >
            {user?.imageUrl ? (
              <Image
                src={user.imageUrl}
                alt="Profile photo"
                width={56}
                height={56}
                unoptimized
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "24px",
                  color: "var(--fg-2)",
                }}
              >
                {(user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0] ?? "?").toUpperCase()}
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={photoUploading}
                style={{
                  height: "32px",
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "transparent",
                  color: "var(--fg)",
                  fontSize: "13px",
                  cursor: photoUploading ? "not-allowed" : "pointer",
                  opacity: photoUploading ? 0.5 : 1,
                }}
              >
                {photoUploading ? "Uploading…" : "Upload photo"}
              </button>

              {user?.hasImage && (
                <button
                  type="button"
                  onClick={handlePhotoRemove}
                  disabled={photoUploading}
                  style={{
                    height: "32px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--line-strong)",
                    background: "transparent",
                    color: "var(--fg-3)",
                    fontSize: "13px",
                    cursor: photoUploading ? "not-allowed" : "pointer",
                    opacity: photoUploading ? 0.5 : 1,
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <p style={{ margin: 0, fontSize: "11px", color: "var(--fg-3)" }}>
              Images only · max 10 MB
            </p>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            aria-label="Upload profile photo"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handlePhotoFile(file);
            }}
          />
        </div>

        {photoError && <p role="alert" style={S.error}>{photoError}</p>}

        <hr style={{ margin: 0, border: 0, borderTop: "1px solid var(--line)" }} />

        {/* ── Name & username ───────────────────────────────────────────── */}
        <div style={S.row}>
          <div style={{ ...S.fieldCol, flex: 1 }}>
            <label htmlFor="profile-first" style={S.label}>First name</label>
            <input
              id="profile-first"
              type="text"
              value={displayFirst}
              onChange={(e) => { setFirstName(e.target.value); setSaveError(undefined); }}
              autoComplete="given-name"
              style={S.input}
            />
          </div>
          <div style={{ ...S.fieldCol, flex: 1 }}>
            <label htmlFor="profile-last" style={S.label}>Last name</label>
            <input
              id="profile-last"
              type="text"
              value={displayLast}
              onChange={(e) => { setLastName(e.target.value); setSaveError(undefined); }}
              autoComplete="family-name"
              style={S.input}
            />
          </div>
        </div>

        {user?.username !== undefined && (
          <div style={S.fieldCol}>
            <label htmlFor="profile-username" style={S.label}>Username</label>
            <input
              id="profile-username"
              type="text"
              value={displayUser}
              onChange={(e) => { setUsername(e.target.value); setSaveError(undefined); }}
              autoComplete="username"
              style={S.input}
            />
          </div>
        )}

        {saveError && <p role="alert" style={S.error}>{saveError}</p>}

        <div style={S.actions}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || saving}
            style={btnPrimary(!hasChanges || saving)}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </section>
  );
}
