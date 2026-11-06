"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { GlassCard, Stat, StatusBadge, EmptyState } from "@/components/glass";

interface ServiceRow {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
  expiresAt?: string;
  subdomain?: string;
}

export default function CustomerDashboard() {
  const [services, setServices] = useState<ServiceRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ items?: ServiceRow[] } | ServiceRow[]>("/services");
        setServices(Array.isArray(res) ? res : res.items ?? []);
      } catch {
        setServices([]);
      }
    })();
  }, []);

  const active = services?.filter((s) => s.status === "online").length ?? 0;
  const offline = services?.filter((s) => ["offline", "error"].includes(s.status)).length ?? 0;
  const ram = (services ?? []).reduce((sum, s) => sum + s.ramMb, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Welcome back</h1>
        <p className="mt-1 text-sm text-muted">Your services at a glance.</p>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active Services" value={active} />
        <Stat label="Offline" value={offline} />
        <Stat label="Total RAM" value={`${(ram / 1024).toFixed(1)} GB`} />
        <Stat label="All Services" value={services?.length ?? "—"} />
      </div>

      {services === null ? (
        <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>
      ) : services.length === 0 ? (
        <EmptyState
          title="No services yet"
          hint="When your administrator assigns a service, it will appear here with full controls — start, stop, console, files and backups."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((s) => (
            <GlassCard key={s._id} className="animate-rise flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <p className="mt-0.5 text-xs uppercase tracking-wider text-muted">{s.type}</p>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <dl className="tnum mt-4 space-y-1 text-xs text-muted">
                <div className="flex justify-between"><dt>RAM</dt><dd>{s.ramMb} MB</dd></div>
                <div className="flex justify-between"><dt>Disk</dt><dd>{s.diskGb} GB</dd></div>
                {s.subdomain ? (
                  <div className="flex justify-between truncate"><dt>Domain</dt><dd className="font-mono">{s.subdomain}</dd></div>
                ) : null}
                {s.expiresAt ? (
                  <div className="flex justify-between"><dt>Expires</dt><dd>{new Date(s.expiresAt).toLocaleDateString()}</dd></div>
                ) : null}
              </dl>
              <Link href={`/dashboard/services/${s._id}`} className="btn-primary mt-5">
                Manage
              </Link>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
