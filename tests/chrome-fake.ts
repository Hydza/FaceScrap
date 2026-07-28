type Stored = Record<string, unknown>;
type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ChangedListener = (changes: Record<string, StorageChange>, areaName: string) => void;

const sessionData: Stored = {};
const localData: Stored = {};
// Real chrome.storage.onChanged is one event shared across every area — a
// listener added here fires for a 'local' write just as much as a 'session'
// one, distinguished only by the areaName argument. Kept module-level (not
// cleared by resetChromeStorage) because real listeners outlive a storage
// clear too; only the DATA resets between tests.
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
    // Clone on the way out too — real chrome.storage copies in BOTH directions,
    // so a returned object must never alias the store. `null` is the Chrome API
    // form for an area-wide snapshot; quota recovery needs one atomic view of
    // every per-tab media key before choosing safe global eviction candidates.
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
      // Real chrome.storage.onChanged fires per key that actually changed
      // value, not per key merely named in the set() call — code under test
      // (e.g. storage.ts's settings listener) keys off that to avoid re-work
      // a same-value write did not cause.
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
      // session is in-memory in real Chrome and keeps structured-clone
      // semantics; local persists through JSON-ish serialization that drops
      // undefined-valued keys and functions and mangles Dates — mirror both so
      // a test can't assert fidelity the real API does not provide.
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
    // Enough runtime for a BACKGROUND module to be imported at all. dash-download.ts opens
    // its mux-progress port at module scope, and playing-download.ts imports it — so without
    // these, testing anything in src/background/ dies on the import rather than on the
    // behaviour under test. Deliberately inert: nothing here simulates a port or a message,
    // and a test that needs those should say so by stubbing them itself.
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
