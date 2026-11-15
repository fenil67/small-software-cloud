"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { OAuthButtons } from "../../../components/auth/OAuthButtons";
import { EmailStep } from "../../../components/auth/EmailStep";
import { CodeStep } from "../../../components/auth/CodeStep";
import { authErrorMessage } from "../../../lib/auth-errors";
import { safeRedirectPath } from "../../../lib/safe-redirect";

const REDIRECT_PARAM = "redirect_url";

type Step = "email" | "code";

function warnClerkCode(err: unknown) {
  if (process.env.NODE_ENV !== "production") {
    if (typeof err === "object" && err !== null && "errors" in err) {
      const errs = (err as { errors: Array<{ code?: string }> }).errors;
      const code = errs[0]?.code ?? "unknown";
      console.warn("[auth] clerk error code", code);
    }
  }
}

export default function SignUpPage() {
  const router = useRouter();
  const { signUp, fetchStatus } = useSignUp();

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
    const { error } = await signUp.sso({
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
    const { error: createError } = await signUp.create({ emailAddress: email.trim() });
    if (createError) {
      warnClerkCode(createError);
      const mapped = authErrorMessage(createError);
      if (mapped.field === "email") {
        setEmailError(mapped.message);
      } else {
        setFormError(mapped.message);
      }
      return;
    }
    const { error: sendError } = await signUp.verifications.sendEmailCode();
    if (sendError) {
      warnClerkCode(sendError);
      const mapped = authErrorMessage(sendError);
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
    const { error: verifyError } = await signUp.verifications.verifyEmailCode({ code });
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
    const { error: finalizeError } = await signUp.finalize();
    if (finalizeError) {
      warnClerkCode(finalizeError);
      setFormError(authErrorMessage(finalizeError).message);
      return;
    }
    router.replace(getRedirectPath());
  }

  async function handleResend() {
    await signUp.verifications.sendEmailCode();
  }

  function handleBack() {
    setStep("email");
    setCode("");
    setCodeError(undefined);
    setFormError(undefined);
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Put your apps online, private to the people you choose."
    >
      {/* Captcha widget mount point — Clerk renders here when bot protection enabled */}
      <div id="clerk-captcha" />

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
            submitLabel="Create account"
          />
          <p className="mt-4 text-center text-xs text-fg-3">
            Already have an account?{" "}
            <a href="/sign-in" className="font-medium text-fg underline underline-offset-3">
              Sign in
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
