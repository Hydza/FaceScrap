type Stored = Record<string, unknown>;
type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ChangedListener = (changes: Record<string, StorageChange>, areaName: string) => void;

const sessionData: Stored = {};
const localData: Stored = {};
// Storage areas share one change event, and listeners survive data resets.
const changeListeners = new Set<ChangedListener>();

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function fireChanged(areaName: string, changes: Record<string, StorageChange>): void {
  if (Object.keys(changes).length === 0) return;
  for (const listener of changeListeners) listener(changes, areaName);
}

function area(data: Stored, areaName: string, clone: (values: Stored) => Stored) {
  return {
    // Clone returned values and support atomic area-wide snapshots.
    async get(key: string | string[] | null): Promise<Stored> {
      if (key === null) return clone(data);
      const keys = typeof key === 'string' ? [key] : key;
      const selected: Stored = {};
      for (const candidate of keys) {
        if (candidate in data) selected[candidate] = data[candidate];
      }
      return clone(selected);
    },
    async set(values: Stored): Promise<void> {
      const cloned = clone(values);
      // Emit changes only for keys whose values changed.
      const changes: Record<string, StorageChange> = {};
      for (const key of Object.keys(cloned)) {
        const hadKey = key in data;
        const oldValue = data[key];
        const newValue = cloned[key];
        if (!hadKey || !sameValue(oldValue, newValue)) {
          changes[key] = hadKey ? { oldValue, newValue } : { newValue };
        }
      }
      Object.assign(data, cloned);
      fireChanged(areaName, changes);
    },
    async remove(keys: string | string[]): Promise<void> {
      const changes: Record<string, StorageChange> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (key in data) {
          changes[key] = { oldValue: data[key] };
          delete data[key];
        }
      }
      fireChanged(areaName, changes);
    },
    async clear(): Promise<void> {
      const changes: Record<string, StorageChange> = {};
      for (const key of Object.keys(data)) {
        changes[key] = { oldValue: data[key] };
        delete data[key];
      }
      fireChanged(areaName, changes);
    },
  };
}

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    storage: {
      // Mirror session cloning and local JSON serialization semantics.
      session: area(sessionData, 'session', (values) => structuredClone(values)),
      local: area(localData, 'local', (values) => JSON.parse(JSON.stringify(values)) as Stored),
      onChanged: {
        addListener(listener: ChangedListener) {
          changeListeners.add(listener);
        },
        removeListener(listener: ChangedListener) {
          changeListeners.delete(listener);
        },
      },
    },
    // Provide inert runtime hooks required by background-module imports.
    runtime: {
      id: 'facescrap-test',
      onConnect: { addListener() {}, removeListener() {} },
      onMessage: { addListener() {}, removeListener() {} },
      getURL: (path: string) => `chrome-extension://facescrap-test/${path}`,
    },
  },
});

export async function resetChromeStorage(): Promise<void> {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
}
