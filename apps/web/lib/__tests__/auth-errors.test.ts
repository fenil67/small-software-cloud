import { describe, it, expect } from "vitest";
import { authErrorMessage } from "../auth-errors";

function makeClerkError(code: string, longMessage = "An error occurred", paramName?: string) {
  return {
    errors: [
      {
        code,
        message: longMessage,
        longMessage,
        meta: paramName ? { paramName } : undefined,
      },
    ],
  };
}

// ─── Null / undefined / unknown inputs ──────────────────────────────────────

describe("authErrorMessage – null/undefined/unknown", () => {
  it("handles null", () => {
    const r = authErrorMessage(null);
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
  });

  it("handles undefined", () => {
    const r = authErrorMessage(undefined);
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
  });

  it("handles plain string", () => {
    const r = authErrorMessage("oops");
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
  });

  it("handles plain Error object", () => {
    const r = authErrorMessage(new Error("network error"));
    expect(r.field).toBe("form");
    expect(r.message).toBe("network error");
  });

  it("handles empty errors array", () => {
    const r = authErrorMessage({ errors: [] });
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
  });
});

// ─── Identifier / email errors ───────────────────────────────────────────────

describe("authErrorMessage – email field errors", () => {
  it("maps form_identifier_not_found to email field with sign-up action", () => {
    const r = authErrorMessage(makeClerkError("form_identifier_not_found"));
    expect(r.field).toBe("email");
    expect(r.message).toBe("We could not find an account with that email.");
    expect(r.action).toBe("sign-up");
  });

  it("maps identification_failure to email field with sign-up action", () => {
    const r = authErrorMessage(makeClerkError("identification_failure"));
    expect(r.field).toBe("email");
    expect(r.message).toBe("We could not find an account with that email.");
    expect(r.action).toBe("sign-up");
  });

  it("maps form_identifier_exists to email field with sign-in action", () => {
    const r = authErrorMessage(makeClerkError("form_identifier_exists"));
    expect(r.field).toBe("email");
    expect(r.message).toBe("An account with this email already exists.");
    expect(r.action).toBe("sign-in");
  });

  it("maps form_param_format_invalid on email_address to email field", () => {
    const r = authErrorMessage(
      makeClerkError("form_param_format_invalid", "Invalid format", "email_address"),
    );
    expect(r.field).toBe("email");
    expect(r.message).toBe("Enter a valid email address.");
  });

  it("maps form_param_nil on email_address to email field", () => {
    const r = authErrorMessage(
      makeClerkError("form_param_nil", "Required", "email_address"),
    );
    expect(r.field).toBe("email");
    expect(r.message).toBe("Enter your email address.");
  });
});

// ─── Code (OTP) errors ───────────────────────────────────────────────────────

describe("authErrorMessage – code field errors", () => {
  it("maps form_code_incorrect to code field", () => {
    const r = authErrorMessage(makeClerkError("form_code_incorrect"));
    expect(r.field).toBe("code");
    expect(r.message).toBe("That code is not right. Check the email and try again.");
  });

  it("maps verification_failed to code field", () => {
    const r = authErrorMessage(makeClerkError("verification_failed"));
    expect(r.field).toBe("code");
    expect(r.message).toBe("That code is not right. Check the email and try again.");
  });

  it("maps verification_expired to code field", () => {
    const r = authErrorMessage(makeClerkError("verification_expired"));
    expect(r.field).toBe("code");
    expect(r.message).toBe("That code expired. Send a new one.");
  });
});

// ─── Form-level errors ───────────────────────────────────────────────────────

describe("authErrorMessage – form field errors", () => {
  it("maps too_many_requests to form field", () => {
    const r = authErrorMessage(makeClerkError("too_many_requests"));
    expect(r.field).toBe("form");
    expect(r.message).toBe("Too many tries. Wait a minute and try again.");
  });

  it("unknown Clerk code returns generic message and never leaks Clerk text", () => {
    const r = authErrorMessage(makeClerkError("some_unknown_code", "SECRET_CLERK_TEXT"));
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
    expect(r.message).not.toContain("SECRET_CLERK_TEXT");
  });

  it("falls back to generic message when longMessage is empty", () => {
    const r = authErrorMessage({
      errors: [{ code: "unknown", message: "", longMessage: "" }],
    });
    expect(r.field).toBe("form");
    expect(r.message).toBe("Something went wrong. Try again.");
  });
});
