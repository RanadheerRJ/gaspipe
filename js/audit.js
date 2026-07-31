/* Immutable operational audit records. Writes are deliberately append-only. */
import { getDb, collection, addDoc, serverTimestamp } from './firebase.js';
import { getCurrentUserData, userDisplayName } from './auth.js';

export async function recordAudit(stationId, action, affectedObject, notes = '') {
  const me = getCurrentUserData();
  if (!stationId || !me) return;
  await addDoc(collection(getDb(), 'stations', stationId, 'auditLogs'), {
    timestamp: serverTimestamp(),
    userId: me.uid,
    userName: userDisplayName(me),
    role: me.role || 'staff',
    stationId,
    action,
    affectedObject: affectedObject || {},
    notes: String(notes || '').slice(0, 500),
  });
}
