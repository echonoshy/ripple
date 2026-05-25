interface RippleIconProps {
  size?: number;
  className?: string;
}

export default function RippleIcon({ size = 24, className = "" }: RippleIconProps) {
  return (
    <img
      src="/assets/ripple-icon.svg?v=20260516-r9"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      draggable={false}
      loading="eager"
    />
  );
}
