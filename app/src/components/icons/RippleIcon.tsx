import rippleIconAsset from "./rippleIconAsset.json";

interface RippleIconProps {
  size?: number;
  className?: string;
}

export const RIPPLE_ICON_ASSET_PATH = rippleIconAsset.path;
export const RIPPLE_ICON_ASSET_VERSION = rippleIconAsset.version;
export const RIPPLE_ICON_SRC = `${RIPPLE_ICON_ASSET_PATH}?v=${RIPPLE_ICON_ASSET_VERSION}`;

export default function RippleIcon({ size = 24, className = "" }: RippleIconProps) {
  return (
    <img
      src={RIPPLE_ICON_SRC}
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
