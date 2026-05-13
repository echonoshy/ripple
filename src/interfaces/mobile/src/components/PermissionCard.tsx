import { Pressable, StyleSheet, Text, View } from "react-native";

import { PermissionAction, PermissionRequest } from "../api/types";

interface PermissionCardProps {
  request: PermissionRequest;
  disabled?: boolean;
  onResolve: (action: PermissionAction) => void;
}

export function PermissionCard({ request, disabled, onResolve }: PermissionCardProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Permission required</Text>
      <Text selectable style={styles.tool}>
        Tool: {request.tool}
      </Text>
      <Text selectable style={styles.params}>
        {formatParams(request.params)}
      </Text>
      <View style={styles.actions}>
        <ActionButton label="Allow once" disabled={disabled} onPress={() => onResolve("allow")} primary />
        <ActionButton label="Always" disabled={disabled} onPress={() => onResolve("always")} />
        <ActionButton label="Deny" disabled={disabled} onPress={() => onResolve("deny")} danger />
      </View>
    </View>
  );
}

function ActionButton({
  label,
  disabled,
  primary,
  danger,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, primary && styles.primaryButton, danger && styles.dangerButton, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function formatParams(params: PermissionRequest["params"]): string {
  if (typeof params === "string") return params;
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return String(params);
  }
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#fff4c2",
    borderColor: "#111",
    borderWidth: 2,
    marginTop: 8,
    padding: 9,
  },
  title: {
    color: "#111",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  tool: {
    color: "#111",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 6,
  },
  params: {
    backgroundColor: "#050505",
    color: "#d7d7d7",
    fontFamily: "Menlo",
    fontSize: 10,
    marginTop: 6,
    padding: 8,
  },
  actions: {
    gap: 6,
    marginTop: 8,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    padding: 8,
  },
  primaryButton: {
    backgroundColor: "#00e676",
  },
  dangerButton: {
    backgroundColor: "#ff9ab6",
  },
  disabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "900",
  },
});
