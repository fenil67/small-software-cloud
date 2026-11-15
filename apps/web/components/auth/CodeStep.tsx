"use client";

import { useState, useEffect } from "react";

interface CodeStepProps {
  email: string;
  code: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onResend: () => void;
  error?: string;
  formError?: string;
  loading?: boolean;
  resendCooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30_000;

export function CodeStep({
  email,
  code,
  onChange,
  onSubmit,
  onResend,
  error,
  formError,
  loading,
  resendCooldownMs = DEFAULT_COOLDOWN_MS,
}: CodeStepProps) {
  const [cooldownUntil, setCooldownUntil] = useState<number>(
    () => Date.now() + resendCooldownMs,
  );
  const [remaining, setRemaining] = useState<number>(
    () => Math.ceil(resendCooldownMs / 1000),
  );

  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => {
      const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (left <= 0) {
        setRemaining(0);
        clearInterval(id);
      } else {
        setRemaining(left);
      }
    }, 500);
    return () => clearInterval(id);
  }, [cooldownUntil, remaining]);

  function handleResend() {
    onResend();
    setCooldownUntil(Date.now() + resendCooldownMs);
    setRemaining(Math.ceil(resendCooldownMs / 1000));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <p className="mb-4 text-sm text-fg-2">
        We sent a 6 digit code to <span className="text-fg font-medium">{email}</span>
      </p>
      <label className="block text-sm font-medium text-fg-2 mb-1.5" htmlFor="code">
        Verification code
      </label>
      <input
        id="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        value={code}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        disabled={loading}
        aria-describedby={error ? "code-error" : undefined}
        aria-invalid={!!error}
        maxLength={6}
        className={[
          "w-full rounded-xl border bg-surface-2 px-4 py-2.5 text-sm text-fg tracking-[0.25em]",
          "outline-none focus:ring-2 focus:ring-line-strong transition-shadow",
          "disabled:opacity-50",
          error ? "border-red" : "border-line focus:border-line-strong",
        ].join(" ")}
        placeholder="000000"
      />
      {error && (
        <p id="code-error" role="alert" className="mt-1.5 text-xs text-red">
          {error}
        </p>
      )}
      {formError && (
        <p role="alert" className="mt-3 rounded-lg bg-red/10 px-3 py-2 text-xs text-red">
          {formError}
        </p>
      )}
      <button
        type="submit"
        disabled={loading || code.length < 6}
        className="mt-4 w-full rounded-xl bg-btn-bg px-4 py-2.5 text-sm font-semibold text-btn-fg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Verifying…" : "Verify"}
      </button>
      <div className="mt-3 text-center">
        {remaining > 0 ? (
          <span className="text-xs text-fg-3">Resend code in {remaining}s</span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={loading}
            className="text-xs text-fg-2 underline underline-offset-3 hover:text-fg disabled:opacity-50"
          >
            Resend code
          </button>
        )}
      </div>
    </form>
  );
}
