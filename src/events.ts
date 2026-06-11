import { EventEmitter } from "node:events";

export interface McEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

// A tiny in-process pub/sub bus. The HTTP layer emits domain events (task
// completions, progress changes, delegations, agent liveness) and SSE clients
// subscribe so the dashboard can update reactively instead of polling.
export class McEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent SSE subscribers are expected; do not warn at 10.
    this.emitter.setMaxListeners(0);
  }

  emit(type: string, data: Record<string, unknown> = {}): void {
    const event: McEvent = { type, at: new Date().toISOString(), ...data };
    this.emitter.emit("mc", event);
  }

  subscribe(listener: (event: McEvent) => void): () => void {
    this.emitter.on("mc", listener);
    return () => this.emitter.off("mc", listener);
  }
}
