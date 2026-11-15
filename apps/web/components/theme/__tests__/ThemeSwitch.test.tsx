import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeSwitch } from "../ThemeSwitch";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pressedButton(name: RegExp) {
  return screen.getByRole("button", { name });
}

// ─── BUG 1: ThemeSwitch state ─────────────────────────────────────────────────

describe("ThemeSwitch", () => {
  beforeEach(() => {
    // Reset html classes between tests
    document.documentElement.className = "";
  });

  it("initialTheme='light' → Light button is pressed, Dark is not", () => {
    render(<ThemeSwitch initialTheme="light" />);
    expect(pressedButton(/^light$/i)).toHaveAttribute("aria-pressed", "true");
    expect(pressedButton(/^dark$/i)).toHaveAttribute("aria-pressed", "false");
    expect(pressedButton(/^system$/i)).toHaveAttribute("aria-pressed", "false");
  });

  it("click System → System pressed and html has class t-system", () => {
    render(<ThemeSwitch initialTheme="light" />);
    fireEvent.click(pressedButton(/^system$/i));
    expect(pressedButton(/^system$/i)).toHaveAttribute("aria-pressed", "true");
    expect(pressedButton(/^light$/i)).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.classList.contains("t-system")).toBe(true);
    expect(document.documentElement.classList.contains("t-light")).toBe(false);
  });

  it("click Dark → html has class t-dark and Dark is pressed", () => {
    render(<ThemeSwitch initialTheme="light" />);
    fireEvent.click(pressedButton(/^dark$/i));
    expect(pressedButton(/^dark$/i)).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("t-dark")).toBe(true);
  });

  it("contains no emoji characters", () => {
    render(<ThemeSwitch initialTheme="dark" />);
    const container = screen.getByRole("group");
    // Covers common emoji Unicode ranges
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});
