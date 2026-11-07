// Password-encrypted files between the office and the phones (the same format as cpsurvey/secure.py):
//   "CPSURVEY-ENC1\n" | 4-byte header length (big endian) | header JSON | AES-256-GCM ciphertext with tag
// The key comes from the password with PBKDF2-SHA256 and a random salt per file; magic, length and header are the
// associated data. Uses the browser's own Web Crypto (needs https, which GitHub Pages has).

const MAGIC = new TextEncoder().encode("CPSURVEY-ENC1\n");
const ITERATIONS = 200000;
const enc = new TextEncoder();

export class WrongPassword extends Error {}

export function isEncrypted(bytes) {
  const b = new Uint8Array(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, Math.min(MAGIC.length, bytes.byteLength));
  return b.length === MAGIC.length && b.every((v, i) => v === MAGIC[i]);
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function gunzip(bytes) {
  if (!("DecompressionStream" in window)) throw new Error("This browser is too old to open packed files: update the phone");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function readHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!isEncrypted(bytes)) throw new Error("not an encrypted Control Point Survey file");
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length);
  const end = MAGIC.length + 4 + n;
  return { header: JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, end))), end };
}

// {header, data (Uint8Array)}; WrongPassword when the password does not open it.
export async function decryptFile(buffer, password) {
  const bytes = new Uint8Array(buffer);
  const { header, end } = readHeader(bytes);
  if (!password) throw new WrongPassword("This file is protected with a password.");
  const key = await deriveKey(password, unb64(header.salt), header.iter);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(header.iv), additionalData: bytes.subarray(0, end) },
      key, bytes.subarray(end)));
  } catch {
    throw new WrongPassword("Wrong file password (or the file is damaged).");
  }
  if (header.compression === "gzip") plain = await gunzip(plain);
  return { header, data: plain };
}

export async function encryptFile(bytes, password, content, name) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = enc.encode(JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iter: ITERATIONS, salt: b64(salt), iv: b64(iv),
    alg: "AES-256-GCM", content, name, compression: "none" }));
  const prefix = new Uint8Array(MAGIC.length + 4 + header.length);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(MAGIC.length, header.length);
  prefix.set(header, MAGIC.length + 4);
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: prefix }, key, bytes));
  return new Blob([prefix, ct], { type: "application/octet-stream" });
}

// PIN: stored only as a salted PBKDF2 hash.
export async function hashPin(pin, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, base, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)), length: pin.length };
}

export async function checkPin(pin, stored) {
  const { hash } = await hashPin(pin, unb64(stored.salt));
  return hash === stored.hash;
}
