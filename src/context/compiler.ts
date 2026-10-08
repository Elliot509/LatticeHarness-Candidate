export const KERNEL = `Trabalhe pelo resultado solicitado dentro do escopo e da autoridade atuais. Use evidências observadas e diferencie fatos, hipóteses e resultados pendentes. Preserve trabalho existente e cumpra as precondições das ferramentas. Continue com ações úteis autorizadas; descubra o que pode antes de perguntar. Pergunte quando uma decisão material ou informação indispensável bloquear o avanço. Use falhas para orientar a próxima ação, considerando mudanças desde a tentativa anterior. Verifique o comportamento pertinente e relate limites com precisão. Termine quando o escopo estiver verificado, quando o usuário interromper ou quando não houver avanço autorizado possível.`;

export const SURFACE_VERSION = "surface-1";

export interface TaskSurface {
  objective: string;
  acceptanceCriteria: readonly string[];
  grants: readonly string[];
  prohibitions: readonly string[];
  obligations: readonly string[];
  unknowns: readonly string[];
  humanDecisions: readonly string[];
  versions: readonly string[];
  lastError: string | null;
}

export interface EvidenceItem {
  id: string;
  text: string;
}

export interface ModelSurface {
  surfaceVersion: string;
  system: string;
  task: string;
  anchorCount: number;
  evidenceIncluded: number;
  evidenceOmitted: number;
  omittedIds: string[];
}

export interface CompilerLimits {
  maxChars: number;
}

// Conservative, demonstrable size estimate: callers treat the value as an
// upper bound for admission, never as a token count.
export function estimateChars(text: string): number {
  return text.length;
}

function renderAnchors(surface: TaskSurface): string {
  const lines = [
    `Objetivo: ${surface.objective}`,
    `Pronto quando: ${surface.acceptanceCriteria.join(" | ")}`,
    `Autorizado: ${surface.grants.join(" | ")}`,
    `Proibido: ${surface.prohibitions.join(" | ")}`,
    `Obrigações pendentes: ${surface.obligations.length > 0 ? surface.obligations.join(" | ") : "nenhuma"}`,
    `Efeitos incertos: ${surface.unknowns.length > 0 ? surface.unknowns.join(" | ") : "nenhum"}`,
    `Decisões humanas: ${surface.humanDecisions.length > 0 ? surface.humanDecisions.join(" | ") : "nenhuma"}`,
    `Versões: ${surface.versions.length > 0 ? surface.versions.join(" | ") : "nenhuma registrada"}`,
  ];
  if (surface.lastError !== null) lines.push(`Último erro discriminante: ${surface.lastError}`);
  return lines.join("\n");
}

export class ContextOverflowError extends Error {
  readonly anchors: number;
  readonly limit: number;
  constructor(anchors: number, limit: number) {
    super(
      `Task anchors (${anchors} chars) exceed the context limit (${limit} chars); refusing to call the model with obligations omitted`,
    );
    this.name = "ContextOverflowError";
    this.anchors = anchors;
    this.limit = limit;
  }
}

export function compileSurface(
  task: TaskSurface,
  evidence: readonly EvidenceItem[],
  limits: CompilerLimits,
): ModelSurface {
  const anchors = renderAnchors(task);
  if (estimateChars(KERNEL) + estimateChars(anchors) > limits.maxChars) {
    throw new ContextOverflowError(
      estimateChars(KERNEL) + estimateChars(anchors),
      limits.maxChars,
    );
  }
  const prefix = `${anchors}\n\nEvidência:\n`;
  const note = evidence.length > 0 ? "\n\n(itens omitidos por limite quando necessário; histórico durável preservado, sem resumo semântico.)" : "";
  let used = KERNEL.length + prefix.length + note.length;
  const included: EvidenceItem[] = [];
  const omitted: EvidenceItem[] = [];
  // Most recent observations win. Older durable receipts stay outside the
  // request; the omission notice itself is bounded and never lists all IDs.
  for (const item of [...evidence].reverse()) {
    const cost = item.id.length + item.text.length + 4;
    if (used + cost <= limits.maxChars) { included.unshift(item); used += cost; }
    else omitted.unshift(item);
  }
  let taskText = prefix + included.map((item) => `[${item.id}] ${item.text}`).join("\n");
  if (omitted.length > 0) taskText += note;
  if (KERNEL.length + taskText.length > limits.maxChars) throw new ContextOverflowError(KERNEL.length + taskText.length, limits.maxChars);
  return {
    surfaceVersion: SURFACE_VERSION,
    system: KERNEL,
    task: taskText,
    anchorCount: 8 + (task.lastError !== null ? 1 : 0),
    evidenceIncluded: included.length,
    evidenceOmitted: omitted.length,
    omittedIds: omitted.map((item) => item.id),
  };
}
