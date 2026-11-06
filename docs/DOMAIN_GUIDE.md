# Domain Guide

## Default Nimbus domain

Set `HOSTING_DOMAIN` during install (e.g. `nimbushost.com`). Every service then gets
a free hostname automatically:

| Service | Hostname |
| --- | --- |
| Minecraft | `play-username.nimbushost.com` |
| Website | `username.nimbushost.com` |
| Backend | `api-username.nimbushost.com` |
| Discord HTTP | `bot-username.nimbushost.com` |

DNS setup on the hosting zone:

- **Websites/backends/bots:** wildcard `A` record `*.nimbushost.com → node IP`, reverse
  proxy routes by Host header, automatic SSL.
- **Minecraft:** per-service `A` record, or an `SRV` record
  `_minecraft._tcp.play-username → 5 0 PORT play-username.nimbushost.com`.

Database hostnames stay private by default.

## Customer custom domains

1. Customer adds the domain in **My Domains**.
2. NIMBUS issues a TXT verification token (`_nimbus.<domain>`).
3. Customer creates the TXT record and presses **Verify** — takeover and duplicates
   are impossible because a claimed domain cannot be re-claimed.
4. Verified domains are mapped to services (A / AAAA / CNAME / SRV as appropriate).
5. SSL is issued and renewed automatically for HTTP traffic.

## Cloudflare integration

Configure a **scoped** API token (Zone → DNS → Edit for the hosting zone only):

```env
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
```

NIMBUS then creates/removes records via API. Account passwords are never requested,
and a global API key must never be used.

## Important

HTTPS certificates secure websites and HTTP APIs — they do **not** encrypt raw
TCP/UDP game traffic (Minecraft, most bots). For Minecraft, SRV routing plus the
server's own protocol is the correct path.
