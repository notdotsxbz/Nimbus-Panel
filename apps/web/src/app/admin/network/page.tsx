"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

interface AllocationRow {
  _id: string;
  ip: string;
  port: number;
  protocol: string;
  nodeId: { name?: string } | string;
  serviceId?: unknown;
  reserved: boolean;
}

export default function AdminNetwork() {
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const res = await api.get<{ items?: AllocationRow[] } | AllocationRow[]>("/allocations");
      setRows(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load allocations", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const allocate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/allocations", {
        nodeId: f.get("nodeId"),
        ip: f.get("ip"),
        port: Number(f.get("port")),
        protocol: f.get("protocol"),
      });
      show("Port allocated", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Allocation failed", "err");
    }
  };

  const release = async (id: string) => {
    try {
      await api.del(`/allocations/${id}`);
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Release failed", "err");
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Allocations</h1>
        <p className="mt-1 text-sm text-muted">
          IP and port allocation (default range 4001–4050). Uniqueness is enforced per node, IP, port and protocol.
        </p>
      </header>

      <GlassCard className="p-5">
        <form onSubmit={allocate} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="col-span-2 sm:col-span-1">
            <label className="label" htmlFor="a-node">Node ID</label>
            <input id="a-node" name="nodeId" required className="input" placeholder="Mongo ObjectId" />
          </div>
          <div>
            <label className="label" htmlFor="a-ip">IP</label>
            <input id="a-ip" name="ip" required className="input" placeholder="103.45.67.89" />
          </div>
          <div>
            <label className="label" htmlFor="a-port">Port</label>
            <input id="a-port" name="port" type="number" min={1024} max={65535} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="a-proto">Protocol</label>
            <select id="a-proto" name="protocol" className="input">
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full">Allocate</button>
          </div>
        </form>
      </GlassCard>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Address</th>
              <th className="px-5 py-3 font-medium">Node</th>
              <th className="px-5 py-3 font-medium">Protocol</th>
              <th className="px-5 py-3 font-medium">Assigned</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className="border-b border-white/5 last:border-0">
                <td className="tnum px-5 py-3 font-mono">{r.ip}:{r.port}</td>
                <td className="px-5 py-3 text-muted">{typeof r.nodeId === "object" ? r.nodeId?.name : "—"}</td>
                <td className="px-5 py-3 uppercase text-xs">{r.protocol}</td>
                <td className="px-5 py-3 text-xs text-muted">{r.serviceId ? "in use" : "free"}</td>
                <td className="px-5 py-3 text-right">
                  {!r.serviceId ? (
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void release(r._id)}>Release</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-10 text-center text-muted">No allocations yet</td></tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      {node}
    </div>
  );
}
