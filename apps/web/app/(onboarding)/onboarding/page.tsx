import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { OnboardingClient } from "./OnboardingClient";

export default async function OnboardingPage() {
  const [{ orgId }, user] = await Promise.all([auth(), currentUser()]);
  if (orgId) redirect("/apps");

  const firstName = user?.firstName ?? null;

  return <OnboardingClient firstName={firstName} />;
}
