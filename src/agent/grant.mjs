// Grant credentials, made in the browser like the SDK makes them: `ngt_` plus
// 32 random bytes in unpadded base64url. Only the SHA-256 commitment goes into
// the owner's signed `grant_issue`; the token stays in the tab that runs the
// order and is never sent anywhere except as the grant header of its calls.

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const GRANT_TOKEN = /^ngt_[A-Za-z0-9_-]{43}$/;

/** Lowercase hex SHA-256 of the token, the form `grant_issue` takes. */
export async function grantCommitment(token) {
  if (!GRANT_TOKEN.test(token)) throw new Error('not a grant token');
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

export async function createGrantCredential() {
  const token = `ngt_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, commitment: await grantCommitment(token) };
}
