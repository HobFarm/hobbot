// D1 bind safety utility
// D1 .bind() only accepts: string | number | null | ArrayBuffer
// Moltbook API responses can contain unexpected object values at runtime

/**
 * Coerce any value to a D1-safe type before binding.
 * Use on all values sourced from external APIs (Moltbook, DMs, etc).
 * Locally computed values (hashes, timestamps, scores) don't need this.
 */
export function safeD1Value(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  console.warn(`D1 bind coercion: unexpected ${typeof val}, value=${JSON.stringify(val).slice(0, 120)}`);
  return JSON.stringify(val);
}
