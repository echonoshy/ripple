import type { ConnectorInfo, ConnectorStatus } from "@/types";

export type ConnectorStatusTone = "connected" | "needs_setup" | "unknown";
export type ConnectorKind = ConnectorInfo["kind"];
export interface ConnectorGroupSection {
  kind: ConnectorKind;
  title: string;
  connectors: ConnectorInfo[];
}

export function connectorKindLabel(kind: ConnectorKind): string {
  return kind === "runtime_capability" ? "Runtime Capability" : "User Connector";
}

export function connectorGroupSections(connectors: ConnectorInfo[]): ConnectorGroupSection[] {
  const runtime = connectors.filter((connector) => connector.kind === "runtime_capability");
  const user = connectors.filter((connector) => connector.kind !== "runtime_capability");
  const sections: ConnectorGroupSection[] = [
    { kind: "runtime_capability", title: "Runtime Capabilities", connectors: runtime },
    { kind: "user_connector", title: "User Connectors", connectors: user },
  ];
  return sections.filter((section) => section.connectors.length > 0);
}

export function connectorStatusTone(
  status: ConnectorStatus | null | undefined
): ConnectorStatusTone {
  if (!status) return "unknown";
  return status.connected ? "connected" : "needs_setup";
}
