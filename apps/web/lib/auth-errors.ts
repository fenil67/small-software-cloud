export type AuthErrorResult = {
  field: "email" | "code" | "form";
  message: string;
  action?: "sign-in" | "sign-up";
};

const GENERIC = "Something went wrong. Try again.";

/**
 * Maps a Clerk error (or any thrown value) to a user-facing message and field.
 * Never leaks Clerk's internal message text.
 */
export function authErrorMessage(err: unknown): AuthErrorResult {
  if (!err) {
    return { field: "form", message: GENERIC };
  }

  // Clerk API errors carry errors[] array
  if (isClerkAPIError(err)) {
    const first = err.errors[0];
    if (!first) return { field: "form", message: GENERIC };

    const code = first.code ?? "";

    // Email-related codes
    if (
      code === "form_identifier_not_found" ||
      code === "identification_failure"
    ) {
      return {
        field: "email",
        message: "We could not find an account with that email.",
        action: "sign-up",
      };
    }
    if (code === "form_identifier_exists") {
      return {
        field: "email",
        message: "An account with this email already exists.",
        action: "sign-in",
      };
    }
    if (code === "form_param_format_invalid" && first.meta?.paramName === "email_address") {
      return { field: "email", message: "Enter a valid email address." };
    }
    if (code === "form_param_nil" && first.meta?.paramName === "email_address") {
      return { field: "email", message: "Enter your email address." };
    }

    // Code (OTP) related
    if (
      code === "form_code_incorrect" ||
      code === "verification_failed"
    ) {
      return { field: "code", message: "That code is not right. Check the email and try again." };
    }
    if (code === "verification_expired") {
      return { field: "code", message: "That code expired. Send a new one." };
    }
    if (code === "too_many_requests") {
      return { field: "form", message: "Too many tries. Wait a minute and try again." };
    }

    // Unknown Clerk code — never leak Clerk's message text
    return { field: "form", message: GENERIC };
  }

  // Plain Error (not from Clerk)
  if (err instanceof Error) {
    return { field: "form", message: err.message || GENERIC };
  }

  return { field: "form", message: GENERIC };
}

// Minimal type guard for Clerk API errors
function isClerkAPIError(
  err: unknown,
): err is { errors: Array<{ code?: string; message?: string; longMessage?: string; meta?: { paramName?: string } }> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  );
}
