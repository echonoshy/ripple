import type { ComponentType } from "react";
import { FileText, ListTodo, MessageCircle, Settings, Sparkles } from "lucide-react";

export type WorkspaceView =
  | "home"
  | "sessions"
  | "tasks"
  | "automations"
  | "files"
  | "skills"
  | "connectors";

export interface WorkspaceNavItem {
  id: WorkspaceView;
  label: string;
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
}

export const mainNavItems: WorkspaceNavItem[] = [
  { id: "sessions", label: "Sessions", icon: MessageCircle },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "files", label: "Files", icon: FileText },
  { id: "skills", label: "Skills", icon: Sparkles },
];

export const mobileNavItems: WorkspaceNavItem[] = [
  ...mainNavItems,
  { id: "home", label: "Settings", icon: Settings },
];

export function viewTitle(view: WorkspaceView): string {
  if (view === "connectors") return "Skills";
  return mobileNavItems.find((item) => item.id === view)?.label || "Ripple";
}

export function shouldShowInspector(view: WorkspaceView): boolean {
  return view === "sessions";
}
