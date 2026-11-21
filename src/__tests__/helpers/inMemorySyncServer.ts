import type { SyncTransport } from "@/lib/syncEngine";
import {
  createEmptySyncPayload,
  mergeSyncPayloads,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";

/**
 * In-memory adapter for the sync transport seam: a fake sync server that keeps
 * one dataset and runs the REAL shared merge (mergeSyncPayloads), so store and
 * sync tests exercise the whole pass without fetch stubs or a Next server.
 */
export function createInMemorySyncServer(initial: SyncPayload = createEmptySyncPayload()) {
  let state = initial;
  const requests: SyncPayload[] = [];
  let failNext: number | null = null;

  const transport: SyncTransport = async ({ body, signal }) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (failNext !== null) {
      const status = failNext;
      failNext = null;
      return new Response(JSON.stringify({ error: "fail" }), { status });
    }
    const check = validateSyncPayload(JSON.parse(body));
    if (!check.valid) return new Response(JSON.stringify({ error: "bad" }), { status: 400 });
    requests.push(check.payload);
    state = mergeSyncPayloads(state, check.payload);
    return new Response(JSON.stringify({ payload: state, lanUrls: [], peers: { phone: { lastSeenAt: null } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    transport,
    /** Every payload the server accepted, in order. */
    requests,
    get state(): SyncPayload {
      return state;
    },
    /** Lets another device write to the server dataset (merged like a real push). */
    push(payload: SyncPayload): void {
      state = mergeSyncPayloads(state, payload);
    },
    /** The next request answers with this HTTP status. */
    failNextWith(status: number): void {
      failNext = status;
    },
  };
}
