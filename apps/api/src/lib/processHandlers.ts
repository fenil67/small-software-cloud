import { safeErr } from "./safeErr";

/**
 * Installs process-level last-resort handlers.
 *
 * uncaughtException — logs with safeErr then exits 1 so the process manager
 *   (Railway, Docker) can restart it.  Continuing after an uncaught exception
 *   would leave the app in an undefined state.
 *
 * unhandledRejection — logs with safeErr but does NOT exit; unhandled promise
 *   rejections are usually non-fatal and exiting would take down in-flight
 *   requests.  Individual async handlers must still call next(err).
 */
export function installProcessHandlers(): void {
  process.on("uncaughtException", (err) => {
    console.error("[process] uncaughtException", safeErr(err));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandledRejection", safeErr(reason));
  });
}
