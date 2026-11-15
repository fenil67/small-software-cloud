/**
 * Logo render assertions.
 *
 * The auth layout uses <Logo /> (default height=40).
 * Both img elements must have height 40px and width auto so the aspect ratio
 * constraint is satisfied and the image doesn't render at its natural size.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Logo } from "../Logo";

// next/image renders a standard <img> in the test environment
vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    const { priority: _p, ...rest } = props;
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...rest} />;
  },
}));

describe("Logo – default height=40, width=auto", () => {
  it("the visible img has height 40px in its style", () => {
    const { container } = render(<Logo />);
    // First img is the visible one (logo-on-dark); second is aria-hidden
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    const visible = imgs[0] as HTMLImageElement;
    expect(visible.style.height).toBe("40px");
  });

  it("the visible img has width auto in its style", () => {
    const { container } = render(<Logo />);
    const visible = container.querySelectorAll("img")[0] as HTMLImageElement;
    expect(visible.style.width).toBe("auto");
  });

  it("accepts a custom height prop", () => {
    const { container } = render(<Logo height={28} />);
    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.height).toBe("28px");
    }
  });
});
