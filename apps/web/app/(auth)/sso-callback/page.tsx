"use client";

import { useSearchParams } from "next/navigation";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { safeRedirectPath } from "../../../lib/safe-redirect";

export default function SsoCallbackPage() {
  const params = useSearchParams();
  // Destination was encoded into redirectCallbackUrl by the sign-in/sign-up page.
  // Validate it with safeRedirectPath; fall back to /dashboard.
  const destination =
    safeRedirectPath(params.get("redirect_url"), typeof window !== "undefined" ? window.location.origin : "") ||
    "/dashboard";

  return (
    <AuthCard title="Signing you in">
      <div className="flex flex-col items-center gap-3 py-4">
        <Spinner />
        <p className="text-sm text-fg-3">Please wait…</p>
      </div>
      <AuthenticateWithRedirectCallback
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
        signInForceRedirectUrl={destination}
        signUpForceRedirectUrl={destination}
      />
    </AuthCard>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6 animate-spin text-fg-2 motion-reduce:hidden"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
