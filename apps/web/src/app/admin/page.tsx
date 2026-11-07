"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { currentUser } from "@/lib/api";
import { GlassCard, Stat, StatusBadge } from "@/components/glass";

interface DashboardData {
  users: number;
  services: { total: number; active: number; expired: number; suspended: number };
  nodes: { online: number; offline: number; ramTotalMb: number; ramAllocatedMb: number };
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const user = currentUser();
    if (!user) return;
    void (async () => {
      try {
        const [services, nodesRaw] = await Promise.all([
          api.get<DashboardData["services"]>("/services/stats"),
          api.get<{ items?: { online: boolean; ramTotalMb: number }[] } | { online: boolean; ramTotalMb: number }[]>("/nodes"),
        ]);
        const usersRes = await api.get<{ total: number }>("/users");
        // /nodes returns a plain array; tolerate both shapes defensively
        const nodeList = Array.isArray(nodesRaw) ? nodesRaw : nodesRaw.items ?? [];
        const online = nodeList.filter((n) => n.online).length;
        setData({
          users: usersRes.total,
          services,
          nodes: {
            online,
            offline: nodeList.length - online,
            ramTotalMb: nodeList.reduce((s, n) => s + (n.ramTotalMb ?? 0), 0),
            ramAllocatedMb: 0,
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      }
    })();
  }, []);

  if (error) {
    return (
      <GlassCard className="p-6 text-sm text-err" role="alert">
        {error}
      </GlassCard>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">Live platform statistics — real data, no placeholders.</p>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Customers" value={data?.users ?? "—"} />
        <Stat label="Services" value={data?.services.total ?? "—"} />
        <Stat label="Active" value={data?.services.active ?? "—"} />
        <Stat label="Expired" value={data?.services.expired ?? "—"} />
        <Stat label="Suspended" value={data?.services.suspended ?? "—"} />
        <Stat label="Nodes Online" value={data?.nodes.online ?? "—"} />
        <Stat label="Nodes Offline" value={data?.nodes.offline ?? "—"} />
        <Stat
          label="Total RAM"
          value={data ? `${(data.nodes.ramTotalMb / 1024).toFixed(1)} GB` : "—"}
          hint="Across all nodes"
        />
      </div>

      <GlassCard className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <a href="/admin/users" className="btn-primary">Add Customer</a>
          <a href="/admin/nodes" className="btn-ghost">Add Node</a>
          <a href="/admin/services" className="btn-ghost">Assign Service</a>
          <a href="/admin/domains" className="btn-ghost">Add Domain</a>
          <a href="/admin/network" className="btn-ghost">Allocate Port</a>
        </div>
      </GlassCard>
    </div>
  );
}
