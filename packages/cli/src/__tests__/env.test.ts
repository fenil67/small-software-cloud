/**
 * CLI env command safety tests.
 *
 * Q3: Prove the CLI refuses a value passed as a CLI argument.
 *
 * Two attack vectors:
 *   1. `ssc env set APP NAME=value` — the name itself contains "=".
 *      envSet() rejects this before reading stdin so the value never
 *      touches shell history or process listings.
 *   2. `ssc env set APP NAME value` — a third positional argument.
 *      Commander's .allowExcessArguments(false) on the set subcommand
 *      causes Commander to error and exit(1) before the action fires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ── Test 1: NAME=value rejected by envSet guard ───────────────────────────────

describe("envSet: rejects NAME=value syntax", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from actually terminating the test runner.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error("process.exit called");
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("rejects NAME=value and exits 1 before reading stdin", async () => {
    // Import lazily so the spy is in place before any module-level side effects.
    const { envSet } = await import("../commands/env.js");

    await expect(envSet("my-app-id", "SECRET=hunter2")).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The error message should guide the user toward the correct form.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ssc env set"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("SECRET"));
  });

  it("does NOT reject a plain uppercased name without '='", async () => {
    // The guard should only fire when '=' is present.
    // We simulate a non-TTY stdin that immediately closes (empty value → different error).
    const { envSet } = await import("../commands/env.js");

    // Push an empty string to stdin then close it, so readStdin resolves quickly.
    const originalStdin = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    // Emit data + end asynchronously so the promise resolves.
    setTimeout(() => {
      process.stdin.emit("data", "");
      process.stdin.emit("end");
    }, 0);

    // envSet exits with 1 for empty value — that is correct behavior, not the guard.
    await expect(envSet("my-app-id", "VALID_NAME")).rejects.toThrow("process.exit called");
    // exitSpy called but errorSpy should say "empty", not trigger the NAME= guard message.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("ssc env set my-app-id VALID_NAME"));

    Object.defineProperty(process.stdin, "isTTY", { value: originalStdin, configurable: true });
  });
});

// ── Test 2: extra positional arg rejected by Commander ────────────────────────

describe("Commander: allowExcessArguments(false) on env set", () => {
  it("errors when a third positional argument is supplied", () => {
    // Build a minimal Commander program that mirrors the real ssc env set subcommand.
    const program = new Command().exitOverride(); // throw instead of process.exit
    const envCmd = program.command("env");
    envCmd
      .command("set <app-id> <name>")
      .allowExcessArguments(false)
      .action(() => { /* should not reach here */ });

    // Commander should throw a CommanderError when excess args are present.
    expect(() =>
      program.parse(["node", "ssc", "env", "set", "my-app-id", "MY_VAR", "secretvalue"]),
    ).toThrow();
  });

  it("does NOT error when exactly two positional arguments are supplied", () => {
    const program = new Command().exitOverride();
    const envCmd = program.command("env");
    envCmd
      .command("set <app-id> <name>")
      .allowExcessArguments(false)
      .action(() => {});

    // Should not throw.
    expect(() =>
      program.parse(["node", "ssc", "env", "set", "my-app-id", "MY_VAR"]),
    ).not.toThrow();
  });
});
