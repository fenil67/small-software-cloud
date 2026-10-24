import fs from "fs/promises";
import os from "os";
import path from "path";

/** Create a fresh temp directory under os.tmpdir() and return its path. */
export async function makeTempDir(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), `${prefix}-`);
  return await fs.mkdtemp(base);
}

/** Best-effort recursive deletion — never throws so cleanup failures don't
 *  mask the real error. */
export async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // intentionally swallowed
  }
}
