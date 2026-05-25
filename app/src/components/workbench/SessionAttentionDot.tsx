import type { SessionAttention } from "@/types";

const ATTENTION_LABELS: Record<SessionAttention, string> = {
  completed: "New result",
  needs_input: "Needs input",
  error: "Needs attention",
};

const ATTENTION_CLASSES: Record<SessionAttention, string> = {
  completed: "bg-[#1a7f37] ring-[#1a7f37]/18",
  needs_input: "bg-[#bf8700] ring-[#bf8700]/18",
  error: "bg-[#cf222e] ring-[#cf222e]/18",
};

export function attentionLabel(attention: SessionAttention): string {
  return ATTENTION_LABELS[attention];
}

export default function SessionAttentionDot({
  attention,
  reserveSpace = false,
}: {
  attention?: SessionAttention | null;
  reserveSpace?: boolean;
}) {
  if (!attention && !reserveSpace) return null;

  return (
    <span
      role={attention ? "status" : undefined}
      aria-label={attention ? attentionLabel(attention) : undefined}
      title={attention ? attentionLabel(attention) : undefined}
      className={`h-2 w-2 shrink-0 rounded-full ${
        attention ? `${ATTENTION_CLASSES[attention]} ring-4` : "bg-transparent"
      }`}
    />
  );
}
