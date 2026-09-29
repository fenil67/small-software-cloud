import { auth, currentUser } from "@clerk/nextjs/server";

export default async function DashboardPage() {
  const { orgId, orgSlug } = await auth();
  const user = await currentUser();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-12 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-white">
          Welcome{user?.firstName ? `, ${user.firstName}` : ""}
        </h1>
        <p className="text-gray-400">
          {orgId
            ? `You're working in org: ${orgSlug ?? orgId}`
            : "No org selected — use the switcher above to create or join one."}
        </p>
      </div>

      {/* Placeholder cards for Phase 1 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 w-full max-w-2xl">
        {["Deploy an app", "View deployments", "Manage access"].map(
          (label) => (
            <div
              key={label}
              className="rounded-lg border border-gray-700 bg-gray-900 p-6 text-sm text-gray-400"
            >
              {label}
              <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-500">
                coming soon
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
