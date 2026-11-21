import { NextResponse } from "next/server";
import {
  authorizeRequestWithSyncKey,
  getOrCreateServerSyncKey,
  isLocalDesktopOriginRequest,
} from "@/lib/serverSyncAuth";
import {
  executeWin32WindowAction,
  isDesktopWindowAction,
} from "@/lib/win32WindowCtl";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;

export async function POST(request: Request): Promise<NextResponse> {
  if (!isLocalDesktopOriginRequest(request)) {
    return NextResponse.json(
      { error: "Desktop window controls are only available on localhost" },
      { status: 403 }
    );
  }

  const auth = authorizeRequestWithSyncKey(request, getOrCreateServerSyncKey());
  if (auth === "no_key") {
    return NextResponse.json(
      { error: "Sync key unavailable on the server" },
      { status: 503 }
    );
  }
  if (auth !== "ok") {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing X-Hunt-Token" },
      { status: 401 }
    );
  }

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 }
    );
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Unreadable request body" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action =
    parsed && typeof parsed === "object"
      ? (parsed as { action?: unknown }).action
      : undefined;
  if (!isDesktopWindowAction(action)) {
    return NextResponse.json(
      { error: "Invalid window action" },
      { status: 400 }
    );
  }

  const result = await executeWin32WindowAction(action);
  return NextResponse.json(
    {
      ok: result.ok,
      found: result.found,
      action,
      ...(result.detail ? { detail: result.detail } : {}),
    },
    { status: result.ok ? 200 : 404 }
  );
}
