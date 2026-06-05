import type { SessionAttention } from "@/types";

const ATTENTION_LABELS: Record<SessionAttention, string> = {
  completed: "New result",
  needs_input: "Needs input",
  error: "Needs attention",
};

const ATTENTION_CLASSES: Record<SessionAttention, string> = {
  completed: "bg-[#22A06B] ring-[#22A06B]/28",
  needs_input: "bg-[#D99900] ring-[#D99900]/28",
  error: "bg-[#B42318] ring-[#B42318]/28",
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
        attention
          ? `${ATTENTION_CLASSES[attention]} shadow-[0_0_0_1px_rgba(255,255,255,0.95)] ring-4`
          : "bg-transparent"
      }`}
    />
  );
}
