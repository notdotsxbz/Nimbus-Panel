"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

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
  const { show, node } = useToast();

  const load = async () => {
    try {
      const res = await api.get<{ items?: BackupRow[] } | BackupRow[]>("/backups");
      setRows(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load backups", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const restore = async (id: string) => {
    if (!confirm("Restore this backup? Current data is staged and only replaced after verification.")) return;
    try {
      await api.post(`/backups/${id}/restore`);
      show("Restore queued", "ok");
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
        <span className="text-xs text-muted">Backups are stored in the Drive configured by your panel owner.</span>
      </header>

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
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void restore(b._id)}>Restore</button>
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
