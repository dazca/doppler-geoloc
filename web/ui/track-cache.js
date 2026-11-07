// Optional IndexedDB cache of fetched flight tracks, so a reload doesn't need a refetch.
// Every call swallows errors (private mode, blocked storage, quota): the cache is a convenience only.
const DB = 'overhead', STORE = 'tracks', KEEP = 6;

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {   // v2: savedAt index, so eviction never loads stored track arrays
      const st = req.result.objectStoreNames.contains(STORE) ? req.transaction.objectStore(STORE) : req.result.createObjectStore(STORE);
      if (!st.indexNames.contains('savedAt')) st.createIndex('savedAt', 'savedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

export const cacheKey = (source, { bbox, t0, t1 }) => `${source}|${bbox.map((x) => x.toFixed(4)).join(',')}|${Math.round(t0)}|${Math.round(t1)}`;

const isQuota = (e) => e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');

async function putOnce(db, key, tracks) {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ savedAt: Date.now(), tracks }, key);
  await done(tx);
}
/** Keep only the newest KEEP entries, in its own transaction (B12), walking the savedAt index with a key cursor so
 *  no stored track arrays are loaded. */
async function evict(db, keep = KEEP) {
  const tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
  const keys = await new Promise((res, rej) => {
    const out = [], req = st.index('savedAt').openKeyCursor(null, 'prev');   // newest first
    req.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.primaryKey); c.continue(); } else res(out); };
    req.onerror = () => rej(req.error);
  });
  keys.slice(keep).forEach((k) => st.delete(k));
  await done(tx);
}
async function clearAll(db) { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await done(tx); }

/** Store tracks; on QuotaExceededError the cache is cleared and the write retried once. Resolves true when stored. */
export async function putTracks(key, tracks) {
  let db;
  try {
    db = await open();
    try { await putOnce(db, key, tracks); }
    catch (e) {
      if (!isQuota(e)) throw e;
      await clearAll(db);
      await putOnce(db, key, tracks);
    }
    try { await evict(db); } catch { /* eviction is best effort */ }
    return true;
  } catch { return false; } finally { try { db?.close(); } catch { /* closed */ } }
}

export async function getTracks(key) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const v = await new Promise((res, rej) => { const r = tx.objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    db.close();
    return v?.tracks || null;
  } catch { return null; }
}
