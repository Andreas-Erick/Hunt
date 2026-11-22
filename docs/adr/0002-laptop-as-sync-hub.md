# ADR-0002: The laptop is the sync hub

Status: Accepted · Date: 2026-11-22

## Context

There is one user with a laptop and a phone, usually on the
same Wi-Fi and sometimes connected over Tailscale. There is
no cloud and no account. The phone app is a WebView with no
server of its own.

## Options considered

- **Peer-to-peer.** No single point of failure, but needs
  device discovery, a server on Android, and rules for who
  decides on each side.
- **Hosted relay.** Works anywhere, but breaks the no-cloud
  goal and needs an account.
- **Laptop as hub.** The Next.js app already runs a server.

## Decision

`src/app/api/sync/route.ts` holds the canonical file.

- Each write goes to a temp file, is fsync'd, then
  renamed. Fourteen daily snapshots are kept.
- Reads fall back from the main file to the backup, then to
  the snapshots. Every skipped file is logged with its
  reason. An unreadable main file is copied to
  `hunt-sync.corrupt-<ms>.json` before a recovery write
  replaces it.
- If nothing is readable, the route returns 507 instead of
  writing over the files.

Pairing uses one shared secret in `data/hunt-sync.key`,
sent as `X-Hunt-Token` and compared in constant time
(`serverSyncAuth.ts`). On the phone, the token is kept in an
AndroidKeyStore AES-GCM envelope. Deleting the key file
revokes every paired phone.

Only the device running a focus session may log it, so two
devices can't both log the same burst.

## Consequences

- No sync while the laptop is off. Both devices keep
  working and converge later.
- One place to back up and restore.
- There is no TLS on the LAN. The token stops other devices
  on the network from writing data, but not someone on the
  same Wi-Fi from reading traffic. Tailscale adds encryption
  for remote use.
- No accounts, so no multi-user support (a non-goal).
