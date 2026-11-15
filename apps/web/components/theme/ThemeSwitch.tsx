"use client";

import { useState } from "react";
import { type Theme, THEME_COOKIE } from "../../lib/theme";

interface ThemeSwitchProps {
  initialTheme?: Theme;
}

const THEMES: { value: Theme; label: string; Icon: () => React.JSX.Element }[] = [
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

export function ThemeSwitch({ initialTheme = "dark" }: ThemeSwitchProps) {
  const [selected, setSelected] = useState<Theme>(initialTheme);

  function setTheme(theme: Theme) {
    // eslint-disable-next-line react-hooks/immutability
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    const root = document.documentElement;
    root.classList.remove("t-dark", "t-light", "t-system");
    root.classList.add(`t-${theme}`);
    setSelected(theme);
  }

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex gap-1 rounded-lg bg-surface-2 p-1"
    >
      {THEMES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected === value}
          onClick={() => setTheme(value)}
          className={[
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            selected === value
              ? "bg-surface-4 text-fg"
              : "text-fg-2 hover:text-fg",
          ].join(" ")}
        >
          <Icon />
          {label}
        </button>
      ))}
    </div>
  );
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
