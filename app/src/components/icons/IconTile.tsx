import React from "react";

export type IconTileTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type IconTileSize = "xs" | "sm" | "md" | "lg" | "xl";

export const ACTION_ICON_SIZE = 14;
export const ACTION_ICON_STROKE_WIDTH = 2.2;

const tileToneClass: Record<IconTileTone, string> = {
  neutral: "border-[#dfe6f4] bg-[#f6f8ff] text-[#667085]",
  accent: "border-[#d7e3f8] bg-[#eef4ff] text-[#2463eb]",
  success: "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]",
  warning: "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]",
  danger: "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]",
};

const tileSizeClass: Record<IconTileSize, string> = {
  xs: "h-6 w-6 rounded-lg",
  sm: "h-7 w-7 rounded-lg",
  md: "h-8 w-8 rounded-xl",
  lg: "h-10 w-10 rounded-xl",
  xl: "h-11 w-11 rounded-[14px]",
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
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#4b5563] ${className}`}
    >
      {children}
    </span>
  );
}
