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
interface DriveStatus { connected: boolean; connectedAt: string | null; reconnectRequired?: boolean; }

export default function CustomerBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [drive, setDrive] = useState<DriveStatus>({ connected: false, connectedAt: null });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, driveStatus] = await Promise.all([
        api.get<{ items?: BackupRow[] } | BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<DriveStatus>("/integrations/google-drive"),
      ]);
      setRows(Array.isArray(backupRows) ? backupRows : backupRows.items ?? []);
      setServices(serviceRows);
      setDrive(driveStatus);
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
      const result = await api.post<{ url: string }>("/integrations/google-drive/connect", { clientId, clientSecret });
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
          <p className="mt-3 text-xs text-emerald-400">Connected{drive.connectedAt ? ` · ${new Date(drive.connectedAt).toLocaleString()}` : ""}</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">Google OAuth Client ID</label>
              <input className="input w-full" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="...apps.googleusercontent.com" autoComplete="off" />
            </div>
            <div>
              <label className="label">Google OAuth Client Secret</label>
              <input className="input w-full" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="off" />
            </div>
            <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">Use the same OAuth web application and redirect URI configured for Nimbus. Credentials are encrypted on the server.</p>
              <button className="btn-primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void connectDrive()}>{busy ? "Connecting…" : "Connect Google Drive"}</button>
            </div>
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
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void restore(b._id)}>Restore</button>
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
