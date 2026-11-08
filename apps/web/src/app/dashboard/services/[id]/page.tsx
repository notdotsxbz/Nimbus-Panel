"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, currentUser } from "@/lib/api";
import { CopyField, GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";
import { ConsoleV2 } from "@/components/console-v2";
import { FileManager } from "@/components/file-manager";

interface ServiceDetail {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
  cpuPercent: number;
  software?: string;
  subdomain?: string;
  expiresAt?: string;
  nodeId: { name?: string; ip?: string } | string;
  containerId?: string;
}

const TABS = ["Overview", "Console", "Files", "Minecraft", "Backups", "Network", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function ServicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [confirm, setConfirm] = useState<"reinstall" | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [mcCommand, setMcCommand] = useState<string | null>(null);
  const [mcFile, setMcFile] = useState<string | null>(null);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    try {
      setService(await api.get<ServiceDetail>(`/services/${params.id}`));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        router.replace("/dashboard");
        return;
      }
      show(err instanceof Error ? err.message : "Failed to load service", "err");
    }
  }, [params.id, router, show]);

  useEffect(() => {
    if (currentUser()) void load();
  }, [load]);

  const power = async (action: "start" | "stop" | "restart" | "reinstall") => {
    setBusy(true);
    try {
      await api.post(`/services/${params.id}/power/${action}`);
      show(`${action} sent — waiting for node confirmation…`, "info");
      setTimeout(() => void load(), 1500);
    } catch (err) {
      show(err instanceof Error ? err.message : "Operation failed", "err");
    }
    setBusy(false);
    setConfirm(null);
  };

  if (!service) {
    return <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>;
  }

  const nodeIp = typeof service.nodeId === "object" ? service.nodeId?.ip : undefined;

  return (
    <div className="space-y-6">
      {/* Header + power controls */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{service.name}</h1>
            <StatusBadge status={service.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {service.type} · {typeof service.nodeId === "object" ? service.nodeId?.name : ""}
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button className="btn-primary !px-3" disabled={busy} onClick={() => void power("start")}>Start</button>
          <button className="btn-ghost !px-3" disabled={busy} onClick={() => void power("stop")}>Stop</button>
          <button className="btn-ghost !px-3" disabled={busy} onClick={() => void power("restart")}>Restart</button>
          <button className="btn-danger !px-3" disabled={busy} onClick={() => setConfirm("reinstall")}>Reinstall</button>
        </div>
      </header>

      {/* Tabs */}
      <div role="tablist" aria-label="Service sections" className="glass-soft flex overflow-x-auto rounded-xl p-1">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors ${
              tab === t ? "bg-white/10 font-medium text-white" : "text-muted hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <GlassCard className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Connection details</h2>
            <div className="space-y-2">
              {service.subdomain ? <CopyField label="Domain" value={service.subdomain} /> : null}
              <CopyField label="IP" value={nodeIp} />
              <CopyField label="Software" value={service.software} />
            </div>
          </GlassCard>
          <GlassCard className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Resources</h2>
            <dl className="tnum space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted">CPU limit</dt><dd>{service.cpuPercent}%</dd></div>
              <div className="flex justify-between"><dt className="text-muted">RAM</dt><dd>{service.ramMb} MB</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Disk</dt><dd>{service.diskGb} GB</dd></div>
              {service.expiresAt ? (
                <div className="flex justify-between"><dt className="text-muted">Expires</dt><dd>{new Date(service.expiresAt).toLocaleDateString()}</dd></div>
              ) : null}
            </dl>
          </GlassCard>
        </div>
      )}

      {tab === "Console" && (
        <ConsoleV2
          serviceId={service._id}
          type={service.type}
          status={service.status}
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((f) => !f)}
          initialCommand={mcCommand}
          onInitialCommandSent={() => setMcCommand(null)}
        />
      )}

      {tab === "Files" && <FileManager serviceId={service._id} initialPath={mcFile ?? undefined} onPathConsumed={() => setMcFile(null)} />}

      {tab === "Minecraft" && service.type === "minecraft" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <GlassCard className="p-6">
            <h2 className="font-semibold">Player & server commands</h2>
            <p className="mt-1 text-xs text-muted">
              One-tap server commands sent through the console. Advanced commands in the Console tab.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["list", "whitelist list", "banlist players", "op list"].map((cmd) => (
                <button
                  key={cmd}
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                  onClick={() => {
                    setTab("Console");
                    setMcCommand(cmd);
                  }}
                >
                  {cmd}
                </button>
              ))}
            </div>
            <h3 className="mt-6 text-sm font-semibold">Whitelist a player</h3>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(new FormData(e.currentTarget).get("player") ?? "").trim();
                if (name) {
                  setMcCommand(`whitelist add ${name}`);
                  setTab("Console");
                }
              }}
            >
              <input name="player" required className="input font-mono text-xs" placeholder="Steve" aria-label="Player name" />
              <button className="btn-primary !px-4 text-xs" type="submit">Add</button>
            </form>
            <h3 className="mt-4 text-sm font-semibold">OP a player</h3>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(new FormData(e.currentTarget).get("player2") ?? "").trim();
                if (name) {
                  setMcCommand(`op ${name}`);
                  setTab("Console");
                }
              }}
            >
              <input name="player2" required className="input font-mono text-xs" placeholder="Steve" aria-label="Player name to OP" />
              <button className="btn-primary !px-4 text-xs" type="submit">OP</button>
            </form>
          </GlassCard>
          <GlassCard className="p-6">
            <h2 className="font-semibold">Server configuration</h2>
            <p className="mt-1 text-xs text-muted">
              Key files open in the built-in editor (Files tab):
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["server.properties", "eula.txt"].map((f) => (
                <button
                  key={f}
                  className="btn-ghost !px-3 !py-1.5 font-mono text-xs"
                  onClick={() => {
                    setMcFile(f);
                    setTab("Files");
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
            <h3 className="mt-6 text-sm font-semibold">World folders</h3>
            <p className="mt-1 text-xs text-muted">
              Browse, upload, download and back up worlds in the Files tab (world_nether,
              world_the_end, or your custom world folders). Changing a seed requires generating a
              NEW world — editing server.properties never regenerates an existing world.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["world", "world_nether", "world_the_end", "plugins", "logs"].map((f) => (
                <button
                  key={f}
                  className="btn-ghost !px-3 !py-1.5 font-mono text-xs"
                  onClick={() => {
                    setMcFile(f + "/");
                    setTab("Files");
                  }}
                >
                  {f}/
                </button>
              ))}
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-muted">
              Plugin/mod installs: drop .jar files into plugins/ (Bukkit/Spigot/Paper) or mods/
              (Fabric/Forge/NeoForge) via the Files tab — the server loads them on next restart.
              Plugins and mods are different ecosystems; a Bukkit plugin never runs as a Fabric mod.
            </p>
          </GlassCard>
        </div>
      )}
      {tab === "Minecraft" && service.type !== "minecraft" ? null : null}

      {tab === "Backups" && (
        <GlassCard className="p-6">
          <button
            className="btn-primary"
            onClick={() =>
              void api
                .post("/backups", { serviceId: service._id })
                .then(() => show("Backup queued", "ok"))
                .catch((e: Error) => show(e.message, "err"))
            }
          >
            Create backup now
          </button>
          <p className="mt-3 text-xs text-muted">
            Snapshots include sha256 integrity checksums. Scheduled backups can be enabled after
            connecting Google Drive in Account → Backups.
          </p>
        </GlassCard>
      )}

      {tab === "Network" && (
        <GlassCard className="p-6 text-sm text-muted">
          Allocations assigned to this service (IP, port, protocol) appear here. Ports are
          allocated by your administrator from the node pool (default 4001–4050).
        </GlassCard>
      )}

      {tab === "Settings" && (
        <GlassCard className="p-6 text-sm text-muted">
          Service-level settings (startup command, environment variables, recovery policy) are
          managed by your administrator per plan policy. Contact support to request changes.
        </GlassCard>
      )}

      {/* Destructive confirmation */}
      <Modal open={confirm === "reinstall"} title="Reinstall service?" onClose={() => setConfirm(null)}>
        <p className="text-sm text-muted">
          Reinstalling wipes the service data and reinstalls the software image. Create a backup
          first — existing data cannot be recovered afterwards.
        </p>
        <div className="mt-5 flex gap-2">
          <button className="btn-danger flex-1" disabled={busy} onClick={() => void power("reinstall")}>
            Reinstall now
          </button>
          <button className="btn-ghost flex-1" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </Modal>

      {node}
    </div>
  );
}
