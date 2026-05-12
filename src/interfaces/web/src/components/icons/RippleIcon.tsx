import Image from "next/image";

interface RippleIconProps {
  size?: number;
  className?: string;
}

export default function RippleIcon({ size = 24, className = "" }: RippleIconProps) {
  return (
    <Image
      src="/ripple-icon.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      draggable={false}
      loading="eager"
      unoptimized
    />
  );
}
