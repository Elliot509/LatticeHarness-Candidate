import type {
  MessageView,
  SteeringView,
  TaskSnapshot,
  ToolActivityView,
  VerificationView,
} from "../server/protocol.js";

export type ActivityItem =
  | { kind: "message"; seq: number; value: MessageView }
  | { kind: "tool"; seq: number; value: ToolActivityView }
  | { kind: "verification"; seq: number; value: VerificationView }
  | { kind: "steering"; seq: number; value: SteeringView };

export function taskActivity(task: TaskSnapshot): ActivityItem[] {
  return [
    ...task.messages.map((value): ActivityItem => ({ kind: "message", seq: value.seq, value })),
    ...task.tools.map((value): ActivityItem => ({ kind: "tool", seq: value.seq, value })),
    ...task.verifications.map((value): ActivityItem => ({ kind: "verification", seq: value.seq, value })),
    ...task.steering.map((value): ActivityItem => ({ kind: "steering", seq: value.seq, value })),
  ].sort((left, right) => left.seq - right.seq);
}

export function toolSummaryPreview(tool: ToolActivityView, maxLength = 260): { text: string; shortened: boolean } {
  const normalized = tool.summary.trim().replace(/\s+/g, " ");
  const payloadStart = tool.tool === "edit" ? normalized.indexOf("{") : -1;
  const withoutStructuredPayload = payloadStart > 0 ? normalized.slice(0, payloadStart).trimEnd() : normalized;
  if (withoutStructuredPayload.length <= maxLength) {
    return { text: withoutStructuredPayload, shortened: withoutStructuredPayload !== normalized };
  }
  const clipped = withoutStructuredPayload.slice(0, maxLength).trimEnd();
  const lastWordBoundary = clipped.lastIndexOf(" ");
  const text = `${lastWordBoundary > maxLength * 0.7 ? clipped.slice(0, lastWordBoundary) : clipped}...`;
  return { text, shortened: true };
}

export function taskStateDescription(task: TaskSnapshot): string {
  if (task.stateReason.trim() !== "") return task.stateReason;
  switch (task.state) {
    case "WAITING":
      return "Execução pausada até a condição registrada mudar.";
    case "NEEDS_INPUT":
      return "A tarefa precisa de uma decisão antes de continuar.";
    case "BLOCKED":
      return "A execução não pode continuar nas restrições atuais.";
    case "COMPLETED":
      return "A tarefa chegou a um resultado final.";
    case "CANCELLED":
      return "A execução foi interrompida. Efeitos concluídos e incertos continuam visíveis.";
    case "READY":
    case "RUNNING":
      return "";
  }
}
