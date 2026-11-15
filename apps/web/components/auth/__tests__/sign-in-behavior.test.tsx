/**
 * BUG 3 – sign-in edge-case behaviour.
 *
 * (a) session_exists: when sendCode returns session_exists, navigate to destination
 *     instead of showing an error.
 * (b) stale attempt: when sendCode returns a non-email, non-session error on the
 *     first call but succeeds on a retry, the user reaches the code step.
 *
 * Strategy: mock @clerk/nextjs and next/navigation; render SignInPage; drive it
 * with fireEvent; assert observable outcomes (router.replace called / code step shown).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";
import SignInPage from "../../../app/(auth)/sign-in/page";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

vi.mock("@clerk/nextjs", () => ({
  useSignIn: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clerkError(code: string) {
  return { errors: [{ code, message: code }] };
}

function makeSignIn(sendCodeImpl: () => Promise<{ error?: unknown }>) {
  return {
    fetchStatus: "idle" as const,
    signIn: {
      emailCode: { sendCode: vi.fn(sendCodeImpl) },
      sso: vi.fn().mockResolvedValue({}),
      finalize: vi.fn().mockResolvedValue({}),
    },
  };
}

function submitEmail(value = "test@example.com") {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest("form")!);
}

// ─── (a) session_exists ───────────────────────────────────────────────────────

describe("BUG 3(a) – session_exists navigates instead of showing error", () => {
  let mockReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockReplace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ replace: mockReplace } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSignIn).mockReturnValue(
      makeSignIn(() => Promise.resolve({ error: clerkError("session_exists") })) as unknown as ReturnType<typeof useSignIn>,
    );
  });

  it("calls router.replace with /dashboard", async () => {
    render(<SignInPage />);
    submitEmail();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/dashboard"));
  });

  it("does not render any error alert", async () => {
    render(<SignInPage />);
    submitEmail();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ─── (b) stale attempt: first sendCode fails, second succeeds ─────────────────

describe("BUG 3(b) – stale attempt is retried; user reaches code step on success", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);

    // First call: stale error (non-email code). Second call: success.
    let calls = 0;
    vi.mocked(useSignIn).mockReturnValue(
      makeSignIn(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ error: clerkError("sign_in_already_exists") });
        }
        return Promise.resolve({});
      }) as unknown as ReturnType<typeof useSignIn>,
    );
  });

  it("shows the code step after a successful retry", async () => {
    render(<SignInPage />);
    submitEmail();
    // First attempt fails → component retries automatically; second succeeds → code step
    await waitFor(() => expect(screen.getByText(/We sent a 6 digit code to/i)).toBeInTheDocument());
  });
});
