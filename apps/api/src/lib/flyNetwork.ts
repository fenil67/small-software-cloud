/**
 * networkForOrg — returns the Fly private-network name for an SSC org.
 *
 * Network names are assigned at Fly app creation and cannot change, so the
 * mapping must be deterministic.  We derive it from the org's UUID so every
 * app in the same org lands on the same network automatically.
 *
 * Format: "ssc-" + orgId with dashes removed, lowercased.
 * Example: "ssc-" + "a1b2c3d4e5f64a5b8c9d0e1f2a3b4c5d" → "ssc-a1b2c3d4e5f64a5b8c9d0e1f2a3b4c5d"
 *
 * Properties:
 *   - Starts with the letter "s" (Fly requires names to start with a letter).
 *   - Contains only [a-z0-9-].
 *   - Deterministic: same orgId always yields the same network name.
 *   - Distinct: different orgIds yield different network names (UUID collision-free).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function networkForOrg(orgId: string): string {
  if (!orgId) {
    throw new Error("networkForOrg: orgId is required");
  }
  if (!UUID_RE.test(orgId)) {
    throw new Error(`networkForOrg: orgId is not a valid UUID: ${orgId}`);
  }
  return "ssc-" + orgId.replace(/-/g, "").toLowerCase();
}
