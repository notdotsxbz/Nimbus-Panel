"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

interface DomainRow {
  _id: string;
  hostname: string;
  verification: string;
  source: string;
  serviceId?: string;
}

interface AddResult {
  domain: DomainRow;
  instructions: { txt: { name: string; value: string }; note: string };
}

export default function MyDomains() {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [pending, setPending] = useState<AddResult | null>(null);
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
      const res = await api.post<AddResult>("/domains/custom", { hostname: f.get("hostname") });
      setPending(res);
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed", "err");
    }
  };

  const verify = async (id: string) => {
    try {
      const res = await api.post<{ verification: string }>(`/domains/${id}/verify`);
      show(res.verification === "verified" ? "Domain verified" : `Verification ${res.verification}`, res.verification === "verified" ? "ok" : "info");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed", "err");
    }
  };

  const remove = async (id: string) => {
    await api.del(`/domains/${id}`);
    void load();
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Domains</h1>
        <p className="mt-1 text-sm text-muted">
          Connect your own domain, or use the free Nimbus subdomain assigned with your service.
        </p>
      </header>

      <GlassCard className="p-5">
        <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row">
          <input
            name="hostname"
            required
            className="input flex-1"
            placeholder="play.example.com"
            aria-label="Domain or subdomain"
          />
          <button className="btn-primary sm:w-40">Add domain</button>
        </form>
      </GlassCard>

      {pending ? (
        <GlassCard className="p-6">
          <h2 className="font-semibold">Verify ownership</h2>
          <p className="mt-2 text-sm text-muted">{pending.instructions.note}</p>
          <div className="glass-soft mt-3 p-4 font-mono text-xs">
            <p>Type: TXT</p>
            <p>Name: {pending.instructions.txt.name}</p>
            <p>Value: {pending.instructions.txt.value}</p>
          </div>
          <button className="btn-ghost mt-3 text-xs" onClick={() => setPending(null)}>Dismiss</button>
        </GlassCard>
      ) : null}

      <div className="space-y-3">
        {rows.map((d) => (
          <GlassCard key={d._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <p className="font-mono text-sm">{d.hostname}</p>
              <p className="text-xs text-muted">
                {d.source} · verification: {d.verification}
              </p>
            </div>
            <div className="flex gap-2">
              {d.verification !== "verified" ? (
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void verify(d._id)}>Verify</button>
              ) : null}
              <button className="btn-danger !px-3 !py-1.5 text-xs" onClick={() => void remove(d._id)}>Remove</button>
            </div>
          </GlassCard>
        ))}
        {rows.length === 0 ? (
          <GlassCard className="p-10 text-center text-sm text-muted">No custom domains yet.</GlassCard>
        ) : null}
      </div>

      {node}
    </div>
  );
}
