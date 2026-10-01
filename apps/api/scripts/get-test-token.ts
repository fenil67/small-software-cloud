/**
 * Mint a fresh Clerk session token for manual API testing.
 *
 * Usage:
 *   pnpm run get-token                        # uses first user in your Clerk instance
 *   pnpm run get-token -- --user <clerk-user-id>
 *
 * Output: a Bearer token valid for 5 minutes, printed to stdout.
 * Copy it directly into curl:
 *
 *   TOKEN=$(pnpm --silent run get-token)
 *   curl -X POST http://localhost:4000/v1/deployments/intake/github \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"github_url":"https://github.com/render-examples/express-hello-world"}'
 *
 * Requirements: CLERK_SECRET_KEY must be set (apps/api/.env is loaded automatically).
 */

import "dotenv/config";
import { createClerkClient } from "@clerk/express";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

async function main() {
  // Parse --user <id> from argv, fall back to first user
  const userFlagIdx = process.argv.indexOf("--user");
  let userId: string;

  if (userFlagIdx !== -1 && process.argv[userFlagIdx + 1]) {
    userId = process.argv[userFlagIdx + 1];
  } else {
    const { data: users } = await clerk.users.getUserList({ limit: 1 });
    if (users.length === 0) {
      console.error("No users found in Clerk. Create a user via the dashboard first.");
      process.exit(1);
    }
    userId = users[0].id;
    console.error(`Using user: ${users[0].emailAddresses[0]?.emailAddress ?? userId}`);
  }

  // Create a fresh session for the user, then mint a token valid for 5 minutes
  const session = await clerk.sessions.createSession({ userId });
  const token = await clerk.sessions.getToken(session.id, undefined, 300);

  // Print only the JWT to stdout so scripts can capture it with $()
  console.log(token.jwt);
}

main().catch((err) => {
  console.error("get-test-token failed:", err?.message ?? err);
  process.exit(1);
});
