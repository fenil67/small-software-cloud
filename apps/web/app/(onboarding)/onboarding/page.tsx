import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { OnboardingClient } from "./OnboardingClient";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const [{ orgId }, user, params] = await Promise.all([auth(), currentUser(), searchParams]);
  const forceNew = params.new === "1";

  // If the user already has an org and is not explicitly creating a new one, skip onboarding
  if (orgId && !forceNew) redirect("/apps");

  const firstName = user?.firstName ?? null;

  return <OnboardingClient firstName={firstName} forceNew={forceNew} />;
}
