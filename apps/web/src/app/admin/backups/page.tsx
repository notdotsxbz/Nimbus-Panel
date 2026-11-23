"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

interface BackupRow {
  _id: string;
  serviceId: { name?: string; type?: string } | string;
  ownerId: { _id?: string; displayName?: string; username?: string; email?: string } | string;
  destination: string;
  status: string;
  progressStage?: string;
  trigger: string;
  sizeBytes?: number;
  createdAt: string;
}
interface ServiceOption { _id: string; name: string; type: string; }
interface AdminCustomerOption { id: string; name: string; serviceCount: number; }
interface BackupJobRow {
  _id: string;
  mode?: string;
  panelArtifacts?: Record<string, unknown>;
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
  const [customers, setCustomers] = useState<AdminCustomerOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [selectedBackupIds, setSelectedBackupIds] = useState<string[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [recoveryCommand, setRecoveryCommand] = useState("");
  const [summary, setSummary] = useState<AdminBackupSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [backupRows, serviceRows, customerRows, backupSummary, backupJobs] = await Promise.all([
        api.get<BackupRow[]>("/backups"),
        api.get<ServiceOption[]>("/services"),
        api.get<AdminCustomerOption[]>("/backups/admin/customers"),
        api.get<AdminBackupSummary>("/backups/admin/summary"),
        api.get<BackupJobRow[]>("/backups/jobs"),
      ]);
      setRows(backupRows);
      setServices(serviceRows);
      setCustomers(customerRows);
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

  const restoreSelectedBackups = async () => {
    if (!selectedBackupIds.length) return;
    if (!confirm(`Restore ${selectedBackupIds.length} selected service backups? Each affected service may be stopped briefly. Current service data will be preserved as safety backups.`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number }>("/backups/admin/restore-selection", {
        mode: "selected-services", backupIds: selectedBackupIds, confirm: true,
      });
      show(`Restore job queued for ${result.total} services (${result.jobId.slice(0, 8)})`, "info");
      setSelectedBackupIds([]);
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Restore could not be queued", "err");
    } finally {
      setBusy(false);
    }
  };

  const backupSelectedCustomer = async () => {
    if (!selectedCustomerId) return;
    const customer = customers.find((item) => item.id === selectedCustomerId);
    if (!customer || customer.serviceCount < 1) return;
    if (!confirm(`Back up all ${customer.serviceCount} eligible services belonging to ${customer.name} to the Admin Google Drive?`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number }>("/backups/admin/batch", {
        mode: "selected-customers", customerIds: [selectedCustomerId],
      });
      show(`Customer backup job queued for ${result.total} services (${result.jobId.slice(0, 8)})`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Customer backup could not be queued", "err");
    } finally {
      setBusy(false);
    }
  };

  const restoreSelectedCustomer = async () => {
    if (!selectedCustomerId) return;
    const customer = customerOptions.find(([id]) => id === selectedCustomerId);
    if (!confirm(`Restore the latest available backup for each service belonging to ${customer?.[1] ?? "this customer"}? Services may be stopped briefly. Safety backups will be created first.`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number }>("/backups/admin/restore-selection", {
        mode: "selected-customer", customerId: selectedCustomerId, confirm: true,
      });
      show(`Customer restore job queued for ${result.total} services (${result.jobId.slice(0, 8)})`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Customer restore could not be queued", "err");
    } finally {
      setBusy(false);
    }
  };

  const prepareFullPanelRecovery = async (jobId: string) => {
    if (!confirm("Prepare a maintenance-mode recovery script for the panel database and configuration? You must run the generated command over SSH as root. Customer service archives are restored separately from the manifest.")) return;
    setBusy(true);
    try {
      const result = await api.post<{ command: string; scriptPath: string }>(`/backups/admin/full/${jobId}/prepare-restore`, { confirm: true });
      setRecoveryCommand(result.command);
      show(`Recovery script prepared at ${result.scriptPath}`, "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Recovery preparation failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const restoreFullPanelServices = async (jobId: string) => {
    if (!confirm("Queue restores for every customer service listed in this Full Panel manifest? Each affected service may be stopped briefly and will receive a safety backup first.")) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number; skipped: number }>(`/backups/admin/full/${jobId}/restore-services`, { confirm: true });
      show(`Customer service restore queued: ${result.total} services (${result.jobId.slice(0, 8)}). ${result.skipped} manifest entries skipped.`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Service restore could not be queued", "err");
    } finally {
      setBusy(false);
    }
  };

  const createFullPanelBackup = async () => {
    if (!summary) return;
    if (!confirm(`Create a Full Panel Backup? This includes the panel database, encrypted configuration, system metadata and all ${summary.serviceCount} eligible customer services. VPS/VDS disk images are not included.`)) return;
    setBusy(true);
    try {
      const result = await api.post<{ jobId: string; total: number }>("/backups/admin/full", {});
      show(`Full Panel Backup queued (${result.total} tasks, job ${result.jobId.slice(0, 8)})`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Full Panel Backup could not be queued", "err");
    } finally {
      setBusy(false);
    }
  };

  const customerOptions = customers.map((customer) => [
    customer.id,
    customer.name + " (" + customer.serviceCount + " services)",
  ] as const);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Backups</h1>
          <p className="mt-1 text-sm text-muted">Create verified snapshots and upload them to the connected Google Drive.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={busy || !summary?.serviceCount} onClick={() => void backupAllCustomerServices()}>Back up all customer services</button>
          <button className="btn-primary" disabled={busy || !summary} onClick={() => void createFullPanelBackup()}>Full Panel Backup</button>
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
          <p className="mt-4 text-xs text-muted">Full Panel Backup includes: {summary.included.join(" · ")}</p>
          <p className="mt-2 text-xs text-amber-400">Not included: {summary.excluded.join(" · ")}.</p>
          <p className="mt-2 text-xs text-muted">Full Panel recovery uses two stages: prepare and run the maintenance-mode database/configuration script over SSH, then restore customer service archives from the manifest. Individual customer/service restores are also available below.</p>
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
              {job.mode === "full-panel" ? (
                <div className="flex flex-wrap gap-2">
                  {job.panelArtifacts?.manifest && job.panelArtifacts?.database && job.panelArtifacts?.configuration ? <button className="btn-ghost text-xs" disabled={busy} onClick={() => void prepareFullPanelRecovery(job._id)}>Prepare DB/config recovery</button> : null}
                  <button className="btn-ghost text-xs" disabled={busy} onClick={() => void restoreFullPanelServices(job._id)}>Restore services from manifest</button>
                </div>
              ) : null}
            </div>
          ))}
          {jobs.length === 0 ? <p className="text-xs text-muted">No backup jobs yet</p> : null}
        </div>
      </GlassCard>

      {recoveryCommand ? (
        <GlassCard className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Run this recovery command over SSH as root</p>
            <button className="btn-ghost text-xs" onClick={() => void navigator.clipboard.writeText(recoveryCommand).then(() => show("Recovery command copied", "ok")).catch(() => show("Select and copy the command manually", "err"))}>Copy command</button>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-black/30 p-3 text-xs">{recoveryCommand}</pre>
          <p className="text-xs text-muted">The script creates a safety database dump, pauses panel services, restores the database/configuration, and restarts the panel. Restore customer service archives from the manifest afterwards.</p>
        </GlassCard>
      ) : null}

      <GlassCard className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-52 flex-1">
          <label className="label" htmlFor="restore-customer">Restore latest backups for customer</label>
          <select id="restore-customer" className="input" value={selectedCustomerId} onChange={(e) => setSelectedCustomerId(e.target.value)}>
            <option value="">Select customer…</option>
            {customerOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <button className="btn-ghost" disabled={busy || !selectedCustomerId || (customers.find((item) => item.id === selectedCustomerId)?.serviceCount ?? 0) < 1} onClick={() => void backupSelectedCustomer()}>Back up customer</button>
        <button className="btn-ghost" disabled={busy || !selectedCustomerId} onClick={() => void restoreSelectedCustomer()}>Restore customer</button>
        <button className="btn-primary" disabled={busy || !selectedBackupIds.length} onClick={() => void restoreSelectedBackups()}>Restore selected ({selectedBackupIds.length})</button>
      </GlassCard>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-3 py-3 font-medium">Select</th>
              <th className="px-5 py-3 font-medium">Customer</th>
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
                <td className="px-3 py-3"><input type="checkbox" disabled={b.status !== "completed"} checked={selectedBackupIds.includes(b._id)} onChange={(e) => setSelectedBackupIds((current) => e.target.checked ? [...current, b._id] : current.filter((id) => id !== b._id))} /></td>
                <td className="px-5 py-3 text-xs text-muted">{typeof b.ownerId === "object" ? (b.ownerId.displayName ?? b.ownerId.username ?? b.ownerId.email ?? "Customer") : "—"}</td>
                <td className="px-5 py-3 font-medium">{typeof b.serviceId === "object" ? b.serviceId?.name : "—"}</td>
                <td className="px-5 py-3 text-xs uppercase text-muted">{b.destination}</td>
                <td className="px-5 py-3 text-xs text-muted">{b.trigger}</td>
                <td className="tnum px-5 py-3 text-xs">{b.sizeBytes ? `${(b.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</td>
                <td className="px-5 py-3"><span className="inline-flex items-center gap-2 text-xs"><span className={`status-dot ${b.status === "completed" ? "status-online" : b.status === "failed" ? "status-error" : "status-installing"}`} />{b.status === "running" && b.progressStage ? b.progressStage.replace(/_/g, " ") : b.status}</span></td>
                <td className="tnum px-5 py-3 text-xs text-muted">{new Date(b.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={8} className="px-5 py-10 text-center text-muted">No backups recorded yet</td></tr> : null}
          </tbody>
        </table>
      </GlassCard>
      {node}
    </div>
  );
}
