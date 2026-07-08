export function isDirectBrowserIframeUrl(value: string): boolean {
  try {
    new URL(value);
  } catch {
    return false;
  }
  // Most real sites block arbitrary iframes, and direct framing bypasses the
  // server-side capture that feeds browser context to Codex.
  return false;
}
