"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, currentUser } from "@/lib/api";
import { CopyField, GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";
import { ConsoleV2 } from "@/components/console-v2";
import { FileManager } from "@/components/file-manager";
import { MinecraftProperties } from "@/components/minecraft-properties";
import { SoftwareManager } from "@/components/software-manager";

interface BackupRow { _id: string; status: string; createdAt: string; sizeBytes?: number; progress?: number; currentStep?: string; }
interface DriveStatus { connected: boolean; accountEmail?: string | null; reconnectRequired?: boolean; }

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
  const [backupRows, setBackupRows] = useState<BackupRow[]>([]);
  const [driveStatus, setDriveStatus] = useState<DriveStatus>({ connected: false });
  const [backupBusy, setBackupBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("Overview");
  const [confirm, setConfirm] = useState<"reinstall" | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [mcCommand, setMcCommand] = useState<string | null>(null);
  const [mcFile, setMcFile] = useState<string | null>(null);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    try {
      const serviceRow = await api.get<ServiceDetail>(`/services/${params.id}`);
      setService(serviceRow);
      try {
        const [backupList, drive] = await Promise.all([
          api.get<BackupRow[]>(`/backups?serviceId=${encodeURIComponent(params.id)}`),
          api.get<DriveStatus>("/integrations/google-drive"),
        ]);
        setBackupRows(backupList);
        setDriveStatus(drive);
      } catch {
        // Backup and Drive integrations are optional; keep the service controls available.
      }
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

  const connectDrive = async () => {
    setBackupBusy(true);
    try {
      const result = await api.post<{ url: string }>("/integrations/google-drive/connect", {});
      window.location.href = result.url;
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not start Google Drive connection", "err");
      setBackupBusy(false);
    }
  };

  const createDriveBackup = async () => {
    if (!service) return;
    setBackupBusy(true);
    try {
      await api.post("/backups", { serviceId: service._id, destination: "gdrive" });
      show("Google Drive backup started", "ok");
      await load();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not start backup", "err");
    } finally { setBackupBusy(false); }
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
        <GlassCard className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Google Drive Backups</h2>
              <p className="mt-1 text-sm text-muted">{driveStatus.connected ? `Connected${driveStatus.accountEmail ? ` as ${driveStatus.accountEmail}` : ""}` : "Connect your personal Google Drive to store this service's backups."}</p>
            </div>
            {driveStatus.connected ? (
              <button className="btn-primary" disabled={backupBusy || busy} onClick={() => void createDriveBackup()}>Backup Now</button>
            ) : (
              <button className="btn-primary" disabled={backupBusy || busy} onClick={() => void connectDrive()}>Connect Google Drive</button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>{backupRows.length} backups</span>
            <span>Last backup: {backupRows[0] ? new Date(backupRows[0].createdAt).toLocaleString() : "Never"}</span>
            <a className="text-sky-400 hover:underline" href={`/dashboard/backups?serviceId=${service._id}`}>View history and configure automatic backups</a>
          </div>
          <div className="mt-4 space-y-2">
            {backupRows.slice(0, 5).map(backup => (
              <div key={backup._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 p-3 text-xs">
                <span>{new Date(backup.createdAt).toLocaleString()}</span>
                <span>{backup.status}{backup.status === "running" ? ` · ${backup.currentStep ?? "Working"} · ${backup.progress ?? 0}%` : ""}</span>
                <span>{backup.sizeBytes ? `${(backup.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</span>
              </div>
            ))}
            {backupRows.length === 0 ? <p className="text-sm text-muted">No backups for this service yet.</p> : null}
          </div>
          <p className="mt-3 text-xs text-muted">Backups are encrypted before upload and verified with SHA-256 checksums. Restores create a safety snapshot first.</p>
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
