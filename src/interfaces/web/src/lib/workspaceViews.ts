import type { ComponentType } from "react";
import { CalendarClock, FileText, Home, MessagesSquare, Plug } from "lucide-react";

export type WorkspaceView = "home" | "sessions" | "automations" | "files" | "connectors";

export interface WorkspaceNavItem {
  id: WorkspaceView;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const mainNavItems: WorkspaceNavItem[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "sessions", label: "Sessions", icon: MessagesSquare },
  { id: "automations", label: "Automations", icon: CalendarClock },
  { id: "files", label: "Files", icon: FileText },
  { id: "connectors", label: "Connectors", icon: Plug },
];

export function viewTitle(view: WorkspaceView): string {
  return mainNavItems.find((item) => item.id === view)?.label || "Ripple";
}

export function shouldShowInspector(view: WorkspaceView): boolean {
  return view === "sessions";
}
