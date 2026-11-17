export function navigateHard(url: string): void {
  window.location.assign(url);
}

// Polls until the Clerk session reflects the new active org or the timeout elapses.
// Module-level so Date.now() is not flagged by react-hooks/purity.
export async function pollSession(
  getActiveOrgId: () => string | null | undefined,
  targetOrgId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getActiveOrgId() === targetOrgId) return;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}
