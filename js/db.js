/** Local document store; IndexedDB supports structured clones including blobs. */
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('doc-scan', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function operation(mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('documents', mode);
    const request = action(transaction.objectStore('documents'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
export const all = () => operation('readonly', store => store.getAll());
export const save = document => operation('readwrite', store => store.put(document));
export const remove = id => operation('readwrite', store => store.delete(id));
export const clear = () => operation('readwrite', store => store.clear());
