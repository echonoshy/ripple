import type { ComponentType } from "react";
import { BriefcaseBusiness, FileText, Home, Plug } from "lucide-react";

export type WorkspaceView = "home" | "tasks" | "files" | "connectors";

export interface WorkspaceNavItem {
  id: WorkspaceView;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const mainNavItems: WorkspaceNavItem[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "tasks", label: "Tasks", icon: BriefcaseBusiness },
  { id: "files", label: "Files", icon: FileText },
  { id: "connectors", label: "Connectors", icon: Plug },
];

export function viewTitle(view: WorkspaceView): string {
  return mainNavItems.find((item) => item.id === view)?.label || "Ripple";
}

export function shouldShowInspector(view: WorkspaceView): boolean {
  return view === "tasks";
}
