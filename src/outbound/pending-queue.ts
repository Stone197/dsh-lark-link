// Per-scope debounce/merge queue (bridge interaction parity).
//
// Messages sent to the same conversation inside a quiet window are merged
// into ONE prompt batch; while an agent turn is active the scope is `block`ed
// so messages keep accumulating but never flush until the turn ends
// (`unblock` arms a fresh quiet window). Command-shaped messages bypass the
// queue entirely — they are cheap and must stay responsive.
//
// Ported from zarazhangrui/lark-coding-agent-bridge src/bot/pending-queue.ts,
// with an injectable clock so unit tests drive flush deterministically.

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PendingQueueOptions<T> {
  /** Quiet window in ms. */
  delayMs: number;
  /** Called with the merged batch once the window elapses (or bypassed). */
  onFlush: (scope: string, batch: T[]) => void;
  /** Command predicate: matching messages bypass the queue (singleton batch). */
  isCommand?: (message: T) => boolean;
  /** Timer injection for tests; defaults to the global timer functions. */
  timers?: TimerApi;
  /** Error sink for flush handler failures (defaults to swallowing). */
  onError?: (err: unknown, scope: string) => void;
}

interface PendingEntry<T> {
  messages: T[];
  timer?: unknown;
}

export class PendingQueue<T = unknown> {
  private readonly map = new Map<string, PendingEntry<T>>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly onFlush: (scope: string, batch: T[]) => void;
  private readonly isCommand?: (message: T) => boolean;
  private readonly timers: TimerApi;
  private readonly onError?: (err: unknown, scope: string) => void;

  constructor(options: PendingQueueOptions<T>) {
    this.delayMs = options.delayMs;
    this.onFlush = options.onFlush;
    this.isCommand = options.isCommand;
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.onError = options.onError;
  }

  /**
   * Queue one message for `scope`. Commands bypass the queue (delivered as a
   * singleton batch immediately, without disturbing an existing batch).
   * Returns how many messages are now queued for that scope (1 for a bypass).
   */
  push(scope: string, message: T): number {
    if (this.isCommand?.(message) === true) {
      this.flushBatch(scope, [message]);
      return 1;
    }
    const existing = this.map.get(scope);
    if (existing) {
      this.disarm(scope, existing);
      existing.messages.push(message);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [message],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  /** Drop the batch for a scope (returns what was queued). */
  cancel(scope: string): T[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    this.disarm(scope, entry);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll(): void {
    for (const [scope, entry] of this.map) this.disarm(scope, entry);
    this.map.clear();
    this.blocked.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry) this.disarm(scope, entry);
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    if (!entry || entry.messages.length === 0) return;
    this.disarm(scope, entry);
    entry.timer = this.armTimer(scope);
  }

  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  /** Currently queued message count for a scope (0 when empty). */
  size(scope: string): number {
    return this.map.get(scope)?.messages.length ?? 0;
  }

  private armTimer(scope: string): unknown {
    return this.timers.setTimeout(() => this.flush(scope), this.delayMs);
  }

  private disarm(scope: string, entry: PendingEntry<T>): void {
    if (entry.timer !== undefined) {
      this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    if (this.blocked.has(scope)) return; // block() after arming — wait for unblock
    this.map.delete(scope);
    this.flushBatch(scope, entry.messages);
  }

  private flushBatch(scope: string, batch: T[]): void {
    if (batch.length === 0) return;
    try {
      this.onFlush(scope, batch);
    } catch (err) {
      this.onError?.(err, scope);
    }
  }
}
