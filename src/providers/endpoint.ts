// One endpoint identity for inference, discovery and session credentials.
export function normalizeEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("endpoint must be a valid http(s) URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error("endpoint must use http(s), without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, '');
}

export function requireCredentialTransport(endpoint: string, key: string): void {
  const url = new URL(endpoint);
  if (key.trim() !== '' && url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error("credentials require HTTPS (loopback HTTP is allowed)");
  }
}

/** Reject reflected credentials before provider output reaches tools/history. */
export function containsCredential(value: unknown, key: string): boolean {
  if (key === '') return false;
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some(entry => containsCredential(entry, key));
  if (typeof value === 'object' && value !== null) return Object.entries(value).some(([field, entry]) => field.includes(key) || containsCredential(entry, key));
  return false;
}
