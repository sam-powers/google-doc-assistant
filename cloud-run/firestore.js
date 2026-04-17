import { Firestore } from '@google-cloud/firestore';

const db = new Firestore();

// Map a flat KV key to a { collection, docId } pair.
// Key shapes mirroring the Cloudflare KV namespace:
//   canonical_{docId}       → canonical/{docId}
//   processed_{docId}       → processed/{docId}
//   processing_{commentId}  → locks/{commentId}
//   doc_context_{docId}     → context/{docId}
//   sa_token_cache          → cache/sa_token
//   {channelToken}          → channels/{channelToken}
function keyToRef(key) {
  if (key === 'sa_token_cache') return db.collection('cache').doc('sa_token');
  if (key.startsWith('canonical_')) return db.collection('canonical').doc(key.slice('canonical_'.length));
  if (key.startsWith('processed_')) return db.collection('processed').doc(key.slice('processed_'.length));
  if (key.startsWith('processing_')) return db.collection('locks').doc(key.slice('processing_'.length));
  if (key.startsWith('cooldown_'))   return db.collection('locks').doc('cooldown_' + key.slice('cooldown_'.length));
  if (key.startsWith('doc_context_')) return db.collection('context').doc(key.slice('doc_context_'.length));
  return db.collection('channels').doc(key);
}

// Collections where documents carry an expiresAt field used for TTL.
// Firestore TTL is eventually consistent (up to 24h), so we check expiry on read.
const TTL_COLLECTIONS = new Set(['locks', 'context', 'cache']);

/**
 * Get a value by key. Returns the string value, or null if missing or expired.
 */
export async function kvGet(key) {
  const ref = keyToRef(key);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data();

  // Check in-process expiry for TTL collections (Firestore TTL may lag up to 24h).
  // Treat a missing expiresAt as expired rather than silently skipping the check —
  // documents in TTL collections must always carry an expiry field.
  if (TTL_COLLECTIONS.has(ref.parent.id)) {
    if (data.expiresAt == null) return null;
    const expiresAt = data.expiresAt.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
    if (expiresAt <= new Date()) return null;
  }

  return data.value ?? null;
}

/**
 * Put a value by key. If ttlSeconds is provided, sets an expiresAt timestamp.
 */
export async function kvPut(key, value, ttlSeconds) {
  const ref = keyToRef(key);
  const doc = { value };

  if (ttlSeconds != null) {
    doc.expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  }

  await ref.set(doc);
}

/**
 * Delete a key.
 */
export async function kvDelete(key) {
  const ref = keyToRef(key);
  await ref.delete();
}
