"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, currentUser } from "@/lib/api";
import { GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";

interface NodeRow {
  _id: string;
  name: string;
  ip: string;
  sshPort: number;
  sshUsername: string;
  location?: string;
  os?: string;
  online: boolean;
  status: string;
  maintenanceMode: boolean;
  cpuCores: number;
  ramTotalMb: number;
  diskTotalGb: number;
  lastHeartbeatAt?: string;
  lastHeartbeat?: {
    cpuPercent?: number;
    ramUsedBytes?: number;
    ramTotalBytes?: number;
    diskUsedBytes?: number;
    diskTotalBytes?: number;
    containersRunning?: number;
    agentVersion?: string;
  } | null;
}

interface WorkloadRow {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
}

interface AllocationRow {
  _id: string;
  ip: string;
  port: number;
  protocol: string;
  serviceId?: { name?: string } | null;
}

interface HealthInfo {
  online: boolean;
  heartbeatAgeSeconds: number | null;
  note: string;
  lastHeartbeat?: NodeRow["lastHeartbeat"];
}

const GB = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export default function AdminNodes() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [open, setOpen] = useState(false);
  const [enroll, setEnroll] = useState<{ name: string; token: string } | null>(null);
  const [detail, setDetail] = useState<NodeRow | null>(null);
  const [workloads, setWorkloads] = useState<WorkloadRow[] | null>(null);
  const [allocs, setAllocs] = useState<AllocationRow[] | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<"safe" | "force">("safe");
  const [confirmName, setConfirmName] = useState("");
  const [reauthPassword, setReauthPassword] = useState("");
  const [deleteInfo, setDeleteInfo] = useState<{ workloads: { name: string; type: string; status: string }[]; allocationsInUse: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();
  const [role, setRole] = useState<string>("customer");

  useEffect(() => {
    setRole(currentUser()?.role ?? "customer");
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items?: NodeRow[] } | NodeRow[]>("/nodes");
      setNodes(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load nodes", "err");
    }
  }, [show]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const openDetails = async (n: NodeRow) => {
    setDetail(n);
    setHealth(null);
    setWorkloads(null);
    setAllocs(null);
    try {
      setWorkloads(await api.get<WorkloadRow[]>(`/nodes/${n._id}/workloads`));
      setAllocs(await api.get<AllocationRow[]>(`/nodes/${n._id}/allocations`));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load node details", "err");
    }
  };

  const refreshHealth = async () => {
    if (!detail) return;
    try {
      setHealth(await api.post<HealthInfo>(`/nodes/${detail._id}/refresh-health`));
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Health check failed", "err");
    }
  };

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
    if (detail?._id === n._id) setDetail({ ...detail, maintenanceMode: !n.maintenanceMode });
  };

  const revokeCredentials = async () => {
    if (!detail) return;
    if (!confirm(`Revoke agent credentials for "${detail.name}"? The running agent will be locked out until re-enrollment.`)) return;
    try {
      const res = await api.post<{ enrollmentToken: string }>(`/nodes/${detail._id}/revoke-credentials`);
      setEnroll({ name: detail.name, token: res.enrollmentToken });
      setDetail(null);
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Revocation failed", "err");
    }
  };

  const openDelete = async () => {
    if (!detail) return;
    setDeleteMode("safe");
    setConfirmName("");
    setReauthPassword("");
    setDeleteInfo(null);
    setDeleteOpen(true);
    try {
      const wl = await api.get<WorkloadRow[]>(`/nodes/${detail._id}/workloads`);
      const al = await api.get<AllocationRow[]>(`/nodes/${detail._id}/allocations`);
      setDeleteInfo({
        workloads: wl.map((w) => ({ name: w.name, type: w.type, status: w.status })),
        allocationsInUse: al.filter((a) => a.serviceId).length,
      });
    } catch {
      setDeleteInfo(null);
    }
  };

  // DELETE with a JSON body is not supported by the api helper — use fetch directly.
  const deleteNodeWithBody = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const token = localStorage.getItem("nimbus.token");
      const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      const res = await fetch(`${base}/api/v1/nodes/${detail._id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: deleteMode, confirmName, password: reauthPassword || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detailMsg = Array.isArray((body as { message?: unknown }).message)
          ? JSON.stringify((body as { message: unknown }).message)
          : String((body as { message?: string }).message ?? res.statusText);
        show(`Delete failed: ${detailMsg}`, "err");
        if ((body as { workloads?: unknown }).workloads) setDeleteInfo((body as { workloads: { name: string; type: string; status: string }[]; allocationsInUse: number }));
      } else {
        setDeleteOpen(false);
        setDetail(null);
        show(String((body as { note?: string }).note ?? "Node deleted"), "ok");
        void load();
      }
    } catch (err) {
      show(err instanceof Error ? err.message : "Delete failed", "err");
    }
    setBusy(false);
  };

  const saveEdit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    try {
      await api.patch(`/nodes/${detail._id}`, {
        name: f.get("name"),
        ip: f.get("ip"),
        sshPort: Number(f.get("sshPort") || 22),
        sshUsername: f.get("sshUsername") || "root",
        location: f.get("location"),
        cpuCores: Number(f.get("cpuCores")),
        ramTotalMb: Number(f.get("ramTotalMb")),
        diskTotalGb: Number(f.get("diskTotalGb")),
      });
      setEditOpen(false);
      show("Node updated", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const enrollCommand = (token: string) =>
    `curl -fsSL https://raw.githubusercontent.com/notdotsxbz/Nimbus-Panel/main/installer/install-node.sh | sudo bash -s -- \\\n  --api ${typeof window !== "undefined" ? window.location.origin : "https://YOUR-PANEL-DOMAIN"} \\\n  --token ${token}`;

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
              <div className="glass-soft py-2"><dt className="text-muted">CPU</dt><dd className="font-medium">{n.cpuCores} cores</dd></div>
              <div className="glass-soft py-2"><dt className="text-muted">RAM</dt><dd className="font-medium">{GB(n.ramTotalMb)}</dd></div>
              <div className="glass-soft py-2"><dt className="text-muted">Disk</dt><dd className="font-medium">{n.diskTotalGb} GB</dd></div>
            </dl>
            <p className="mt-3 text-[11px] text-muted">
              Last heartbeat: {n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleString() : "never"}
            </p>
            <div className="mt-4 flex gap-2">
              <button className="btn-ghost flex-1 text-xs" onClick={() => void openDetails(n)}>Details</button>
              <button className="btn-ghost flex-1 text-xs" onClick={() => void toggleMaintenance(n)}>
                {n.maintenanceMode ? "Exit maint." : "Maintenance"}
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

      {/* Add node */}
      <Modal open={open} title="Add Node" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><label className="label" htmlFor="n-name">Name</label><input id="n-name" name="name" required className="input" /></div>
          <div><label className="label" htmlFor="n-ip">IP address</label><input id="n-ip" name="ip" required className="input" placeholder="103.45.67.89" /></div>
          <div><label className="label" htmlFor="n-sshport">SSH port</label><input id="n-sshport" name="sshPort" type="number" defaultValue={22} className="input" /></div>
          <div><label className="label" htmlFor="n-sshuser">SSH user</label><input id="n-sshuser" name="sshUsername" defaultValue="root" className="input" /></div>
          <div>
            <label className="label" htmlFor="n-os">Operating system</label>
            <select id="n-os" name="os" className="input"><option value="ubuntu">Ubuntu</option><option value="debian">Debian</option></select>
          </div>
          <div className="col-span-2"><label className="label" htmlFor="n-location">Location</label><input id="n-location" name="location" className="input" placeholder="Frankfurt, DE" /></div>
          <div><label className="label" htmlFor="n-cpu">CPU cores</label><input id="n-cpu" name="cpuCores" type="number" min={1} required className="input" /></div>
          <div><label className="label" htmlFor="n-ram">RAM (MB)</label><input id="n-ram" name="ramTotalMb" type="number" min={1024} required className="input" /></div>
          <div><label className="label" htmlFor="n-disk">Disk (GB)</label><input id="n-disk" name="diskTotalGb" type="number" min={10} required className="input" /></div>
          <div className="col-span-2"><button className="btn-primary w-full">Create & issue enrollment token</button></div>
        </form>
      </Modal>

      {/* Enrollment token */}
      <Modal open={enroll !== null} title={`Enroll ${enroll?.name ?? ""}`} onClose={() => setEnroll(null)}>
        <p className="text-sm text-muted">Run this on the node (Ubuntu/Debian). The token is single-use and expires in 30 minutes.</p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-xs leading-relaxed">{enrollCommand(enroll?.token ?? "")}</pre>
        <button className="btn-ghost mt-4 w-full text-xs" onClick={() => void navigator.clipboard.writeText(enroll?.token ?? "")}>Copy token</button>
      </Modal>

      {/* Node details */}
      <Modal open={detail !== null} title={`Node: ${detail?.name ?? ""}`} onClose={() => setDetail(null)}>
        {detail ? (
          <div className="space-y-4">
            <dl className="tnum grid grid-cols-2 gap-2 text-xs">
              <div className="glass-soft p-2.5"><dt className="text-muted">IP</dt><dd className="font-mono">{detail.ip}</dd></div>
              <div className="glass-soft p-2.5"><dt className="text-muted">SSH</dt><dd>{detail.sshUsername}@{detail.sshPort}</dd></div>
              <div className="glass-soft p-2.5"><dt className="text-muted">OS</dt><dd>{detail.os ?? "—"}</dd></div>
              <div className="glass-soft p-2.5"><dt className="text-muted">Location</dt><dd>{detail.location ?? "—"}</dd></div>
              <div className="glass-soft p-2.5"><dt className="text-muted">Capacity</dt><dd>{detail.cpuCores} cores · {GB(detail.ramTotalMb)} · {detail.diskTotalGb} GB</dd></div>
              <div className="glass-soft p-2.5"><dt className="text-muted">Status</dt><dd><StatusBadge status={detail.online ? "online" : "offline"} /> {detail.maintenanceMode ? "· maintenance" : ""}</dd></div>
            </dl>

            <div className="glass-soft p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted">Health</span>
                <button className="btn-ghost !px-2 !py-0.5 text-[10px]" onClick={() => void refreshHealth()}>Refresh</button>
              </div>
              {health ? (
                <>
                  <p className="mt-1">{health.note}</p>
                  <p className="tnum mt-1 text-muted">
                    Heartbeat age: {health.heartbeatAgeSeconds ?? "—"}s
                    {health.lastHeartbeat ? ` · CPU ${health.lastHeartbeat.cpuPercent?.toFixed(1) ?? "—"}% · RAM ${GB((health.lastHeartbeat.ramUsedBytes ?? 0) / 1024)} · ${health.lastHeartbeat.containersRunning ?? 0} containers · agent ${health.lastHeartbeat.agentVersion ?? "—"}` : ""}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-muted">Last heartbeat: {detail.lastHeartbeatAt ? new Date(detail.lastHeartbeatAt).toLocaleString() : "never"}</p>
              )}
            </div>

            <div className="glass-soft p-3 text-xs">
              <p className="mb-1 font-medium">Workloads ({workloads?.length ?? "…"})</p>
              {workloads?.length ? (
                <ul className="space-y-1">{workloads.map((w) => <li key={w._id} className="flex justify-between"><span>{w.name} <span className="text-muted">({w.type})</span></span><StatusBadge status={w.status} /></li>)}</ul>
              ) : <p className="text-muted">{workloads ? "No services on this node." : "Loading…"}</p>}
            </div>

            <div className="glass-soft p-3 text-xs">
              <p className="mb-1 font-medium">Allocations ({allocs?.length ?? "…"})</p>
              {allocs?.length ? (
                <ul className="tnum space-y-1 font-mono">{allocs.map((a) => <li key={a._id} className="flex justify-between"><span>{a.ip}:{a.port}/{a.protocol}</span><span className="text-muted">{a.serviceId && typeof a.serviceId === "object" ? a.serviceId.name ?? "in use" : "free"}</span></li>)}</ul>
              ) : <p className="text-muted">{allocs ? "No allocations." : "Loading…"}</p>}
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn-ghost flex-1 text-xs" onClick={() => setEditOpen(true)}>Edit</button>
              <button className="btn-ghost flex-1 text-xs" onClick={() => void toggleMaintenance(detail)}>
                {detail.maintenanceMode ? "Exit maintenance" : "Maintenance"}
              </button>
              <button className="btn-ghost flex-1 text-xs" onClick={() => void revokeCredentials()}>Revoke credentials</button>
              <button className="btn-danger flex-1 text-xs" onClick={() => void openDelete()}>Delete Node</button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Edit node */}
      <Modal open={editOpen} title="Edit node" onClose={() => setEditOpen(false)}>
        {detail ? (
          <form onSubmit={saveEdit} className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label" htmlFor="e-name">Name</label><input id="e-name" name="name" defaultValue={detail.name} className="input" /></div>
            <div><label className="label" htmlFor="e-ip">IP</label><input id="e-ip" name="ip" defaultValue={detail.ip} className="input" /></div>
            <div><label className="label" htmlFor="e-sshport">SSH port</label><input id="e-sshport" name="sshPort" type="number" defaultValue={detail.sshPort} className="input" /></div>
            <div><label className="label" htmlFor="e-sshuser">SSH user</label><input id="e-sshuser" name="sshUsername" defaultValue={detail.sshUsername} className="input" /></div>
            <div><label className="label" htmlFor="e-location">Location</label><input id="e-location" name="location" defaultValue={detail.location} className="input" /></div>
            <div><label className="label" htmlFor="e-cpu">CPU cores</label><input id="e-cpu" name="cpuCores" type="number" defaultValue={detail.cpuCores} className="input" /></div>
            <div><label className="label" htmlFor="e-ram">RAM (MB)</label><input id="e-ram" name="ramTotalMb" type="number" defaultValue={detail.ramTotalMb} className="input" /></div>
            <div><label className="label" htmlFor="e-disk">Disk (GB)</label><input id="e-disk" name="diskTotalGb" type="number" defaultValue={detail.diskTotalGb} className="input" /></div>
            <div className="col-span-2"><button className="btn-primary w-full">Save changes</button></div>
          </form>
        ) : null}
      </Modal>

      {/* Delete node — Safe / Force */}
      <Modal open={deleteOpen} title="Delete Node" onClose={() => setDeleteOpen(false)}>
        {detail ? (
          <div className="space-y-4">
            <div className="glass-soft p-3 text-xs">
              <p><span className="text-muted">Node:</span> <strong>{detail.name}</strong></p>
              <p><span className="text-muted">IP:</span> <span className="font-mono">{detail.ip}</span></p>
              <p><span className="text-muted">Type:</span> {detail.os ?? "—"} compute node</p>
              <p><span className="text-muted">Active workloads:</span> {deleteInfo?.workloads.length ?? "…"}</p>
              <p><span className="text-muted">Allocations in use:</span> {deleteInfo?.allocationsInUse ?? "…"}</p>
              {deleteInfo?.workloads.length ? (
                <p className="mt-1 text-warn">Affected services: {deleteInfo.workloads.map((w) => w.name).join(", ")}</p>
              ) : null}
            </div>

            <div className="space-y-2 text-sm">
              <label className={`block cursor-pointer rounded-xl p-3 ${deleteMode === "safe" ? "bg-white/10" : "glass-soft"}`}>
                <input type="radio" name="delmode" checked={deleteMode === "safe"} onChange={() => setDeleteMode("safe")} className="mr-2 accent-white" />
                <strong>Safe Delete</strong> — requires zero workloads and no in-use allocations. Removes only the
                Control-Plane registration and revokes credentials. Customer data and the remote machine are untouched.
              </label>
              {role === "owner" ? (
                <label className={`block cursor-pointer rounded-xl p-3 ${deleteMode === "force" ? "bg-white/10" : "glass-soft"}`}>
                  <input type="radio" name="delmode" checked={deleteMode === "force"} onChange={() => setDeleteMode("force")} className="mr-2 accent-white" />
                  <strong>Force Delete (Owner only)</strong> — removes the registration even with workloads present.
                  Orphaned services are marked <em>suspended</em> for migration; allocations on this node are removed.
                  The remote machine is <strong>never</strong> wiped, and customer data/backups are untouched.
                </label>
              ) : null}
            </div>

            {deleteMode === "force" ? (
              <div className="space-y-3">
                <div>
                  <label className="label" htmlFor="del-confirm">Type the node name exactly: <span className="font-mono">{detail.name}</span></label>
                  <input id="del-confirm" className="input font-mono" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
                </div>
                <div>
                  <label className="label" htmlFor="del-pass">Re-authenticate — your account password</label>
                  <input id="del-pass" type="password" className="input" value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} autoComplete="current-password" />
                </div>
              </div>
            ) : null}

            <p className="text-[11px] leading-relaxed text-muted">
              Remote cleanup cannot be verified if the node is unreachable. This operation never wipes remote
              disks, deletes backups, or destroys VPS/VDS instances. The action is recorded permanently in the
              audit log with your account and a timestamp.
            </p>

            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => setDeleteOpen(false)}>Cancel</button>
              <button
                className="btn-danger flex-1"
                disabled={busy || (deleteMode === "force" && (confirmName !== detail.name || !reauthPassword))}
                onClick={() => void deleteNodeWithBody()}
              >
                {busy ? "Deleting…" : deleteMode === "force" ? "Force Delete Node" : "Safe Delete Node"}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {node}
    </div>
  );
}
