"use client";

import { Folder, PackageOpen, Sparkles, Upload } from "lucide-react";
import { WORKSPACE_FIXED_PLACES, type WorkspacePlace } from "@/lib/workspaceFileCenter";
import {
  TYPOGRAPHY_META_CLASS,
  TYPOGRAPHY_META_MEDIUM_CLASS,
} from "@/components/workbench/stylePrimitives";

interface WorkspacePlacesNavProps {
  currentPlace: WorkspacePlace;
  onOpenPlace: (place: WorkspacePlace) => void;
}

const placeIcons: Record<Exclude<WorkspacePlace, "workspace">, typeof Folder> = {
  skills: Sparkles,
  uploads: Upload,
  outputs: PackageOpen,
};

export default function WorkspacePlacesNav({ currentPlace, onOpenPlace }: WorkspacePlacesNavProps) {
  return (
    <nav
      data-ripple-workspace-places
      className={`flex min-w-0 gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] ${TYPOGRAPHY_META_CLASS}`}
      aria-label="Workspace places"
    >
      {WORKSPACE_FIXED_PLACES.map((place) => {
        const Icon = placeIcons[place.id];
        const active = currentPlace === place.id;
        return (
          <button
            key={place.id}
            type="button"
            data-ripple-workspace-place={place.id}
            onClick={() => onOpenPlace(place.id)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 transition-colors ${
              active
                ? "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]"
                : "border-[#DEE0E3] bg-white/72 text-[#46556f] hover:bg-[#F8F9FA] hover:text-[#1F2329]"
            } ${TYPOGRAPHY_META_MEDIUM_CLASS}`}
          >
            <Icon size={13} />
            <span>{place.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
