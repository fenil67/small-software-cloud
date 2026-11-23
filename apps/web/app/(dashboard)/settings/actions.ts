"use server";

import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type {
  WorkspaceDeletePreview,
  DeleteMeResponse,
  DeleteMeBlockedResponse,
  WorkspaceMembersResponse,
} from "../../../lib/api-types";

export async function fetchDeletePreview(): Promise<
  { preview: WorkspaceDeletePreview } | { error: string }
> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    const preview = await apiFetch<WorkspaceDeletePreview>(
      "/v1/workspace/delete-preview",
      { token },
    );
    return { preview };
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "fetch_failed" };
  }
}

export async function deleteWorkspace(
  confirmName: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch("/v1/workspace", {
      method: "DELETE",
      body: { confirm_name: confirmName },
      token,
    });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "delete_failed" };
  }
}

// ── Workspace members ─────────────────────────────────────────────────────────

export async function fetchWorkspaceMembers(): Promise<
  WorkspaceMembersResponse | { error: string }
> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    return await apiFetch<WorkspaceMembersResponse>("/v1/workspace/members", { token });
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "fetch_failed" };
  }
}

export async function inviteMember(
  email: string,
  role: string,
): Promise<{ id?: string; error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    const r = await apiFetch<{ id: string }>("/v1/workspace/invitations", {
      method: "POST",
      body: { email, role },
      token,
    });
    return { id: r.id };
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "invite_failed" };
  }
}

export async function revokeInvitation(invitationId: string): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    await apiFetch(`/v1/workspace/invitations/${invitationId}`, { method: "DELETE", token });
    return {};
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "revoke_failed" };
  }
}

export async function resendInvitation(invitationId: string): Promise<{ id?: string; error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    const r = await apiFetch<{ id: string }>(`/v1/workspace/invitations/${invitationId}/resend`, { method: "POST", token });
    return { id: r.id };
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "resend_failed" };
  }
}

export async function changeMemberRole(
  clerkUserId: string,
  role: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    await apiFetch(`/v1/workspace/members/${clerkUserId}`, { method: "PATCH", body: { role }, token });
    return {};
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "change_failed" };
  }
}

export async function removeMember(clerkUserId: string): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    await apiFetch(`/v1/workspace/members/${clerkUserId}`, { method: "DELETE", token });
    return {};
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "remove_failed" };
  }
}

export async function leaveWorkspace(): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };
  try {
    await apiFetch("/v1/workspace/leave", { method: "POST", token });
    return {};
  } catch (e: unknown) {
    return { error: (e as { code?: string }).code ?? "leave_failed" };
  }
}

export async function deleteAccount(
  confirmEmail: string,
): Promise<{ error?: string; blocked?: DeleteMeBlockedResponse }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch<DeleteMeResponse>("/v1/me", {
      method: "DELETE",
      body: { confirm_email: confirmEmail },
      token,
    });
    return {};
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number };
    // 409 → sole_admin_blocked; include the full body for workspace list
    if (err.status === 409) {
      const raw = e as { body?: DeleteMeBlockedResponse };
      return { error: "sole_admin_blocked", blocked: raw.body };
    }
    return { error: err.code ?? "delete_failed" };
  }
}
