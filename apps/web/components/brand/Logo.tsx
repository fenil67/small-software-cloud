import Image from "next/image";

interface LogoProps {
  height?: number;
}

export function Logo({ height = 40 }: LogoProps) {
  return (
    <span className="inline-block">
      <Image
        src="/brand/utir-horizontal-color-on-dark.svg"
        alt="Utir"
        width={80}
        height={height}
        priority
        style={{ width: "auto", height: `${height}px` }}
        className="logo-on-dark"
      />
      <Image
        src="/brand/utir-horizontal-color-on-light.svg"
        alt="Utir"
        width={80}
        height={height}
        priority
        style={{ width: "auto", height: `${height}px` }}
        className="logo-on-light"
        aria-hidden="true"
      />
    </span>
  );
}
