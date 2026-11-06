"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

interface DomainRow {
  _id: string;
  hostname: string;
  scope: string;
  source: string;
  verification: string;
  suspended: boolean;
}

export default function AdminDomains() {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const res = await api.get<{ items?: DomainRow[] } | DomainRow[]>("/domains");
      setRows(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load domains", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/domains/custom", { hostname: f.get("hostname") });
      show("Domain added — verify DNS ownership next", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed", "err");
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Domains</h1>
        <p className="mt-1 text-sm text-muted">
          Nimbus default domain, customer subdomains and verified custom domains.
        </p>
      </header>

      <GlassCard className="p-5">
        <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row">
          <input name="hostname" required className="input flex-1" placeholder="hosting.example.com" aria-label="Hostname" />
          <button className="btn-primary sm:w-40">Add domain</button>
        </form>
      </GlassCard>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Hostname</th>
              <th className="px-5 py-3 font-medium">Source</th>
              <th className="px-5 py-3 font-medium">Verification</th>
              <th className="px-5 py-3 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d._id} className="border-b border-white/5 last:border-0">
                <td className="px-5 py-3 font-mono text-xs">{d.hostname}</td>
                <td className="px-5 py-3 text-xs text-muted">{d.source}</td>
                <td className="px-5 py-3 text-xs">{d.verification}</td>
                <td className="px-5 py-3">
                  <span className={`status-dot ${d.suspended ? "status-suspended" : "status-online"}`} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={4} className="px-5 py-10 text-center text-muted">No domains configured</td></tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      {node}
    </div>
  );
}
