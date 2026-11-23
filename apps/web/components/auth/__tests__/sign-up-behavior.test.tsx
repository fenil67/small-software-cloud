/**
 * Sign-up page behavior tests.
 *
 * Covers: "already signed in" detection — shows a card instead of the form
 * when useUser returns a signed-in user.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { useSignUp, useUser, useClerk } from "@clerk/nextjs";
import SignUpPage from "../../../app/(auth)/sign-up/page";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockSignOut = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

vi.mock("@clerk/nextjs", () => ({
  useSignUp: vi.fn(),
  useUser: vi.fn(() => ({ user: null, isLoaded: true })),
  useClerk: vi.fn(() => ({ signOut: mockSignOut })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSignUp() {
  return {
    fetchStatus: "idle" as const,
    signUp: {
      create: vi.fn().mockResolvedValue({}),
      verifications: {
        sendEmailCode: vi.fn().mockResolvedValue({}),
        verifyEmailCode: vi.fn().mockResolvedValue({}),
      },
      sso: vi.fn().mockResolvedValue({}),
      finalize: vi.fn().mockResolvedValue({}),
    },
  };
}

// ─── already signed in ────────────────────────────────────────────────────────

describe("already signed in → shows signed-in card", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSignUp).mockReturnValue(
      makeSignUp() as unknown as ReturnType<typeof useSignUp>,
    );
    vi.mocked(useUser).mockReturnValue({
      user: { primaryEmailAddress: { emailAddress: "user@test.com" } },
      isLoaded: true,
    } as unknown as ReturnType<typeof useUser>);
  });

  it("shows 'You're already signed in' card when user is signed in", () => {
    render(<SignUpPage />);
    expect(screen.getByText(/you're already signed in/i)).toBeInTheDocument();
  });

  it("Continue to Utir link goes to /apps", () => {
    render(<SignUpPage />);
    const link = screen.getByRole("link", { name: /continue to utir/i });
    expect(link).toHaveAttribute("href", "/apps");
  });

  it("Sign out button calls signOut", () => {
    render(<SignUpPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalled();
  });
});

// ─── not signed in → shows normal form ───────────────────────────────────────

describe("not signed in → shows normal sign-up form", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSignUp).mockReturnValue(
      makeSignUp() as unknown as ReturnType<typeof useSignUp>,
    );
    vi.mocked(useUser).mockReturnValue({
      user: null,
      isLoaded: true,
    } as unknown as ReturnType<typeof useUser>);
  });

  it("shows 'Create your account' heading", () => {
    render(<SignUpPage />);
    expect(screen.getByText(/create your account/i)).toBeInTheDocument();
  });
});
