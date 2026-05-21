import type { Message, PlanStep, PlanUpdate, PlanProgress } from "@/types";

function hasVisibleAssistantContent(message: Message): boolean {
  if (message.role !== "assistant") return false;
  return message.content.trim().length > 0 || !!message.askUser || !!message.permissionRequest;
}

function findPlaceholderPlanStepIndex(steps: PlanStep[], incoming: PlanStep): number {
  return steps.findIndex(
    (step) =>
      step.id !== incoming.id &&
      step.subject === incoming.subject &&
      (step.activeForm || "") === (incoming.activeForm || "") &&
      (step.status === "pending" || step.status === "in_progress")
  );
}

export function shouldRenderAssistantMessage(
  message: Message,
  isGenerating: boolean,
  isLast: boolean
): boolean {
  if (message.role !== "assistant") {
    return true;
  }

  if (hasVisibleAssistantContent(message)) {
    return true;
  }

  return isGenerating && isLast;
}

export function upsertPlanStep(steps: PlanStep[], incoming: PlanStep): PlanStep[] {
  const sameIdIndex = steps.findIndex((step) => step.id === incoming.id);
  if (sameIdIndex >= 0) {
    return steps.map((step, index) => (index === sameIdIndex ? { ...step, ...incoming } : step));
  }

  const placeholderIndex = findPlaceholderPlanStepIndex(steps, incoming);
  if (placeholderIndex >= 0) {
    return steps.map((step, index) =>
      index === placeholderIndex ? { ...step, ...incoming } : step
    );
  }

  return [...steps, incoming];
}

export function applyPlanStepUpdate(steps: PlanStep[], incoming: PlanStep): PlanStep[] {
  const sameIdIndex = steps.findIndex((step) => step.id === incoming.id);
  if (sameIdIndex >= 0) {
    return steps.map((step, index) => (index === sameIdIndex ? { ...step, ...incoming } : step));
  }

  const placeholderIndex = findPlaceholderPlanStepIndex(steps, incoming);
  if (placeholderIndex >= 0) {
    return steps.map((step, index) =>
      index === placeholderIndex ? { ...step, ...incoming } : step
    );
  }

  return [...steps, incoming];
}

export function applyPlanUpdate(
  currentSteps: PlanStep[],
  update: PlanUpdate
): { planSteps: PlanStep[]; planProgress: PlanProgress | null } {
  const nextSteps = update.allCompleted ? [] : update.steps;
  return {
    planSteps: currentSteps === nextSteps ? [...nextSteps] : nextSteps,
    planProgress: update.allCompleted ? null : update.progress,
  };
}

export function clearPlanState(): { planSteps: PlanStep[]; planProgress: PlanProgress | null } {
  return {
    planSteps: [],
    planProgress: null,
  };
}
