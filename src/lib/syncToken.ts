import { SYNC_TOKEN_STORAGE_KEY } from "./domainTypes";

/**
 * The desktop's sync pairing key: taken once from the launcher's `?token=` URL
 * param, persisted in localStorage, and sent as `X-Hunt-Token`.
 */

/** A pairing key: 32–256 printable, non-space ASCII characters (same rule as the Android shell). */
const SYNC_TOKEN_RE = /^[\x21-\x7E]{32,256}$/;

/** The trimmed pairing key, or '' when `raw` is not a valid one. */
function normalizeSyncToken(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const token = raw.trim();
  return SYNC_TOKEN_RE.test(token) ? token : "";
}

/** A `?token=` key that could not be persisted (storage blocked); kept for this page only. */
let unsavedUrlToken = "";

/**
 * Moves a `?token=` pairing key (put there by the desktop launcher) from the
 * address bar into localStorage, then removes that param from the URL; an
 * invalid value is removed too but never stored. Returns the valid key or ''.
 */
function takeUrlSyncToken(): string {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  if (!params.has("token")) return "";
  const token = normalizeSyncToken(params.get("token"));
  if (token) {
    try {
      window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, token);
      unsavedUrlToken = "";
    } catch {
      unsavedUrlToken = token;
    }
  }
  params.delete("token");
  const rest = params.toString();
  try {
    window.history.replaceState(
      window.history.state,
      "",
      pathname + (rest ? `?${rest}` : "") + hash
    );
  } catch {
    // Best effort: a URL that cannot be rewritten does not affect the stored key.
  }
  return token;
}

/** The pairing key this desktop sends as `X-Hunt-Token`, or '' when none is known. */
export function getClientSyncToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromUrl = takeUrlSyncToken();
    if (fromUrl) return fromUrl;
    if (unsavedUrlToken) return unsavedUrlToken;
    return normalizeSyncToken(window.localStorage.getItem(SYNC_TOKEN_STORAGE_KEY));
  } catch {
    // Storage blocked: only a key ingested earlier on this page is known.
    return unsavedUrlToken;
  }
}
