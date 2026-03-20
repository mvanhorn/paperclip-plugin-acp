/**
 * Shared mock factories for ACP plugin tests.
 */

type StateStore = Map<string, unknown>;

export function createMockState(initial?: Record<string, unknown>) {
  const store: StateStore = new Map(
    initial ? Object.entries(initial) : [],
  );

  return {
    get: async (opts: { scopeKind: string; stateKey: string }) => {
      return store.get(opts.stateKey) ?? null;
    },
    set: async (
      opts: { scopeKind: string; stateKey: string },
      value: unknown,
    ) => {
      if (value === null || value === undefined) {
        store.delete(opts.stateKey);
      } else {
        store.set(opts.stateKey, value);
      }
    },
    /** Expose the raw store for assertions */
    _store: store,
  };
}

export function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

export function createMockMetrics() {
  const writes: Array<{ name: string; value: number }> = [];
  return {
    write: async (name: string, value: number) => {
      writes.push({ name, value });
    },
    _writes: writes,
  };
}

export function createMockEvents() {
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  return {
    on: (event: string, handler: (payload: unknown) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args });
    },
    _emitted: emitted,
    _listeners: listeners,
  };
}

export function createMockContext(stateInit?: Record<string, unknown>) {
  return {
    state: createMockState(stateInit),
    logger: createMockLogger(),
    metrics: createMockMetrics(),
    events: createMockEvents(),
    config: {
      get: async () => ({}),
    },
    tools: {
      register: () => {},
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
