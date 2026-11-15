"use client";

interface EmailStepProps {
  email: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  error?: string;
  formError?: string;
  loading?: boolean;
  submitLabel?: string;
}

export function EmailStep({
  email,
  onChange,
  onSubmit,
  error,
  formError,
  loading,
  submitLabel = "Continue",
}: EmailStepProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      noValidate
    >
      <label className="block text-sm font-medium text-fg-2 mb-1.5" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        autoFocus
        required
        value={email}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        aria-describedby={error ? "email-error" : undefined}
        aria-invalid={!!error}
        className={[
          "w-full rounded-xl border bg-surface-2 px-4 py-2.5 text-sm text-fg placeholder:text-fg-3",
          "outline-none focus:ring-2 focus:ring-line-strong transition-shadow",
          "disabled:opacity-50",
          error ? "border-red" : "border-line focus:border-line-strong",
        ].join(" ")}
        placeholder="you@company.com"
      />
      {error && (
        <p id="email-error" role="alert" className="mt-1.5 text-xs text-red">
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
        disabled={loading || !email.trim()}
        className="mt-4 w-full rounded-xl bg-btn-bg px-4 py-2.5 text-sm font-semibold text-btn-fg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Loading…" : submitLabel}
      </button>
    </form>
  );
}
