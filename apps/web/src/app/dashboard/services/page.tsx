"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, StatusBadge, EmptyState } from "@/components/glass";

interface ServiceRow {
  _id: string;
  name: string;
  type: string;
  status: string;
}

export default function MyServices() {
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Services</h1>
        <p className="mt-1 text-sm text-muted">Everything assigned to your account.</p>
      </header>
      {services === null ? (
        <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>
      ) : services.length === 0 ? (
        <EmptyState title="No services yet" hint="Your assigned services will show up here." />
      ) : (
        <div className="space-y-3">
          {services.map((s) => (
            <GlassCard key={s._id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-4">
                <span className={`status-dot status-${s.status}`} aria-hidden />
                <div>
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs uppercase tracking-wider text-muted">{s.type}</p>
                </div>
              </div>
              <StatusBadge status={s.status} />
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
