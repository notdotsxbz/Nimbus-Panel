"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, currentUser } from "@/lib/api";
import { CopyField, GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";
import { ConsoleV2 } from "@/components/console-v2";
import { FileManager } from "@/components/file-manager";
import { MinecraftProperties } from "@/components/minecraft-properties";
import { SoftwareManager } from "@/components/software-manager";

interface BackupSchedule {
  serviceId: string;
  enabled: boolean;
  frequency: "manual" | "every6h" | "every12h" | "daily" | "weekly";
  time: string;
  retention: 0 | 5 | 10 | 30;
  notifyOnCompletion: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
}

interface ServiceDetail {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
  cpuPercent: number;
  software?: string;
  softwareVersion?: string;
  subdomain?: string;
  expiresAt?: string;
  nodeId: { name?: string; ip?: string } | string;
  containerId?: string;
}

const TABS = ["Overview", "Console", "Files", "Minecraft", "Properties", "Software", "Backups", "Network", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function ServicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [confirm, setConfirm] = useState<"reinstall" | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupSchedule, setBackupSchedule] = useState<BackupSchedule | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
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

  useEffect(() => {
    if (tab !== "Backups" || !service) return;
    void api.get<BackupSchedule>(`/backups/schedule?serviceId=${encodeURIComponent(service._id)}`)
      .then(setBackupSchedule)
      .catch((error) => show(error instanceof Error ? error.message : "Could not load backup schedule", "err"));
  }, [tab, service?._id, show]);

  const saveBackupSchedule = async () => {
    if (!service || !backupSchedule) return;
    setScheduleBusy(true);
    try {
      const saved = await api.put<BackupSchedule>("/backups/schedule", { ...backupSchedule, serviceId: service._id });
      setBackupSchedule(saved);
      show("Automatic backup settings saved", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not save backup settings", "err");
    } finally {
      setScheduleBusy(false);
    }
  };

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
        {TABS.filter((t) => t !== "Properties" || service.type === "minecraft").map((t) => (
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

      {tab === "Properties" && service.type === "minecraft" && <MinecraftProperties serviceId={service._id} />}

      {tab === "Software" && <SoftwareManager serviceId={service._id} serviceType={service.type} />}

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
        <div className="grid gap-4 lg:grid-cols-2">
          <GlassCard className="space-y-4 p-6">
            <div>
              <h2 className="font-semibold">Automatic backups</h2>
              <p className="mt-1 text-xs text-muted">Schedules use UTC. Backups are uploaded to your personal Google Drive.</p>
            </div>
            {backupSchedule ? (
              <>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>Enable automatic backups</span>
                  <input type="checkbox" checked={backupSchedule.enabled} onChange={(e) => setBackupSchedule({ ...backupSchedule, enabled: e.target.checked })} />
                </label>
                <div>
                  <label className="label" htmlFor="backup-frequency">Frequency</label>
                  <select id="backup-frequency" className="input" value={backupSchedule.frequency} onChange={(e) => setBackupSchedule({ ...backupSchedule, frequency: e.target.value as BackupSchedule["frequency"], enabled: e.target.value === "manual" ? false : backupSchedule.enabled })}>
                    <option value="manual">Manual only</option>
                    <option value="every6h">Every 6 hours</option>
                    <option value="every12h">Every 12 hours</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="backup-time">Backup time (UTC)</label>
                  <input id="backup-time" type="time" className="input" value={backupSchedule.time} onChange={(e) => setBackupSchedule({ ...backupSchedule, time: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="backup-retention">Retention</label>
                  <select id="backup-retention" className="input" value={backupSchedule.retention} onChange={(e) => setBackupSchedule({ ...backupSchedule, retention: Number(e.target.value) as BackupSchedule["retention"] })}>
                    <option value={5}>Keep latest 5</option>
                    <option value={10}>Keep latest 10</option>
                    <option value={30}>Keep latest 30</option>
                    <option value={0}>Never automatically delete</option>
                  </select>
                </div>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>Notify me when a scheduled backup finishes</span>
                  <input type="checkbox" checked={backupSchedule.notifyOnCompletion} onChange={(e) => setBackupSchedule({ ...backupSchedule, notifyOnCompletion: e.target.checked })} />
                </label>
                {backupSchedule.lastRunAt ? <p className="text-xs text-muted">Last run: {new Date(backupSchedule.lastRunAt).toLocaleString()}</p> : null}
                {backupSchedule.nextRunAt ? <p className="text-xs text-muted">Next run: {new Date(backupSchedule.nextRunAt).toLocaleString()} UTC</p> : null}
                <button className="btn-primary" disabled={scheduleBusy} onClick={() => void saveBackupSchedule()}>{scheduleBusy ? "Saving…" : "Save schedule"}</button>
              </>
            ) : <p className="text-sm text-muted">Loading backup settings…</p>}
          </GlassCard>
          <GlassCard className="p-6">
            <h2 className="font-semibold">Manual backup</h2>
            <p className="mt-1 text-xs text-muted">Create a verified snapshot of this service and upload it to your connected personal Google Drive.</p>
            <button
              className="btn-primary mt-4"
              onClick={() => {
                setBusy(true);
                void api.post<{ status?: string; error?: string }>("/backups", { serviceId: service._id })
                  .then((result) => show(result.status === "completed" ? "Backup completed and verified" : result.error || "Backup failed", result.status === "completed" ? "ok" : "err"))
                  .catch((error: Error) => show(error.message, "err"))
                  .finally(() => setBusy(false));
              }}
              disabled={busy}
            >
              {busy ? "Creating backup…" : "Create backup now"}
            </button>
            <p className="mt-3 text-xs text-muted">Archives are encrypted before upload and verified after upload. VPS/VDS full-disk snapshots are not supported by the current Docker-only node agent.</p>
          </GlassCard>
        </div>
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
