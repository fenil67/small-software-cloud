/**
 * T4 – component render tests.
 *
 * OAuthButtons: exactly one Google and one GitHub button.
 * CodeStep: shows full un-masked email.
 * EmailStep: correct label and placeholder.
 * AuthCard: renders title and subtitle.
 * Sign-in / sign-up pages: exact title, subtitle, label, placeholder, footer strings, no emoji.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { OAuthButtons } from "../OAuthButtons";
import { CodeStep } from "../CodeStep";
import { EmailStep } from "../EmailStep";
import { AuthCard } from "../AuthCard";

// ─── Mock Clerk + Next.js (needed for page imports) ──────────────────────────

vi.mock("@clerk/nextjs", () => ({
  useSignIn: vi.fn(() => ({
    fetchStatus: "idle",
    signIn: {
      emailCode: { sendCode: vi.fn().mockResolvedValue({}) },
      sso: vi.fn().mockResolvedValue({}),
      finalize: vi.fn().mockResolvedValue({}),
    },
  })),
  useSignUp: vi.fn(() => ({
    fetchStatus: "idle",
    signUp: {
      create: vi.fn().mockResolvedValue({}),
      sso: vi.fn().mockResolvedValue({}),
      finalize: vi.fn().mockResolvedValue({}),
      verifications: {
        sendEmailCode: vi.fn().mockResolvedValue({}),
        verifyEmailCode: vi.fn().mockResolvedValue({}),
      },
    },
  })),
  useUser: vi.fn(() => ({ user: null, isLoaded: true })),
  useClerk: vi.fn(() => ({ signOut: vi.fn() })),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

// ─── T4: exactly one Google and one GitHub button ────────────────────────────

describe("T4 – OAuthButtons renders exactly one Google and one GitHub button", () => {
  const noop = vi.fn();

  it("renders exactly one button with accessible name containing 'Google'", () => {
    render(<OAuthButtons onGoogle={noop} onGithub={noop} />);
    expect(screen.getAllByRole("button", { name: /google/i })).toHaveLength(1);
  });

  it("renders exactly one button with accessible name containing 'GitHub'", () => {
    render(<OAuthButtons onGoogle={noop} onGithub={noop} />);
    expect(screen.getAllByRole("button", { name: /github/i })).toHaveLength(1);
  });

  it("renders exactly 2 buttons total", () => {
    render(<OAuthButtons onGoogle={noop} onGithub={noop} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

// ─── CodeStep: full email is shown exactly as typed ──────────────────────────

describe("CodeStep – shows full un-masked email", () => {
  const noop = vi.fn();

  it("shows the exact email passed as prop", () => {
    render(
      <CodeStep
        email="alice@example.com"
        code=""
        onChange={noop}
        onSubmit={noop}
        onResend={noop}
        resendCooldownMs={0}
      />,
    );
    expect(screen.getByText(/We sent a 6 digit code to/i)).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("shows a different email correctly (no masking)", () => {
    render(
      <CodeStep
        email="bob+tag@domain.co.uk"
        code=""
        onChange={noop}
        onSubmit={noop}
        onResend={noop}
        resendCooldownMs={0}
      />,
    );
    expect(screen.getByText("bob+tag@domain.co.uk")).toBeInTheDocument();
  });
});

// ─── EmailStep: label and placeholder ────────────────────────────────────────

describe("EmailStep – label and placeholder", () => {
  const noop = vi.fn();

  it("label text is 'Email' (not 'Email address')", () => {
    render(<EmailStep email="" onChange={noop} onSubmit={noop} />);
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.queryByText(/email address/i)).not.toBeInTheDocument();
  });

  it("input placeholder is 'you@company.com'", () => {
    render(<EmailStep email="" onChange={noop} onSubmit={noop} />);
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument();
  });
});

// ─── AuthCard: title and subtitle ────────────────────────────────────────────

describe("AuthCard – title and optional subtitle", () => {
  it("renders title text", () => {
    render(<AuthCard title="Sign in to Utir"><span /></AuthCard>);
    expect(screen.getByRole("heading", { name: "Sign in to Utir" })).toBeInTheDocument();
  });

  it("renders subtitle when provided", () => {
    render(
      <AuthCard title="Sign in to Utir" subtitle="Your apps, live and private.">
        <span />
      </AuthCard>,
    );
    expect(screen.getByText("Your apps, live and private.")).toBeInTheDocument();
  });

  it("omits subtitle element when not provided", () => {
    render(<AuthCard title="Sign in to Utir"><span /></AuthCard>);
    expect(screen.queryByText(/live and private/i)).not.toBeInTheDocument();
  });
});

// ─── Sign-in page: BUG 4 exact strings, no emoji ────────────────────────────

// Lazy import avoids hoisting issues with vi.mock
const SignInPage = (await import("../../../app/(auth)/sign-in/page")).default;

describe("Sign-in page – exact copy and no emoji", () => {
  it("renders correct title", () => {
    render(<SignInPage />);
    expect(screen.getByRole("heading", { name: "Sign in to Utir" })).toBeInTheDocument();
  });

  it("renders correct subtitle", () => {
    render(<SignInPage />);
    expect(screen.getByText("Your apps, live and private.")).toBeInTheDocument();
  });

  it("renders label 'Email'", () => {
    render(<SignInPage />);
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
  });

  it("renders placeholder 'you@company.com'", () => {
    render(<SignInPage />);
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument();
  });

  it("renders footer 'New to Utir?' with 'Create an account' link", () => {
    render(<SignInPage />);
    expect(screen.getByText(/New to Utir\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toBeInTheDocument();
  });

  it("contains no emoji characters", () => {
    const { container } = render(<SignInPage />);
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});

// ─── Sign-up page: BUG 4 exact strings, no emoji ────────────────────────────

const SignUpPage = (await import("../../../app/(auth)/sign-up/page")).default;

describe("Sign-up page – exact copy and no emoji", () => {
  it("renders correct title", () => {
    render(<SignUpPage />);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
  });

  it("renders correct subtitle", () => {
    render(<SignUpPage />);
    expect(
      screen.getByText("Put your apps online, private to the people you choose."),
    ).toBeInTheDocument();
  });

  it("renders label 'Email'", () => {
    render(<SignUpPage />);
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
  });

  it("renders placeholder 'you@company.com'", () => {
    render(<SignUpPage />);
    expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument();
  });

  it("renders footer 'Already have an account?' with 'Sign in' link", () => {
    render(<SignUpPage />);
    expect(screen.getByText(/Already have an account\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("contains no emoji characters", () => {
    const { container } = render(<SignUpPage />);
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});
