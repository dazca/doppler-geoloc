// Optional IndexedDB cache of fetched flight tracks, so a reload doesn't need a refetch.
// Every call swallows errors (private mode, blocked storage, quota): the cache is a convenience only.
const DB = 'overhead', STORE = 'tracks', KEEP = 6;

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

export const cacheKey = (source, { bbox, t0, t1 }) => `${source}|${bbox.map((x) => x.toFixed(4)).join(',')}|${Math.round(t0)}|${Math.round(t1)}`;

export async function putTracks(key, tracks) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
    st.put({ savedAt: Date.now(), tracks }, key);
    // keep only the newest KEEP entries
    const all = await new Promise((res) => { const out = []; st.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push([c.key, c.value.savedAt]); c.continue(); } else res(out); }; });
    all.sort((a, b) => b[1] - a[1]).slice(KEEP).forEach(([k]) => st.delete(k));
    await done(tx); db.close();
    return true;
  } catch { return false; }
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
