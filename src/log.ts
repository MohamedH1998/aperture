/**
 * Simple stderr logger for debugging.
 * All output goes to stderr since stdout is reserved for JSON-RPC.
 */
export function log(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[aperture ${ts}] ${message}`);
}
