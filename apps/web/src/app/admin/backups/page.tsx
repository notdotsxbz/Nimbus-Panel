"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

interface BackupRow {
  _id: string;
  serviceId: { name?: string } | string;
  destination: string;
  status: string;
  trigger: string;
  sizeBytes?: number;
  createdAt: string;
}

export default function AdminBackups() {
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Backups</h1>
        <p className="mt-1 text-sm text-muted">
          Snapshots with sha256 integrity verification. Google Drive and S3 destinations are
          configured per account; restores stage before replacing data.
        </p>
      </header>

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
            {rows.map((b) => (
              <tr key={b._id} className="border-b border-white/5 last:border-0">
                <td className="px-5 py-3 font-medium">{typeof b.serviceId === "object" ? b.serviceId?.name : "—"}</td>
                <td className="px-5 py-3 text-xs uppercase text-muted">{b.destination}</td>
                <td className="px-5 py-3 text-xs text-muted">{b.trigger}</td>
                <td className="tnum px-5 py-3 text-xs">{b.sizeBytes ? `${(b.sizeBytes / 1048576).toFixed(1)} MB` : "—"}</td>
                <td className="px-5 py-3">
                  <span className={`inline-flex items-center gap-2 text-xs`}>
                    <span className={`status-dot ${b.status === "completed" ? "status-online" : b.status === "failed" ? "status-error" : "status-installing"}`} />
                    {b.status}
                  </span>
                </td>
                <td className="tnum px-5 py-3 text-xs text-muted">{new Date(b.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-muted">No backups recorded yet</td></tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      {node}
    </div>
  );
}
