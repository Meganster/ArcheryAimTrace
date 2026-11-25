import { sessionOrder } from './session-order.js?v=aim-pipeline-163';
// Client-side IndexedDB database wrapper for ArcheryAimTrace.
// Handles local storage of profiles, sessions, shots, traces, and the sync queue.
import { shotTimeUnknown, shotStoredAt } from "./shot-record.js?v=aim-pipeline-163";

// Keep the existing database name so a branding update retains local practice data.
const DB_NAME = "openfloat_db";
const DB_VERSION = 2;

// Shots whose timestamps fall within this window of each other are grouped into
// the same practice session automatically (no manual start/stop needed).
export const SESSION_GAP_MS = 30 * 60 * 1000;

let dbPromise = null;

export function initDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => {
      console.error("IndexedDB error:", e.target.error);
      reject(e.target.error);
    };

    request.onsuccess = (e) => {
      resolve(e.target.result);
    };

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 1. Bow Profiles (keyPath 'id' which will be a Client-generated UUID)
      if (!db.objectStoreNames.contains("bow_profiles")) {
        db.createObjectStore("bow_profiles", { keyPath: "id" });
      }

      // 2. Sessions (keyPath 'id' - Client-generated UUID)
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("started_at", "started_at", { unique: false });
      }

      // 3. Shots (keyPath 'id' - Client-generated UUID)
      if (!db.objectStoreNames.contains("shots")) {
        const store = db.createObjectStore("shots", { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }

      // 4. Shot Traces (keyPath 'shot_id' - maps directly to shot.id).
      //    payload[] carries motion (+ micAmp per point); mic_series[] is an
      //    optional full-rate mic window for connected-shot captures.
      if (!db.objectStoreNames.contains("shot_traces")) {
        db.createObjectStore("shot_traces", { keyPath: "shot_id" });
      }

      // 5. Sync Queue (Auto-incrementing ID for execution sequence)
      if (!db.objectStoreNames.contains("sync_queue")) {
        const store = db.createObjectStore("sync_queue", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("status", "status", { unique: false });
      }

      // 6. Session Overrides (keyPath 'id' = anchor shot id of an auto-detected
      //    session group). Stores the user-edited name and bow for that group.
      if (!db.objectStoreNames.contains("session_overrides")) {
        db.createObjectStore("session_overrides", { keyPath: "id" });
      }
    };
  });

  return dbPromise;
}

// Helper to perform a read-write transaction
function getStore(storeName, mode = "readonly") {
  return initDb().then((db) => {
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  });
}

export async function put(storeName, item) {
  const store = await getStore(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    store.transaction.oncomplete = () => resolve(req.result);
    store.transaction.onabort = () => reject(store.transaction.error || new Error("Storage transaction aborted"));
    store.transaction.onerror = () => reject(store.transaction.error || req.error);
    req.onerror = () => reject(req.error);
  });
}

export async function get(storeName, key) {
  const store = await getStore(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(storeName, key) {
  const store = await getStore(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Delete the confirmed snapshot of a session in one transaction. A storage
// failure must not leave half a session, orphan traces or pending uploads.
export async function deleteShotRecords(shotIds, overrideIds = []) {
  const ids = new Set(shotIds);
  if (!ids.size) return;
  const db = await initDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['shots', 'shot_traces', 'session_overrides', 'sync_queue'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Session deletion aborted'));
    tx.onerror = () => {}; // The abort event reports the rolled-back transaction.
    for (const id of ids) {
      tx.objectStore('shots').delete(id);
      tx.objectStore('shot_traces').delete(id);
    }
    for (const id of new Set([...ids, ...overrideIds.filter(Boolean)])) {
      tx.objectStore('session_overrides').delete(id);
    }
    const request = tx.objectStore('sync_queue').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const task = cursor.value;
      if (ids.has(task.targetId) || ids.has(task.payload?.shot_id) || ids.has(task.payload?.id)) cursor.delete();
      cursor.continue();
    };
  });
}

export async function getAll(storeName) {
  const store = await getStore(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingSyncTasks() {
  const store = await getStore("sync_queue", "readonly");
  const index = store.index("status");
  return new Promise((resolve, reject) => {
    const req = index.getAll("pending");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateSyncTaskStatus(taskId, status) {
  const store = await getStore("sync_queue", "readwrite");
  return new Promise((resolve, reject) => {
    const getReq = store.get(taskId);
    getReq.onsuccess = () => {
      const task = getReq.result;
      if (!task) {
        resolve();
        return;
      }
      task.status = status;
      const putReq = store.put(task);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// --- Data portability (local backup / restore) ---------------------------
// The export bundles every object store so a field-test capture can be moved
// between browsers or machines, or kept as a backup, without any cloud account.

// Stable wire format: previous backups and clients remain compatible.
export const EXPORT_FORMAT = "openfloat-export";
export const EXPORT_VERSION = 1;

// Read every object store into a single JSON-serializable envelope.
export async function exportAllData() {
  const db = await initDb();
  const storeNames = Array.from(db.objectStoreNames);
  const stores = {};

  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readonly");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    for (const name of storeNames) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => {
        stores[name] = req.result;
      };
    }
  });

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

// Restore an exported envelope. By default records are merged into the existing
// database (put by key, so a re-import overwrites matching records but keeps
// everything else). Pass { merge: false } to clear each store before restoring.
// Returns a per-store count of restored records.
export async function importAllData(payload, { merge = true } = {}) {
  if (!payload || payload.format !== EXPORT_FORMAT || !payload.stores) {
    throw new Error("Unrecognized backup file.");
  }

  const db = await initDb();
  const validStores = new Set(Array.from(db.objectStoreNames));
  const incoming = Object.keys(payload.stores).filter((name) => validStores.has(name));
  if (!incoming.length) {
    throw new Error("Export file contains no known data stores.");
  }

  const counts = {};
  await new Promise((resolve, reject) => {
    const tx = db.transaction(incoming, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    for (const name of incoming) {
      const store = tx.objectStore(name);
      if (!merge) store.clear();
      const records = Array.isArray(payload.stores[name]) ? payload.stores[name] : [];
      counts[name] = records.length;
      for (const record of records) {
        // sync_queue uses an auto-incrementing key; let it assign a fresh id
        // when the record lacks one, otherwise preserve the exported key.
        if (store.autoIncrement && (record.id === undefined || record.id === null)) {
          store.add(record);
        } else {
          store.put(record);
        }
      }
    }
  });

  return counts;
}

// Group shots into practice sessions purely from their timestamps. Any gap
// larger than `gapMs` between consecutive shots starts a new session. Each group
// is anchored by its earliest shot's id (stable as new shots are appended), so
// user edits (name/bow) stored in `session_overrides` stay attached.
// Returns groups sorted newest-first; each group's shots are also newest-first.
export function groupShotsByTime(shots, gapMs = SESSION_GAP_MS) {
  const manual = new Map();
  for (const shot of shots.filter((s) => s.offline_series_id)) {
    if (!manual.has(shot.offline_series_id)) manual.set(shot.offline_series_id, []);
    manual.get(shot.offline_series_id).push(shot);
  }
  const manualGroups = [...manual.values()].map((items) => {
    items = sessionOrder(items).entries.map(e => e.shot).reverse();
    const times = items.map((s) => Date.parse(shotStoredAt(s))).filter(Number.isFinite);
    return { anchorId: items[0].offline_series_id, name: items[0].offline_series_name,
      startTime: times.length ? Math.min(...times) : 0, lastTime: times.length ? Math.max(...times) : 0,
      timeKind: items.some(shotTimeUnknown) ? 'imported' : 'recorded', shots: items };
  });
  shots = shots.filter((s) => !s.offline_series_id);
  const unknown = shots.filter(shotTimeUnknown);
  const sorted = shots.filter((shot) => !shotTimeUnknown(shot)).sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );

  const groups = [];
  let current = null;
  for (const shot of sorted) {
    const t = new Date(shot.timestamp).getTime();
    if (!current || t - current.lastTime > gapMs) {
      current = {
        anchorId: shot.id,
        startTime: t,
        lastTime: t,
        shots: [],
      };
      groups.push(current);
    }
    current.shots.push(shot);
    current.lastTime = t;
  }

  // Present newest sessions and newest shots first for display.
  for (const g of groups) g.shots.reverse();
  // An upload batch is not a practice session. Keep unknown capture times
  // apart from real timestamp groups, even if both arrive in the same minute.
  const imports = new Map();
  for (const shot of unknown) {
    const key = shot.import_batch_id || `legacy-${shot.id}`;
    const time = Date.parse(shotStoredAt(shot));
    const t = Number.isFinite(time) ? time : 0;
    if (!imports.has(key)) imports.set(key, {
      anchorId: shot.import_batch_id ? `import-${shot.import_batch_id}` : shot.id, legacyAnchorId: shot.id, startTime: t, lastTime: t, timeKind: "imported", shots: [],
    });
    const group = imports.get(key);
    if (t < group.startTime) { group.startTime = t; group.legacyAnchorId = shot.id; }
    group.lastTime = Math.max(group.lastTime, t);
    group.shots.push(shot);
  }
  for (const group of imports.values()) {
    const order = sessionOrder(group.shots);
    if (order.continuous) group.shots = order.entries.map(e => e.shot).reverse();
    else group.shots.sort((a,b) => Date.parse(shotStoredAt(b)) - Date.parse(shotStoredAt(a)));
    groups.push(group);
  }
  groups.push(...manualGroups);
  groups.sort((a, b) => b.startTime - a.startTime);
  return groups;
}

// Generate a cryptographic-quality UUIDv4 client side
export function generateUUID() {
  // Use crypto.randomUUID if available, else fallback
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
