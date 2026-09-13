import { randomUUID } from "node:crypto";

export interface ResultHandle {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly createdAt: string;
  expand(): string;
}

export class HandleRegistry {
  private readonly handles = new Map<string, ResultHandle>();
  private readonly maxHandles: number;

  constructor(maxHandles = 64) {
    this.maxHandles = maxHandles;
  }

  store(kind: string, summary: string, expand: () => string): string {
    if (this.handles.size >= this.maxHandles) {
      throw new Error("Handle registry full; expand or drop an existing handle first");
    }
    const id = `h_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.handles.set(id, {
      id,
      kind,
      summary,
      createdAt: new Date().toISOString(),
      expand,
    });
    return id;
  }

  get(id: string): ResultHandle | undefined {
    return this.handles.get(id);
  }

  size(): number {
    return this.handles.size;
  }
}
