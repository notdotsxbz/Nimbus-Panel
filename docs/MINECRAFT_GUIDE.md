# Minecraft Hosting Guide

## Software

Vanilla · Paper · Purpur · Spigot · Fabric · Forge · NeoForge · Folia — each module
definition (`services/minecraft/module.json`) lists supported versions, minimum RAM
and the container image.

## Assigning a server

Admin → **All Services → Assign Service** → type *Minecraft* → pick a node with real
capacity → choose software/version and RAM (Paper 1.21: ≥ 2048 MB) → allocate IP +
port from the node pool → the free `play-username.<hosting-domain>` hostname is
generated automatically.

## Player experience

The connection card shows **Domain · IP · Port · Protocol** with copy buttons.
Players connect with the domain (SRV routing handles the port) or `IP:PORT` directly.

## Management

- **Console** — live log stream, commands (`say`, `op`, `whitelist add`, …)
- **Files** — `server.properties`, plugins, mods, worlds; MOTD, icon, seeds
- **Players** — whitelist, bans, OP management
- **Backups** — before version switches or risky changes
- **TPS / MSPT, CPU/RAM, player count** — service metrics

## Version switching

Stop the server, change software/version in service settings, reinstall. Always take
a pre-update snapshot — reinstalls wipe data.

## Common issues

| Symptom | Fix |
| --- | --- |
| Can't connect via domain | Check SRV/A record propagation (`dig SRV _minecraft._tcp.play-…`) |
| Out of memory crash | Raise RAM allocation; Java needs more than the pack's minimum |
| Plugin errors after upgrade | Verify plugin version matches server version |
