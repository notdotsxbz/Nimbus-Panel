"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

interface BackupJobRow {
  _id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
}

interface BackupRow {
  _id: string;
  destination: string;
  status: string;
  trigger: string;
  sizeBytes?: number;
  createdAt: string;
  serviceId: { name?: string } | string;
}

export default function CustomerBackups() {
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [jobs, setJobs] = useState<BackupJobRow[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [res, jobRows] = await Promise.all([
        api.get<{ items?: BackupRow[] } | BackupRow[]>("/backups"),
        api.get<BackupJobRow[]>("/backups/jobs"),
      ]);
      setRows(Array.isArray(res) ? res : res.items ?? []);
      setJobs(jobRows);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const download = async (id: string) => {
    try {
      const response = await api.raw(`/backups/${id}/download`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(error.message ?? "Download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nimbus-backup-${id}.tar.gz`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      show(err instanceof Error ? err.message : "Download failed", "err");
    }
  };

  const deleteBackup = async (id: string) => {
    if (!confirm("Delete this backup archive? This will not delete your service files.")) return;
    try {
      await api.del(`/backups/${id}`);
      setRows(current => current.filter(row => row._id !== id));
      show("Backup deleted", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Delete failed", "err");
    }
  };

  const restore = async (id: string) => {
    if (!confirm("Restore this backup? The service may be stopped briefly. Its current data will be preserved as a safety copy, and the selected backup will replace the active service files.")) return;
    try {
      const result = await api.post<{ jobId: string }>(`/backups/${id}/restore`, { confirm: true });
      show(`Restore job queued (${result.jobId.slice(0, 8)}). Track progress in Backup jobs.`, "info");
      await load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Restore failed", "err");
    }
  };



  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Backups</h1>
          <p className="mt-1 text-sm text-muted">Snapshots with integrity verification and staged restores.</p>
        </div>
        <span className="text-xs text-muted">Your backups are stored in your connected personal Google Drive.</span>
      </header>

      {jobs.length > 0 ? (
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
          </div>
        </GlassCard>
      ) : null}

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
                    <div className="flex justify-end gap-2">
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void download(b._id)}>Download</button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void restore(b._id)}>Restore</button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs text-red-400" onClick={() => void deleteBackup(b._id)}>Delete</button>
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
