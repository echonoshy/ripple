import React from "react";

export type IconTileTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type IconTileSize = "xs" | "sm" | "md" | "lg" | "xl";

export const ACTION_ICON_SIZE = 14;
export const ACTION_ICON_STROKE_WIDTH = 2.2;

const tileToneClass: Record<IconTileTone, string> = {
  neutral: "border-[#DEE0E3] bg-[#F5F6F7] text-[#646A73]",
  accent: "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]",
  success: "border-[#22A06B]/20 bg-[#E4F8EE] text-[#16845B]",
  warning: "border-[#FAD355]/45 bg-[#FFF8DB] text-[#8B5E00]",
  danger: "border-[#FAD4D4] bg-[#FFF1F0] text-[#B42318]",
};

const tileSizeClass: Record<IconTileSize, string> = {
  xs: "h-6 w-6 rounded-lg",
  sm: "h-7 w-7 rounded-lg",
  md: "h-8 w-8 rounded-xl",
  lg: "h-10 w-10 rounded-xl",
  xl: "h-11 w-11 rounded-xl",
};

interface IconTileProps {
  tone?: IconTileTone;
  size?: IconTileSize;
  className?: string;
  children: React.ReactNode;
}

export function IconTile({
  tone = "neutral",
  size = "md",
  className = "",
  children,
}: IconTileProps) {
  return (
    <span
      data-ripple-icon-tile="true"
      data-tone={tone}
      className={`inline-flex shrink-0 items-center justify-center border ${tileSizeClass[size]} ${tileToneClass[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

interface ActionIconProps {
  label: string;
  className?: string;
  children: React.ReactNode;
}

export function ActionIcon({ label, className = "", children }: ActionIconProps) {
  return (
    <span
      data-ripple-action-icon="true"
      role="img"
      aria-label={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#2B2F36] ${className}`}
    >
      {children}
    </span>
  );
}
