import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

interface ChatInputProps {
  value: string;
  isGenerating: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}

export function ChatInput({ value, isGenerating, onChange, onSend, onStop }: ChatInputProps) {
  return (
    <View style={styles.container}>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!isGenerating}
        multiline
        placeholder={isGenerating ? "Ripple is working..." : "Ask Ripple anything..."}
        placeholderTextColor="#777"
        style={styles.input}
      />
      <Pressable
        onPress={isGenerating ? onStop : onSend}
        disabled={!isGenerating && !value.trim()}
        style={[styles.button, !isGenerating && !value.trim() && styles.disabled]}
      >
        <Text style={styles.buttonText}>{isGenerating ? "Stop" : "Send"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-end",
    backgroundColor: "#fdfbf7",
    borderTopColor: "#111",
    borderTopWidth: 2,
    flexDirection: "row",
    gap: 8,
    padding: 8,
  },
  input: {
    backgroundColor: "#fff",
    borderColor: "#111",
    borderWidth: 2,
    color: "#111",
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    maxHeight: 112,
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#ff4911",
    borderColor: "#111",
    borderWidth: 2,
    minHeight: 42,
    minWidth: 60,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  disabled: {
    backgroundColor: "#fff",
    opacity: 0.5,
  },
  buttonText: {
    color: "#111",
    fontSize: 12,
    fontWeight: "900",
  },
});
