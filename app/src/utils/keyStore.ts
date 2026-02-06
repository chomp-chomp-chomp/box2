// IndexedDB-backed key store for ECDSA signing keys (TOFU trust model)
//
// Stores:
//   - Own signing keypair per room+displayName
//   - Known public keys for other users (trust store)

const DB_NAME = 'RecipeBoxKeys';
const DB_VERSION = 1;
const OWN_KEYS_STORE = 'ownKeys';
const TRUST_STORE = 'trustedKeys';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OWN_KEYS_STORE)) {
        db.createObjectStore(OWN_KEYS_STORE);
      }
      if (!db.objectStoreNames.contains(TRUST_STORE)) {
        db.createObjectStore(TRUST_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbPut(storeName: string, key: string, value: unknown): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      })
  );
}

// Own keypair storage: keyed by "roomId:displayName"

export interface StoredKeypair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

function ownKeyId(roomId: string, displayName: string): string {
  return `${roomId}:${displayName}`;
}

export async function getOwnKeypair(
  roomId: string,
  displayName: string
): Promise<StoredKeypair | undefined> {
  return idbGet<StoredKeypair>(OWN_KEYS_STORE, ownKeyId(roomId, displayName));
}

export async function saveOwnKeypair(
  roomId: string,
  displayName: string,
  keypair: StoredKeypair
): Promise<void> {
  return idbPut(OWN_KEYS_STORE, ownKeyId(roomId, displayName), keypair);
}

// Trust store: keyed by "roomId:displayName" -> stored public key JWK

export interface TrustedKey {
  publicKeyJwk: JsonWebKey;
  firstSeen: number;
}

function trustKeyId(roomId: string, displayName: string): string {
  return `${roomId}:${displayName}`;
}

export async function getTrustedKey(
  roomId: string,
  displayName: string
): Promise<TrustedKey | undefined> {
  return idbGet<TrustedKey>(TRUST_STORE, trustKeyId(roomId, displayName));
}

export async function saveTrustedKey(
  roomId: string,
  displayName: string,
  publicKeyJwk: JsonWebKey
): Promise<void> {
  return idbPut(TRUST_STORE, trustKeyId(roomId, displayName), {
    publicKeyJwk,
    firstSeen: Date.now(),
  } satisfies TrustedKey);
}

// Compare two JWKs for equality (ECDSA P-256 public keys)
export function jwkEqual(a: JsonWebKey, b: JsonWebKey): boolean {
  return a.x === b.x && a.y === b.y && a.crv === b.crv && a.kty === b.kty;
}

export type TrustStatus = 'verified' | 'new' | 'mismatch' | 'unsigned';
