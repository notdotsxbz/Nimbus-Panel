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
interface BackupJobRow {
  _id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
}
interface AdminBackupSummary {
  customerCount: number;
  serviceCount: number;
  nodeCount: number;
  estimatedBackupSizeBytes: number | null;
  included: string[];
  excluded: string[];
}

export default function AdminBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [jobs, setJobs] = useState<BackupJobRow[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [summary, setSummary] = useState<AdminBackupSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, backupSummary, backupJobs] = await Promise.all([
        api.get<BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<AdminBackupSummary>("/backups/admin/summary"),
        api.get<BackupJobRow[]>("/backups/jobs"),
      ]);
      setRows(backupRows);
      setServices(serviceRows);
      setSummary(backupSummary);
      setJobs(backupJobs);
      if (!serviceId && serviceRows.length) setServiceId(serviceRows[0]._id);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => { void load(); }, []);

  const createBackup = async () => {
    if (!serviceId) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string }>("/backups", { serviceId, destination: "gdrive", trigger: "manual" });
      show(`Backup job queued (${result.jobId.slice(0, 8)})`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Backup failed", "err");
    } finally { setBusy(false); }
  };

  const backupAllCustomerServices = async () => {
    if (!summary?.serviceCount) return;
    if (!confirm(`Start Admin Drive backups for ${summary.serviceCount} services across ${summary.customerCount} customers? This does not include the panel database or configuration.`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number }>("/backups/admin/batch", { mode: "all-customers" });
      show(`Admin backup job queued for ${result.total} services (${result.jobId.slice(0, 8)})`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Batch backup failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Backups</h1>
          <p className="mt-1 text-sm text-muted">Create verified snapshots and upload them to the connected Google Drive.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={busy || !summary?.serviceCount} onClick={() => void backupAllCustomerServices()}>Back up all customer services</button>
          <select className="input min-w-48" value={serviceId} onChange={e => setServiceId(e.target.value)} aria-label="Select service">
            {services.length === 0 ? <option value="">No services available</option> : services.map(s => <option key={s._id} value={s._id}>{s.name}</option>)}
          </select>
          <button className="btn-primary" disabled={busy || !serviceId} onClick={() => void createBackup()}>{busy ? "Creating backup…" : "Back up to Google Drive"}</button>
        </div>
      </header>

      {summary ? (
        <GlassCard className="p-5">
          <h2 className="font-semibold">Admin backup scope</h2>
          <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div><p className="text-xs text-muted">Customers</p><p className="tnum text-xl font-semibold">{summary.customerCount}</p></div>
            <div><p className="text-xs text-muted">Services</p><p className="tnum text-xl font-semibold">{summary.serviceCount}</p></div>
            <div><p className="text-xs text-muted">Nodes</p><p className="tnum text-xl font-semibold">{summary.nodeCount}</p></div>
          </div>
          <p className="mt-4 text-xs text-muted">Service batch backups include: {summary.included.join(" · ")}</p>
          <p className="mt-2 text-xs text-amber-400">Not included in this operation: {summary.excluded.join(" · ")}. This is not a full panel/database backup.</p>
        </GlassCard>
      ) : null}

      <GlassCard className="p-5">
        <h2 className="font-semibold">Backup jobs</h2>
        <div className="mt-3 space-y-2">
          {jobs.map((job) => (
            <div key={job._id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm">
              <span className="font-mono text-xs">{job._id.slice(0, 8)}</span>
              <span className="text-xs text-muted">{job.completed}/{job.total} completed · {job.failed} failed</span>
              <span className="text-xs uppercase">{job.status}</span>
            </div>
          ))}
          {jobs.length === 0 ? <p className="text-xs text-muted">No backup jobs yet</p> : null}
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
