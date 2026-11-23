"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

interface BackupRow {
  _id: string;
  destination: string;
  status: string;
  trigger: string;
  sizeBytes?: number;
  createdAt: string;
  serviceId: { name?: string } | string;
}
interface ServiceOption { _id: string; name: string; type: string; }
interface DriveStatus { connected: boolean; connectedAt: string | null; reconnectRequired?: boolean; accountEmail?: string | null; }
interface ScheduleRow {
  _id: string;
  serviceId: string;
  enabled: boolean;
  frequency: "every6h" | "every12h" | "daily" | "weekly";
  backupTime: string;
  retentionMode: "count" | "days" | "never";
  retentionCount: 5 | 10 | 30;
  retentionDays?: number;
  nextRunAt: string;
  lastStatus?: "running" | "completed" | "failed";
  lastError?: string;
}

export default function CustomerBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [frequency, setFrequency] = useState<ScheduleRow["frequency"]>("daily");
  const [backupTime, setBackupTime] = useState("02:00");
  const [retentionMode, setRetentionMode] = useState<ScheduleRow["retentionMode"]>("count");
  const [retentionCount, setRetentionCount] = useState<5 | 10 | 30>(5);
  const [retentionDays, setRetentionDays] = useState(30);
  const [serviceId, setServiceId] = useState("");
  const [drive, setDrive] = useState<DriveStatus>({ connected: false, connectedAt: null });
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, driveStatus, scheduleRows] = await Promise.all([
        api.get<{ items?: BackupRow[] } | BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<DriveStatus>("/integrations/google-drive"),
        api.get<ScheduleRow[]>("/backups/schedules"),
      ]);
      setRows(Array.isArray(backupRows) ? backupRows : backupRows.items ?? []);
      setServices(serviceRows);
      setDrive(driveStatus);
      setSchedules(scheduleRows);
      if (!serviceId && serviceRows.length) setServiceId(serviceRows[0]._id);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    setBusy(true);
    api.post("/integrations/google-drive/exchange", { code, state })
      .then(() => { show("Your Google Drive is connected. Your backups can now be stored in your Drive.", "ok"); void load(); })
      .catch((error) => show(error instanceof Error ? error.message : "Google Drive connection failed", "err"))
      .finally(() => {
        setBusy(false);
        window.history.replaceState({}, "", "/dashboard/backups");
      });
  }, []);

  const connectDrive = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ url: string }>("/integrations/google-drive/connect", {});
      window.location.href = result.url;
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not start Google connection", "err");
      setBusy(false);
    }
  };

  const disconnectDrive = async () => {
    if (!window.confirm("Disconnect Google Drive? Existing backups in your Google Drive will not be deleted.")) return;
    setBusy(true);
    try {
      await api.del("/integrations/google-drive");
      setDrive({ connected: false, connectedAt: null });
      show("Google Drive disconnected. Existing Drive files were not changed.", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Disconnect failed", "err");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const current = schedules.find(item => item.serviceId === serviceId);
    if (!current) return;
    setFrequency(current.frequency);
    setBackupTime(current.backupTime || "02:00");
    setRetentionMode(current.retentionMode);
    setRetentionCount(current.retentionCount || 5);
    setRetentionDays(current.retentionDays || 30);
  }, [schedules, serviceId]);

  const saveSchedule = async () => {
    if (!serviceId) return;
    setBusy(true);
    try {
      await api.post("/backups/schedules", {
        serviceId,
        enabled: true,
        frequency,
        backupTime,
        retentionMode,
        retentionCount,
        retentionDays: retentionMode === "days" ? retentionDays : undefined,
        notifyOnCompletion: true,
      });
      show("Automatic backup schedule saved", "ok");
      await load();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not save backup schedule", "err");
    } finally { setBusy(false); }
  };

  const disableSchedule = async () => {
    if (!serviceId) return;
    setBusy(true);
    try {
      await api.post("/backups/schedules", {
        serviceId,
        enabled: false,
        frequency,
        backupTime,
        retentionMode,
        retentionCount,
        retentionDays: retentionMode === "days" ? retentionDays : undefined,
        notifyOnCompletion: true,
      });
      show("Automatic backups paused", "ok");
      await load();
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not pause schedule", "err");
    } finally { setBusy(false); }
  };

  const removeSchedule = async () => {
    if (!serviceId || !window.confirm("Delete this automatic backup schedule? Existing backups will remain in Google Drive.")) return;
    setBusy(true);
    try {
      await api.del(`/backups/schedules/${serviceId}`);
      setSchedules(current => current.filter(item => item.serviceId !== serviceId));
      show("Backup schedule deleted", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not delete schedule", "err");
    } finally { setBusy(false); }
  };

  const createBackup = async () => {
    if (!serviceId) return;
    setBusy(true);
    try {
      const result = await api.post<BackupRow>("/backups", { serviceId, destination: "gdrive", trigger: "manual" });
      show(result.status === "completed" ? "Backup uploaded to your Google Drive" : "Backup did not complete. Check the backup status.", result.status === "completed" ? "ok" : "err");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Backup failed", "err");
    } finally { setBusy(false); }
  };

  const download = async (id: string) => {
    setBusy(true);
    try {
      const response = await api.raw(`/backups/${id}/download`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? "Backup download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nimbus-backup-${id}.tar`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      show(error instanceof Error ? error.message : "Backup download failed", "err");
    } finally { setBusy(false); }
  };

  const deleteBackup = async (id: string) => {
    if (!window.confirm("Delete this backup from your Google Drive? This will not delete your service or its live files.")) return;
    setBusy(true);
    try {
      await api.del(`/backups/${id}`);
      setRows(current => current.filter(row => row._id !== id));
      show("Backup deleted", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Backup deletion failed", "err");
    } finally { setBusy(false); }
  };

  const restore = async (id: string) => {
    if (!confirm("Restore this backup? The current service data may be replaced after the restore is verified.")) return;
    setBusy(true);
    try {
      await api.post(`/backups/${id}/restore`);
      show("Restore request completed", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Restore failed", "err");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Backups</h1>
          <p className="mt-1 text-sm text-muted">Manage backups for services you own.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${drive.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>
          {drive.connected ? "Your Google Drive is connected" : drive.reconnectRequired ? "Reconnect required" : "Google Drive not connected"}
        </span>
      </header>

      <GlassCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Your Google Drive</h2>
            <p className="mt-1 text-sm text-muted">Your Drive connection is private to your Nimbus account. Backups from your services are sent to your connected account.</p>
          </div>
          {drive.connected ? (
            <button className="btn-ghost" disabled={busy} onClick={() => void disconnectDrive()}>Disconnect</button>
          ) : null}
        </div>
        {drive.connected ? (
          <p className="mt-3 text-xs text-emerald-400">Connected{drive.accountEmail ? ` as ${drive.accountEmail}` : ""}{drive.connectedAt ? ` · ${new Date(drive.connectedAt).toLocaleString()}` : ""}</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">Nimbus securely handles the OAuth application setup. You only need to choose your Google account and approve Drive access. The customer callback URI must be authorized by the Nimbus administrator.</p>
            <button className="btn-primary" disabled={busy} onClick={() => void connectDrive()}>{busy ? "Connecting…" : "Connect Google Drive"}</button>
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Create a service backup</h2>
            <p className="mt-1 text-sm text-muted">Create a verified snapshot and send it to your connected Google Drive.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select className="input min-w-48" value={serviceId} onChange={e => setServiceId(e.target.value)} aria-label="Select service">
              {services.length === 0 ? <option value="">No services available</option> : services.map(s => <option key={s._id} value={s._id}>{s.name} ({s.type})</option>)}
            </select>
            <button className="btn-primary" disabled={busy || !drive.connected || !serviceId} onClick={() => void createBackup()}>{busy ? "Working…" : "Back up now"}</button>
          </div>
        </div>
        {!drive.connected ? <p className="mt-3 text-xs text-amber-400">Connect your Google Drive before creating cloud backups.</p> : null}
      </GlassCard>

      <GlassCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Automatic Backups</h2>
            <p className="mt-1 text-sm text-muted">Set an independent schedule and retention policy for the selected service. Times use UTC.</p>
          </div>
          <span className="text-xs text-muted">{schedules.find(item => item.serviceId === serviceId)?.enabled ? "Schedule active" : "No active schedule"}</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="label">Frequency</label>
            <select className="input w-full" value={frequency} onChange={e => setFrequency(e.target.value as ScheduleRow["frequency"])}>
              <option value="every6h">Every 6 hours</option>
              <option value="every12h">Every 12 hours</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label className="label">Daily / weekly time (UTC)</label>
            <input className="input w-full" type="time" value={backupTime} onChange={e => setBackupTime(e.target.value)} />
          </div>
          <div>
            <label className="label">Retention</label>
            <select className="input w-full" value={retentionMode === "never" ? "never" : retentionMode === "days" ? "days" : String(retentionCount)} onChange={e => {
              const value = e.target.value;
              if (value === "never") setRetentionMode("never");
              else if (value === "days") setRetentionMode("days");
              else { setRetentionMode("count"); setRetentionCount(Number(value) as 5 | 10 | 30); }
            }}>
              <option value="5">Keep latest 5</option>
              <option value="10">Keep latest 10</option>
              <option value="30">Keep latest 30</option>
              <option value="days">Keep by days</option>
              <option value="never">Never automatically delete</option>
            </select>
          </div>
          {retentionMode === "days" ? (
            <div>
              <label className="label">Keep for days (1–365)</label>
              <input className="input w-full" type="number" min={1} max={365} value={retentionDays} onChange={e => setRetentionDays(Number(e.target.value))} />
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || !drive.connected || !serviceId} onClick={() => void saveSchedule()}>Save schedule</button>
          <button className="btn-ghost" disabled={busy || !schedules.some(item => item.serviceId === serviceId && item.enabled)} onClick={() => void disableSchedule()}>Pause</button>
          <button className="btn-ghost text-red-400" disabled={busy || !schedules.some(item => item.serviceId === serviceId)} onClick={() => void removeSchedule()}>Delete schedule</button>
        </div>
        {!drive.connected ? <p className="mt-3 text-xs text-amber-400">Connect your Google Drive before enabling automatic backups.</p> : null}
        <div className="mt-4 space-y-2">
          {schedules.map(item => (
            <div key={item._id} className="flex flex-wrap justify-between gap-2 border-t border-white/5 pt-3 text-xs text-muted">
              <span>{item.serviceId === serviceId ? "Selected service" : item.serviceId} · {item.enabled ? item.frequency : "paused"}</span>
              <span>Next run: {new Date(item.nextRunAt).toLocaleString()} UTC</span>
              <span>Last: {item.lastStatus ?? "not run"}</span>
            </div>
          ))}
          {schedules.length === 0 ? <p className="text-xs text-muted">No automatic backup schedules configured.</p> : null}
        </div>
      </GlassCard>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Service</th>
              <th className="px-5 py-3 font-medium">Size</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Created</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b._id} className="border-b border-white/5 last:border-0">
                <td className="px-5 py-3 font-medium">{typeof b.serviceId === "object" ? b.serviceId?.name : "—"}</td>
                <td className="tnum px-5 py-3 text-xs">{b.sizeBytes ? `${(b.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</td>
                <td className="px-5 py-3 text-xs">{b.status}</td>
                <td className="tnum px-5 py-3 text-xs text-muted">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="px-5 py-3 text-right">
                  {b.status === "completed" ? (
                    <div className="flex justify-end gap-1">
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void download(b._id)}>Download</button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void restore(b._id)}>Restore</button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs text-red-400" disabled={busy} onClick={() => void deleteBackup(b._id)}>Delete</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-10 text-center text-muted">No backups yet</td></tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      {node}
    </div>
  );
}
