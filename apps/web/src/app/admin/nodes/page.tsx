"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";

interface NodeRow {
  _id: string;
  name: string;
  ip: string;
  location?: string;
  os?: string;
  online: boolean;
  status: string;
  maintenanceMode: boolean;
  cpuCores: number;
  ramTotalMb: number;
  diskTotalGb: number;
  lastHeartbeatAt?: string;
}

export default function AdminNodes() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [open, setOpen] = useState(false);
  const [enroll, setEnroll] = useState<{ name: string; token: string } | null>(null);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const res = await api.get<{ items?: NodeRow[] } | NodeRow[]>("/nodes");
      setNodes(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load nodes", "err");
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000); // light polling; skipped when tab hidden
    return () => clearInterval(t);
  }, []);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const res = await api.post<{ node: NodeRow; enrollmentToken: string }>("/nodes", {
        name: f.get("name"),
        ip: f.get("ip"),
        sshPort: Number(f.get("sshPort") || 22),
        sshUsername: f.get("sshUsername") || "root",
        os: f.get("os"),
        location: f.get("location"),
        cpuCores: Number(f.get("cpuCores")),
        ramTotalMb: Number(f.get("ramTotalMb")),
        diskTotalGb: Number(f.get("diskTotalGb")),
      });
      setOpen(false);
      setEnroll({ name: res.node.name, token: res.enrollmentToken });
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to add node", "err");
    }
  };

  const toggleMaintenance = async (n: NodeRow) => {
    await api.post(`/nodes/${n._id}/maintenance`, { enabled: !n.maintenanceMode });
    void load();
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Nodes</h1>
          <p className="mt-1 text-sm text-muted">Remote compute nodes running the Go agent.</p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>Add Node</button>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {nodes.map((n) => (
          <GlassCard key={n._id} className="animate-rise p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold">{n.name}</p>
                <p className="tnum mt-0.5 text-xs text-muted">{n.ip} · {n.location ?? "unknown"}</p>
              </div>
              <StatusBadge status={n.online ? "online" : "offline"} />
            </div>
            <dl className="tnum mt-4 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="glass-soft py-2">
                <dt className="text-muted">CPU</dt>
                <dd className="font-medium">{n.cpuCores} cores</dd>
              </div>
              <div className="glass-soft py-2">
                <dt className="text-muted">RAM</dt>
                <dd className="font-medium">{(n.ramTotalMb / 1024).toFixed(0)} GB</dd>
              </div>
              <div className="glass-soft py-2">
                <dt className="text-muted">Disk</dt>
                <dd className="font-medium">{n.diskTotalGb} GB</dd>
              </div>
            </dl>
            <p className="mt-3 text-[11px] text-muted">
              Last heartbeat: {n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleString() : "never"}
            </p>
            <div className="mt-4 flex gap-2">
              <button className="btn-ghost flex-1 text-xs" onClick={() => void toggleMaintenance(n)}>
                {n.maintenanceMode ? "Exit maintenance" : "Maintenance"}
              </button>
            </div>
          </GlassCard>
        ))}
        {nodes.length === 0 ? (
          <GlassCard className="p-10 text-center text-sm text-muted md:col-span-2 xl:col-span-3">
            No nodes yet. Add your first compute node to start hosting services.
          </GlassCard>
        ) : null}
      </div>

      <Modal open={open} title="Add Node" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label" htmlFor="n-name">Name</label>
            <input id="n-name" name="name" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="n-ip">IP address</label>
            <input id="n-ip" name="ip" required className="input" placeholder="103.45.67.89" />
          </div>
          <div>
            <label className="label" htmlFor="n-sshport">SSH port</label>
            <input id="n-sshport" name="sshPort" type="number" defaultValue={22} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="n-sshuser">SSH user</label>
            <input id="n-sshuser" name="sshUsername" defaultValue="root" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="n-os">Operating system</label>
            <select id="n-os" name="os" className="input">
              <option value="ubuntu">Ubuntu</option>
              <option value="debian">Debian</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="n-location">Location</label>
            <input id="n-location" name="location" className="input" placeholder="Frankfurt, DE" />
          </div>
          <div>
            <label className="label" htmlFor="n-cpu">CPU cores</label>
            <input id="n-cpu" name="cpuCores" type="number" min={1} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="n-ram">RAM (MB)</label>
            <input id="n-ram" name="ramTotalMb" type="number" min={1024} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="n-disk">Disk (GB)</label>
            <input id="n-disk" name="diskTotalGb" type="number" min={10} required className="input" />
          </div>
          <div className="col-span-2">
            <button className="btn-primary w-full">Create & issue enrollment token</button>
          </div>
        </form>
      </Modal>

      <Modal open={enroll !== null} title={`Enroll ${enroll?.name ?? ""}`} onClose={() => setEnroll(null)}>
        <p className="text-sm text-muted">
          Run this on the node (Ubuntu/Debian). The token is single-use and expires in 30 minutes.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-xs leading-relaxed">
{`curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \\
  --api https://YOUR-PANEL-DOMAIN \\
  --token ${enroll?.token ?? ""}`}
        </pre>
        <button
          className="btn-ghost mt-4 w-full text-xs"
          onClick={() => void navigator.clipboard.writeText(enroll?.token ?? "")}
        >
          Copy token
        </button>
      </Modal>

      {node}
    </div>
  );
}
