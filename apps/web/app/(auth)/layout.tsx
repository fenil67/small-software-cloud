import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Logo } from "../../components/brand/Logo";
import { ThemeSwitch } from "../../components/theme/ThemeSwitch";
import { parseTheme, THEME_COOKIE } from "../../lib/theme";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12 bg-bg">
      <Logo />
      <main className="w-full max-w-sm">{children}</main>
      <ThemeSwitch initialTheme={theme} />
    </div>
  );
}
