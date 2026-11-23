/**
 * Incomplete-status guard tests.
 *
 * After verifying the email code, Clerk may return a status other than
 * "complete" (e.g. "missing_requirements"). The pages must NOT call finalize
 * in that case — doing so throws Clerk's raw error text at the user.
 *
 * Covers:
 *  - Sign-up: verify succeeds but status = missing_requirements
 *      → finalize NOT called, generic message shown, Clerk raw text absent
 *  - Sign-in: verify succeeds but status = needs_second_factor
 *      → finalize NOT called, generic message shown
 *  - CodeStep label is "Code" on both pages
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { useSignUp, useSignIn } from "@clerk/nextjs";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

vi.mock("@clerk/nextjs", () => ({
  useSignUp: vi.fn(),
  useSignIn: vi.fn(),
  useUser: vi.fn(() => ({ user: null, isLoaded: true })),
  useClerk: vi.fn(() => ({ signOut: vi.fn() })),
}));

// ─── Page imports (lazy, after vi.mock is hoisted) ────────────────────────────

const SignUpPage = (await import("../../../app/(auth)/sign-up/page")).default;
const SignInPage = (await import("../../../app/(auth)/sign-in/page")).default;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function submitEmailStep(email = "test@example.com") {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: email } });
  fireEvent.submit(input.closest("form")!);
}

function submitCodeStep(code = "123456") {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.submit(input.closest("form")!);
}

async function advanceToCodeStep() {
  submitEmailStep();
  await waitFor(() =>
    expect(screen.getByText(/We sent a 6 digit code to/i)).toBeInTheDocument(),
  );
}

// ─── Sign-up: missing_requirements ───────────────────────────────────────────

describe("Sign-up: verify succeeds but status = missing_requirements", () => {
  let mockFinalize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    mockFinalize = vi.fn().mockResolvedValue({});

    vi.mocked(useSignUp).mockReturnValue({
      fetchStatus: "idle",
      errors: [],
      signUp: {
        status: "missing_requirements",
        missingFields: ["first_name"],
        unverifiedFields: [],
        create: vi.fn().mockResolvedValue({}),
        sso: vi.fn().mockResolvedValue({}),
        finalize: mockFinalize,
        verifications: {
          sendEmailCode: vi.fn().mockResolvedValue({}),
          verifyEmailCode: vi.fn().mockResolvedValue({}),
        },
      },
    } as unknown as ReturnType<typeof useSignUp>);
  });

  it("does NOT call finalize when status is missing_requirements", async () => {
    render(<SignUpPage />);
    await advanceToCodeStep();
    submitCodeStep();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it("shows the generic error message", async () => {
    render(<SignUpPage />);
    await advanceToCodeStep();
    submitCodeStep();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Something went wrong. Try again.",
      ),
    );
  });

  it("does not show Clerk's raw finalize error text", async () => {
    render(<SignUpPage />);
    await advanceToCodeStep();
    submitCodeStep();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(
      screen.queryByText(/Cannot finalize sign-up without a created session/i),
    ).not.toBeInTheDocument();
  });
});

// ─── Sign-in: status not complete ────────────────────────────────────────────

describe("Sign-in: verify succeeds but status = needs_second_factor", () => {
  let mockFinalize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    mockFinalize = vi.fn().mockResolvedValue({});

    vi.mocked(useSignIn).mockReturnValue({
      fetchStatus: "idle",
      errors: [],
      signIn: {
        status: "needs_second_factor",
        emailCode: {
          sendCode: vi.fn().mockResolvedValue({}),
          verifyCode: vi.fn().mockResolvedValue({}),
        },
        sso: vi.fn().mockResolvedValue({}),
        finalize: mockFinalize,
      },
    } as unknown as ReturnType<typeof useSignIn>);
  });

  it("does NOT call finalize when status is not complete", async () => {
    render(<SignInPage />);
    await advanceToCodeStep();
    submitCodeStep();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it("shows the generic error message", async () => {
    render(<SignInPage />);
    await advanceToCodeStep();
    submitCodeStep();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Something went wrong. Try again.",
      ),
    );
  });
});

// ─── CodeStep label ───────────────────────────────────────────────────────────

describe("CodeStep label is 'Code' on both pages", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    vi.mocked(useSignUp).mockReturnValue({
      fetchStatus: "idle",
      errors: [],
      signUp: {
        status: "complete",
        missingFields: [],
        unverifiedFields: [],
        create: vi.fn().mockResolvedValue({}),
        sso: vi.fn().mockResolvedValue({}),
        finalize: vi.fn().mockResolvedValue({}),
        verifications: {
          sendEmailCode: vi.fn().mockResolvedValue({}),
          verifyEmailCode: vi.fn().mockResolvedValue({}),
        },
      },
    } as unknown as ReturnType<typeof useSignUp>);

    vi.mocked(useSignIn).mockReturnValue({
      fetchStatus: "idle",
      errors: [],
      signIn: {
        status: "complete",
        emailCode: {
          sendCode: vi.fn().mockResolvedValue({}),
          verifyCode: vi.fn().mockResolvedValue({}),
        },
        sso: vi.fn().mockResolvedValue({}),
        finalize: vi.fn().mockResolvedValue({}),
      },
    } as unknown as ReturnType<typeof useSignIn>);
  });

  it("sign-up code step shows label 'Code'", async () => {
    render(<SignUpPage />);
    await advanceToCodeStep();
    expect(screen.getByLabelText(/^code$/i)).toBeInTheDocument();
    expect(screen.queryByText(/verification code/i)).not.toBeInTheDocument();
  });

  it("sign-in code step shows label 'Code'", async () => {
    render(<SignInPage />);
    await advanceToCodeStep();
    expect(screen.getByLabelText(/^code$/i)).toBeInTheDocument();
    expect(screen.queryByText(/verification code/i)).not.toBeInTheDocument();
  });
});
