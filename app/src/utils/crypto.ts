// Configuration flag: true = display name encrypted (default), false = plaintext sender name
export const ENCRYPT_DISPLAY_NAME = true;

// Helper to get ArrayBuffer from Uint8Array (handles TypeScript strict mode)
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

// Base64 helpers (URL-safe variants available)
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Generate a passphrase: 26-char base32 (no ambiguous chars: 0, 1, O, I, L)
const BASE32_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePassphrase(): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < 26; i++) {
    result += BASE32_CHARS[bytes[i] % BASE32_CHARS.length];
  }
  return result;
}

// Derive AES-GCM key from passphrase using PBKDF2-HMAC-SHA256
export async function deriveKeyPBKDF2(
  passphrase: string,
  saltB64: string,
  iterations: number
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);
  const salt = base64ToBytes(saltB64);

  // Import passphrase as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passphraseBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES-GCM key
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return key;
}

// Message payload interface
export interface MessagePayload {
  text: string;
  displayName: string;
  clientTs: number;
}

// Build AAD (Additional Authenticated Data): room_id + version + msg_id
function buildAAD(roomId: string, version: number, msgId: string): Uint8Array {
  const encoder = new TextEncoder();
  // Concatenate with delimiter to prevent ambiguity
  const aadString = `${roomId}|${version}|${msgId}`;
  return encoder.encode(aadString);
}

// Encrypt payload with AES-GCM
export async function encryptPayload(
  key: CryptoKey,
  roomId: string,
  version: number,
  msgId: string,
  payload: MessagePayload
): Promise<{ ivB64: string; ciphertextB64: string }> {
  // Generate random 96-bit (12 bytes) IV
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  // Build AAD
  const aad = buildAAD(roomId, version, msgId);

  // Encode payload as JSON
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));

  // Encrypt
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    key,
    payloadBytes
  );

  return {
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

// Decrypt payload with AES-GCM
export async function decryptPayload(
  key: CryptoKey,
  roomId: string,
  version: number,
  msgId: string,
  ivB64: string,
  ciphertextB64: string
): Promise<MessagePayload> {
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const aad = buildAAD(roomId, version, msgId);

  const plaintextBytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    key,
    toArrayBuffer(ciphertext)
  );

  const decoder = new TextDecoder();
  const json = decoder.decode(plaintextBytes);
  return JSON.parse(json) as MessagePayload;
}

// Generate a ULID-like message ID (timestamp + random)
export function generateMsgId(): string {
  const now = Date.now();
  const timestamp = now.toString(36).padStart(9, '0');
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  const random = Array.from(randomBytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  return `${timestamp}${random}`.toUpperCase();
}
