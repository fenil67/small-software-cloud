import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-screen flex-col">
      {/* Top nav */}
      <header className="flex h-14 items-center justify-between border-b border-gray-800 bg-gray-900 px-6">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold tracking-tight text-white">
            Small Software Cloud
          </span>
          {/* Org switcher — shows personal/org selector */}
          <OrganizationSwitcher
            hidePersonal={false}
            afterSelectOrganizationUrl="/dashboard"
            afterSelectPersonalUrl="/dashboard"
            appearance={{
              elements: {
                organizationSwitcherTrigger:
                  "text-gray-200 hover:bg-gray-800 rounded px-2 py-1 text-sm",
              },
            }}
          />
        </div>
        <UserButton />
      </header>

      {/* Page content */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
