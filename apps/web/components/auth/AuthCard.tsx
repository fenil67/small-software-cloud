import type { ReactNode } from "react";

interface AuthCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <div className="w-full max-w-sm rounded-2xl bg-surface border border-line p-8">
      <div className="mb-6 text-center">
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-fg-2">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
