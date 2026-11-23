"use client";

import { useEffect, useRef, useState } from "react";
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
interface CustomerOption { _id: string; username: string; email: string; role: string; }
interface PanelBackupRow { _id: string; mode?: string; status: string; progress: number; currentStep?: string; customerCount?: number; serviceCount?: number; nodeCount?: number; totalSizeBytes?: number; createdAt: string; error?: string; }
interface PanelScheduleRow { enabled: boolean; frequency: "daily" | "weekly"; backupTime: string; nextRunAt: string; lastStatus?: string; lastError?: string; }

export default function AdminBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [panelRows, setPanelRows] = useState<PanelBackupRow[]>([]);
  const [panelSchedule, setPanelSchedule] = useState<PanelScheduleRow | null>(null);
  const [panelFrequency, setPanelFrequency] = useState<"daily" | "weekly">("daily");
  const [panelBackupTime, setPanelBackupTime] = useState("03:00");
  const scheduleLoaded = useRef(false);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [restoreCommand, setRestoreCommand] = useState("");
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, fullBackups, userRows, schedule] = await Promise.all([
        api.get<BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<PanelBackupRow[]>("/backups/admin/full"),
        api.get<{ items: CustomerOption[] }>("/users"),
        api.get<PanelScheduleRow | null>("/backups/admin/full/schedule"),
      ]);
      setRows(backupRows);
      setServices(serviceRows);
      setCustomers(userRows.items.filter(user => user.role === "customer"));
      setPanelRows(fullBackups);
      setPanelSchedule(schedule);
      if (schedule && !scheduleLoaded.current) {
        setPanelFrequency(schedule.frequency);
        setPanelBackupTime(schedule.backupTime || "03:00");
        scheduleLoaded.current = true;
      }
      setServiceId(current => current || serviceRows[0]?._id || "");
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => { void load(); const timer = setInterval(() => { void load(); }, 5000); return () => clearInterval(timer); }, []);

  const saveFullBackupSchedule = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await api.post<PanelScheduleRow>("/backups/admin/full/schedule", {
        enabled,
        frequency: panelFrequency,
        backupTime: panelBackupTime,
      });
      setPanelSchedule(result);
      scheduleLoaded.current = true;
      show(enabled ? "Scheduled full-panel backup enabled" : "Scheduled full-panel backup paused", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not save full-backup schedule", "err");
    } finally { setBusy(false); }
  };

  const deleteFullBackupSchedule = async () => {
    if (!window.confirm("Delete the scheduled full-panel backup? Existing backups will remain in Google Drive.")) return;
    setBusy(true);
    try {
      await api.del("/backups/admin/full/schedule");
      setPanelSchedule(null);
      scheduleLoaded.current = false;
      show("Full-panel backup schedule deleted", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not delete schedule", "err");
    } finally { setBusy(false); }
  };

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

  const prepareRestore = async (id: string) => {
    if (!window.confirm("Download and verify the panel database and configuration restore package? This does not modify the live panel. The actual restore requires a maintenance window and an explicit SSH command.")) return;
    setBusy(true);
    try {
      const result = await api.post<{ prepared: boolean; command: string; note: string }>(`/backups/admin/full/${id}/prepare-restore`);
      setRestoreCommand(result.command);
      show("Restore package prepared and verified", "ok");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not prepare restore package", "err");
    } finally { setBusy(false); }
  };

  const createSelectedBackup = async (mode: "customers" | "services") => {
    const ids = mode === "customers" ? selectedCustomerIds : selectedServiceIds;
    if (!ids.length) {
      show(mode === "customers" ? "Select at least one customer" : "Select at least one service", "err");
      return;
    }
    if (!window.confirm(`Start a backup for ${ids.length} selected ${mode}?`)) return;
    setBusy(true);
    try {
      await api.post("/backups/admin/selected", mode === "customers" ? { customerIds: ids } : { serviceIds: ids });
      show(`Selected ${mode} backup queued`, "ok");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not queue selected backup", "err");
    } finally { setBusy(false); }
  };

  const restoreSelected = async () => {
    if (!selectedBackupIds.length) return;
    if (!window.confirm(`Restore ${selectedBackupIds.length} selected service backups? Current files for those services will be replaced. A safety backup will be created before each restore.`)) return;
    setBusy(true);
    let restored = 0;
    let failed = 0;
    let safetyWarnings = 0;
    for (const id of selectedBackupIds) {
      try {
        const result = await api.post<{ safetyBackupStored?: boolean }>(`/backups/${id}/restore`);
        restored += 1;
        if (!result.safetyBackupStored) safetyWarnings += 1;
      } catch {
        failed += 1;
      }
    }
    setSelectedBackupIds([]);
    show(`Restored ${restored}; failed ${failed}; safety warnings ${safetyWarnings}`, failed || safetyWarnings ? "err" : "ok");
    await load();
    setBusy(false);
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
                <div className="text-sm font-medium">{item._id} · {item.mode ?? "full"}</div>
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
              {item.mode === "full" && ["completed", "partial"].includes(item.status) ? (
                <button className="btn-ghost mt-3 !px-2.5 !py-1 text-xs" disabled={busy} onClick={() => void prepareRestore(item._id)}>Prepare restore package</button>
              ) : null}
            </div>
          ))}
          {panelRows.length === 0 ? <p className="text-sm text-muted">No full panel backups yet.</p> : null}
        </div>
      </GlassCard>

      <GlassCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Scheduled Full-Panel Backup</h2>
            <p className="mt-1 text-sm text-muted">Automatically queue a complete Admin Drive backup daily or weekly. Schedule times use UTC.</p>
          </div>
          <span className="text-xs text-muted">{panelSchedule?.enabled ? "Active" : "Not active"}</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div>
            <label className="label">Frequency</label>
            <select className="input w-full" value={panelFrequency} onChange={event => setPanelFrequency(event.target.value as "daily" | "weekly")}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label className="label">Backup time (UTC)</label>
            <input className="input w-full" type="time" value={panelBackupTime} onChange={event => setPanelBackupTime(event.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void saveFullBackupSchedule(true)}>Save schedule</button>
          <button className="btn-ghost" disabled={busy || !panelSchedule?.enabled} onClick={() => void saveFullBackupSchedule(false)}>Pause</button>
          <button className="btn-ghost text-red-400" disabled={busy || !panelSchedule} onClick={() => void deleteFullBackupSchedule()}>Delete schedule</button>
        </div>
        {panelSchedule ? <p className="mt-3 text-xs text-muted">Next run: {new Date(panelSchedule.nextRunAt).toLocaleString()} UTC · Last run: {panelSchedule.lastStatus ?? "not run"}{panelSchedule.lastError ? ` · ${panelSchedule.lastError}` : ""}</p> : null}
      </GlassCard>

      <GlassCard className="p-5">
        <h2 className="font-semibold">Selected Customer / Service Backups</h2>
        <p className="mt-1 text-sm text-muted">Queue encrypted backups for chosen customers or individual services. Each customer's service files are kept in their own Admin Drive folder.</p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <label className="label">Customers</label>
            <select multiple className="input min-h-36 w-full" value={selectedCustomerIds} onChange={event => setSelectedCustomerIds(Array.from(event.target.selectedOptions).map(option => option.value))}>
              {customers.map(customer => <option key={customer._id} value={customer._id}>{customer.username} · {customer.email}</option>)}
            </select>
            <button className="btn-primary mt-3" disabled={busy || selectedCustomerIds.length === 0} onClick={() => void createSelectedBackup("customers")}>Back up selected customers ({selectedCustomerIds.length})</button>
          </div>
          <div>
            <label className="label">Services</label>
            <select multiple className="input min-h-36 w-full" value={selectedServiceIds} onChange={event => setSelectedServiceIds(Array.from(event.target.selectedOptions).map(option => option.value))}>
              {services.map(service => <option key={service._id} value={service._id}>{service.name} · {service.type}</option>)}
            </select>
            <button className="btn-primary mt-3" disabled={busy || selectedServiceIds.length === 0} onClick={() => void createSelectedBackup("services")}>Back up selected services ({selectedServiceIds.length})</button>
          </div>
        </div>
      </GlassCard>

      {restoreCommand ? (
        <GlassCard className="p-4">
          <h3 className="font-semibold">Restore package ready</h3>
          <p className="mt-1 text-sm text-muted">The verified database and .env files are staged on the VPS. This command performs a destructive panel database/configuration restore after creating a safety dump. Customer service files must be restored separately afterward.</p>
          <code className="mt-3 block break-all rounded-lg bg-black/20 p-3 text-xs">{restoreCommand}</code>
          <button className="btn-ghost mt-3" onClick={() => void navigator.clipboard.writeText(restoreCommand)}>Copy command</button>
        </GlassCard>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{selectedBackupIds.length} service backup(s) selected</p>
        <button className="btn-primary" disabled={busy || selectedBackupIds.length === 0} onClick={() => void restoreSelected()}>Restore selected services</button>
      </div>
      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-3 py-3 font-medium">Select</th>
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
                <td className="px-3 py-3"><input type="checkbox" disabled={b.status !== "completed"} checked={selectedBackupIds.includes(b._id)} onChange={event => setSelectedBackupIds(current => event.target.checked ? [...current, b._id] : current.filter(id => id !== b._id))} /></td>
                <td className="px-5 py-3 font-medium">{typeof b.serviceId === "object" ? b.serviceId?.name : "—"}</td>
                <td className="px-5 py-3 text-xs uppercase text-muted">{b.destination}</td>
                <td className="px-5 py-3 text-xs text-muted">{b.trigger}</td>
                <td className="tnum px-5 py-3 text-xs">{b.sizeBytes ? `${(b.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</td>
                <td className="px-5 py-3"><span className="inline-flex items-center gap-2 text-xs"><span className={`status-dot ${b.status === "completed" ? "status-online" : b.status === "failed" ? "status-error" : "status-installing"}`} />{b.status}</span></td>
                <td className="tnum px-5 py-3 text-xs text-muted">{new Date(b.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7} className="px-5 py-10 text-center text-muted">No Admin Drive backups recorded yet</td></tr> : null}
          </tbody>
        </table>
      </GlassCard>
      {node}
    </div>
  );
}
