# Node Guide

A NIMBUS node is an Ubuntu/Debian VPS running the Go **node agent**, Docker, and
customer containers. Nodes never run panel code; the control plane talks to them
exclusively through the authenticated agent API.

## Security model

- The agent listens on `:7443` (TLS) and only accepts requests carrying the
  per-node credential issued at enrollment (constant-time verified).
- Enrollment tokens are single-use and expire in 30 minutes.
- The Docker API is never exposed publicly — the agent shells out to a **fixed
  whitelist** of docker subcommands; there is no endpoint that forwards user input.
- Containers run with `no-new-privileges`, CPU/RAM limits, and a per-service data
  root — no unrestricted host access.
- Customer file traffic flows node → customer directly, off the control plane.

## Installation

See [INSTALLATION.md](INSTALLATION.md) § "Adding a compute node".

## Sizing

| Role | Suggestion |
| --- | --- |
| Minecraft nodes | 4+ cores, RAM = Σ (service RAM) + 2 GB headroom |
| Web/backend nodes | 2+ cores, disk = Σ (service disk) + 20% |
| VPS/VDS nodes | KVM/libvirt or Proxmox required — Docker is never marketed as a VPS |

## Monitoring

Each node reports every 15 s: CPU, RAM, disk, container count, uptime, agent
version. Admin → **Nodes** shows online/offline state, last heartbeat and
maintenance mode. A node in maintenance mode accepts no new assignments.

## Removal

Put the node in **Maintenance**, migrate its services, then remove it. The node
credential is revoked automatically when the node is retired.
