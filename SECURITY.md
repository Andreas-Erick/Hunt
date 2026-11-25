# Security

## Threat model

Hunt is a single-user app. The desktop serves `/api/sync`
on port 3000 of every network interface, so a paired phone
can reach it over the LAN or Tailscale.

- **Pairing key.** Every sync request must carry a 256-bit
  random key, kept in `data/hunt-sync.key` and compared in
  constant time. To revoke every paired phone, delete that
  file; the next request creates a new key.
- **Transport.** Sync uses plain HTTP. On a network you
  don't trust (café or office Wi-Fi), sync over Tailscale,
  which encrypts the traffic, or don't sync at all.
- **Out of scope.** Exposing port 3000 to the internet,
  multiple users, and attackers with access to the desktop's
  files. The non-goals in the [README](README.md) explain
  why.

## Reporting a vulnerability

Please report it privately through GitHub's
**Security → Report a vulnerability** on this repository
rather than in a public issue. Include the steps to
reproduce it and the version shown in Hunt's top bar.
