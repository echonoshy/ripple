import type { ConnectorInfo, ConnectorStatus } from "@/types";

export type ConnectorStatusTone = "connected" | "needs_setup" | "unknown";
export type ConnectorKind = ConnectorInfo["kind"];
export interface ConnectorGroupSection {
  kind: ConnectorKind;
  title: string;
  connectors: ConnectorInfo[];
}

export interface ConnectorReadinessSummary {
  connected: number;
  total: number;
}

export function connectorKindLabel(kind: ConnectorKind): string {
  return kind === "runtime_capability" ? "Runtime Capability" : "User Connector";
}

export function userConnectors(connectors: ConnectorInfo[]): ConnectorInfo[] {
  return connectors.filter((connector) => connector.kind !== "runtime_capability");
}

export function connectorReadinessSummary(
  connectors: ConnectorInfo[],
  statuses: Record<string, ConnectorStatus>
): ConnectorReadinessSummary {
  const user = userConnectors(connectors);
  return {
    connected: user.filter((connector) => statuses[connector.name]?.connected).length,
    total: user.length,
  };
}

export function connectorGroupSections(connectors: ConnectorInfo[]): ConnectorGroupSection[] {
  const sections: ConnectorGroupSection[] = [
    { kind: "user_connector", title: "User Connectors", connectors: userConnectors(connectors) },
  ];
  return sections.filter((section) => section.connectors.length > 0);
}

export function connectorStatusTone(
  status: ConnectorStatus | null | undefined
): ConnectorStatusTone {
  if (!status) return "unknown";
  return status.connected ? "connected" : "needs_setup";
}
