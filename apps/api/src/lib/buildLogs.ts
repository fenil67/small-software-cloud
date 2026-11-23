/**
 * Build log storage helpers.
 *
 * scrubSecrets is applied by deployRunner before lines reach the eventBus, so
 * content is already scrubbed at collection time.  The GET route applies it
 * again at read time as defence-in-depth.
 *
 * Truncation: if the joined content exceeds 1 MB, the middle is replaced with a
 * "... [log truncated] ..." marker, keeping ~480 KB from each end.
 */

import { pool } from "../db";

const MAX_LOG_BYTES = 1_000_000; // 1 MB
const HALF_BYTES    =   480_000; // ~480 KB each half; leaves room for the marker

export function truncateLogs(lines: string[]): { content: string; truncated: boolean } {
  const full = lines.join("\n");
  const buf = Buffer.from(full, "utf8");
  if (buf.length <= MAX_LOG_BYTES) {
    return { content: full, truncated: false };
  }
  // Slice bytes and decode — lone surrogates may be introduced at the boundary
  // but that is acceptable for log display (the content is already ASCII-safe
  // after scrubSecrets).
  const head = buf.subarray(0, HALF_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - HALF_BYTES).toString("utf8");
  return {
    content: head + "\n... [log truncated] ...\n" + tail,
    truncated: true,
  };
}

/** Persist the collected build log lines for a deployment (best-effort). */
export async function saveBuildLog(deploymentId: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const { content, truncated } = truncateLogs(lines);
  await pool.query(
    `INSERT INTO deployment_build_logs (deployment_id, content, truncated)
     VALUES ($1, $2, $3)
     ON CONFLICT (deployment_id) DO NOTHING`,
    [deploymentId, content, truncated],
  );
}
