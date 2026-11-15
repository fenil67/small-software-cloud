"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { OAuthButtons } from "../../../components/auth/OAuthButtons";
import { EmailStep } from "../../../components/auth/EmailStep";
import { CodeStep } from "../../../components/auth/CodeStep";
import { authErrorMessage } from "../../../lib/auth-errors";
import { safeRedirectPath } from "../../../lib/safe-redirect";

const REDIRECT_PARAM = "redirect_url";

type Step = "email" | "code";

function hasClerkCode(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null || !("errors" in err)) return false;
  const errs = (err as { errors: unknown[] }).errors;
  return Array.isArray(errs) &&
    errs.some((e) => typeof e === "object" && e !== null && (e as { code?: string }).code === code);
}

function warnClerkCode(err: unknown) {
  if (process.env.NODE_ENV !== "production") {
    if (typeof err === "object" && err !== null && "errors" in err) {
      const errs = (err as { errors: Array<{ code?: string }> }).errors;
      const code = errs[0]?.code ?? "unknown";
      console.warn("[auth] clerk error code", code);
    }
  }
}

export default function SignInPage() {
  const router = useRouter();
  const { signIn, fetchStatus } = useSignIn();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  const loading = fetchStatus === "fetching";

  function getRedirectPath(): string {
    if (typeof window === "undefined") return "/dashboard";
    const params = new URLSearchParams(window.location.search);
    const param = params.get(REDIRECT_PARAM);
    if (!param) return "/dashboard";
    return safeRedirectPath(param, window.location.origin) || "/dashboard";
  }

  async function handleSso(strategy: "oauth_google" | "oauth_github") {
    setFormError(undefined);
    const dest = getRedirectPath();
    const { error } = await signIn.sso({
      strategy,
      // redirectUrl: final destination for the happy path (session created)
      redirectUrl: dest,
      // redirectCallbackUrl: where Clerk sends the browser when session needs more steps
      redirectCallbackUrl: `/sso-callback?redirect_url=${encodeURIComponent(dest)}`,
    });
    if (error) {
      warnClerkCode(error);
      const mapped = authErrorMessage(error);
      setFormError(mapped.message);
    }
  }

  async function handleEmailSubmit() {
    setEmailError(undefined);
    setFormError(undefined);

    let result = await signIn.emailCode.sendCode({ emailAddress: email.trim() });

    // Stale attempt from a previous flow: retry once to start fresh
    if (
      result.error &&
      !hasClerkCode(result.error, "session_exists") &&
      !hasClerkCode(result.error, "single_session_mode_enabled") &&
      authErrorMessage(result.error).field !== "email"
    ) {
      warnClerkCode(result.error);
      result = await signIn.emailCode.sendCode({ emailAddress: email.trim() });
    }

    if (result.error) {
      warnClerkCode(result.error);

      // Already signed in — go straight to destination
      if (
        hasClerkCode(result.error, "session_exists") ||
        hasClerkCode(result.error, "single_session_mode_enabled")
      ) {
        router.replace(getRedirectPath());
        return;
      }

      const mapped = authErrorMessage(result.error);
      if (mapped.field === "email") {
        setEmailError(mapped.message);
      } else {
        setFormError(mapped.message);
      }
      return;
    }
    setStep("code");
  }

  async function handleCodeSubmit() {
    setCodeError(undefined);
    setFormError(undefined);
    const { error: verifyError } = await signIn.emailCode.verifyCode({ code });
    if (verifyError) {
      warnClerkCode(verifyError);
      const mapped = authErrorMessage(verifyError);
      if (mapped.field === "code") {
        setCodeError(mapped.message);
      } else {
        setFormError(mapped.message);
      }
      return;
    }
    const { error: finalizeError } = await signIn.finalize();
    if (finalizeError) {
      warnClerkCode(finalizeError);
      setFormError(authErrorMessage(finalizeError).message);
      return;
    }
    router.replace(getRedirectPath());
  }

  async function handleResend() {
    await signIn.emailCode.sendCode({ emailAddress: email.trim() });
  }

  function handleBack() {
    // Fully reset the attempt — clearing all state so the next sendCode starts fresh
    setStep("email");
    setCode("");
    setCodeError(undefined);
    setFormError(undefined);
  }

  return (
    <AuthCard title="Sign in to Utir" subtitle="Your apps, live and private.">
      {step === "email" && (
        <>
          <OAuthButtons
            onGoogle={() => handleSso("oauth_google")}
            onGithub={() => handleSso("oauth_github")}
            disabled={loading}
          />
          {formError && (
            <p role="alert" className="mt-3 rounded-lg bg-red/10 px-3 py-2 text-xs text-red">
              {formError}
            </p>
          )}
          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-line" />
            <span className="text-xs text-fg-3">or</span>
            <div className="h-px flex-1 bg-line" />
          </div>
          <EmailStep
            email={email}
            onChange={setEmail}
            onSubmit={handleEmailSubmit}
            error={emailError}
            loading={loading}
          />
          <p className="mt-4 text-center text-xs text-fg-3">
            New to Utir?{" "}
            <a href="/sign-up" className="font-medium text-fg underline underline-offset-3">
              Create an account
            </a>
          </p>
        </>
      )}

      {step === "code" && (
        <>
          <CodeStep
            email={email}
            code={code}
            onChange={setCode}
            onSubmit={handleCodeSubmit}
            onResend={handleResend}
            error={codeError}
            formError={formError}
            loading={loading}
          />
          <button
            type="button"
            onClick={handleBack}
            className="mt-3 w-full text-center text-xs text-fg-3 hover:text-fg"
          >
            ← Back
          </button>
        </>
      )}
    </AuthCard>
  );
}
