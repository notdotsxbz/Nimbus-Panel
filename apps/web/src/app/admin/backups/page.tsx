"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

interface BackupRow {
  _id: string;
  serviceId: { name?: string } | string;
  destination: string;
  status: string;
  trigger: string;
  sizeBytes?: number;
  createdAt: string;
}
interface ServiceOption { _id: string; name: string; type: string; }
interface PanelBackupRow { _id: string; status: string; progress: number; currentStep?: string; customerCount?: number; serviceCount?: number; nodeCount?: number; totalSizeBytes?: number; createdAt: string; error?: string; }

export default function AdminBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [panelRows, setPanelRows] = useState<PanelBackupRow[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, fullBackups] = await Promise.all([
        api.get<BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<PanelBackupRow[]>("/backups/admin/full"),
      ]);
      setRows(backupRows);
      setServices(serviceRows);
      setPanelRows(fullBackups);
      if (!serviceId && serviceRows.length) setServiceId(serviceRows[0]._id);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 5000); return () => clearInterval(timer); }, []);

  const createFullPanelBackup = async () => {
    if (!window.confirm("Start a full NIMBUS panel backup? This creates service snapshots and encrypted panel database/configuration archives. The snapshot is sequential and does not pause all services.")) return;
    setBusy(true);
    try {
      const result = await api.post<PanelBackupRow>("/backups/admin/full");
      show(`Full panel backup queued: ${result._id}`, "ok");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not queue full panel backup", "err");
    } finally { setBusy(false); }
  };

  const createBackup = async () => {
    if (!serviceId) return;
    setBusy(true);
    try {
      const result = await api.post<BackupRow>("/backups", { serviceId, destination: "gdrive", trigger: "manual" });
      show(result.status === "completed" ? "Backup uploaded to Google Drive" : "Backup created but did not complete", result.status === "completed" ? "ok" : "err");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Backup failed", "err");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Backups</h1>
          <p className="mt-1 text-sm text-muted">Create verified snapshots and upload them to the connected Google Drive.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className="input min-w-48" value={serviceId} onChange={e => setServiceId(e.target.value)} aria-label="Select service">
            {services.length === 0 ? <option value="">No services available</option> : services.map(s => <option key={s._id} value={s._id}>{s.name}</option>)}
          </select>
          <button className="btn-primary" disabled={busy || !serviceId} onClick={() => void createBackup()}>{busy ? "Creating backup…" : "Back up to Google Drive"}</button>
        </div>
      </header>

      <GlassCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Full NIMBUS Panel Backup</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">Creates encrypted panel database and configuration archives, infrastructure metadata, and separate encrypted service backups for eligible customers. VPS/VDS full disk images are not supported by the current Node Agent.</p>
            <p className="mt-1 text-xs text-muted">This is a best-effort sequential snapshot, not a globally quiesced point-in-time backup. Keep the backup encryption key in a secure offline location.</p>
          </div>
          <button className="btn-primary" disabled={busy} onClick={() => void createFullPanelBackup()}>{busy ? "Working…" : "Start Full Panel Backup"}</button>
        </div>
        <div className="mt-4 space-y-3">
          {panelRows.map(item => (
            <div key={item._id} className="rounded-xl border border-white/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{item._id}</div>
                <span className={`text-xs ${item.status === "completed" ? "text-emerald-400" : item.status === "failed" ? "text-red-400" : item.status === "partial" ? "text-amber-400" : "text-muted"}`}>{item.status}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, item.progress ?? 0))}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                <span>{item.currentStep ?? "Queued"} · {item.progress ?? 0}%</span>
                <span>{item.customerCount ?? 0} customers · {item.serviceCount ?? 0} services · {item.nodeCount ?? 0} nodes</span>
                <span>{item.totalSizeBytes ? `${(item.totalSizeBytes / 1073741824).toFixed(2)} GB` : "Size pending"}</span>
              </div>
              {item.error ? <p className="mt-2 text-xs text-red-400">{item.error}</p> : null}
            </div>
          ))}
          {panelRows.length === 0 ? <p className="text-sm text-muted">No full panel backups yet.</p> : null}
        </div>
      </GlassCard>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Service</th>
              <th className="px-5 py-3 font-medium">Destination</th>
              <th className="px-5 py-3 font-medium">Trigger</th>
              <th className="px-5 py-3 font-medium">Size</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => (
              <tr key={b._id} className="border-b border-white/5 last:border-0">
                <td className="px-5 py-3 font-medium">{typeof b.serviceId === "object" ? b.serviceId?.name : "—"}</td>
                <td className="px-5 py-3 text-xs uppercase text-muted">{b.destination}</td>
                <td className="px-5 py-3 text-xs text-muted">{b.trigger}</td>
                <td className="tnum px-5 py-3 text-xs">{b.sizeBytes ? `${(b.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</td>
                <td className="px-5 py-3"><span className="inline-flex items-center gap-2 text-xs"><span className={`status-dot ${b.status === "completed" ? "status-online" : b.status === "failed" ? "status-error" : "status-installing"}`} />{b.status}</span></td>
                <td className="tnum px-5 py-3 text-xs text-muted">{new Date(b.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={6} className="px-5 py-10 text-center text-muted">No backups recorded yet</td></tr> : null}
          </tbody>
        </table>
      </GlassCard>
      {node}
    </div>
  );
}
