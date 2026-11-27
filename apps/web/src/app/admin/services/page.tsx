"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";

interface ServiceRow {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
  ownerId: { _id: string; username: string } | string;
  nodeId: { _id: string; name: string } | string;
  expiresAt?: string;
  subscriptionStatus?: string;
  activity?: { action: string; ok: boolean; detail?: string }[];
}

interface NodeOption {
  nodeId: string;
  name?: string;
  ramTotalMb: number;
  ramAllocatedMb: number;
  healthy: boolean;
}
interface SoftwareCatalogRow {
  _id: string; name: string; identifier: string; serviceTypes: string[]; enabled: boolean;
  installationConfig?: { method?: string; imageTemplate?: string };
}
interface SoftwareVersionRow {
  _id: string; version: string; publicationStatus: string; deprecated: boolean;
  compatible?: boolean; recommended?: boolean;
}
interface SoftwareVersionPage { items: SoftwareVersionRow[] }

export default function AdminServices() {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [wizardLoading, setWizardLoading] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [users, setUsers] = useState<{ _id: string; username: string; role?: string }[]>([]);
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [catalog, setCatalog] = useState<SoftwareCatalogRow[]>([]);
  const [catalogVersions, setCatalogVersions] = useState<SoftwareVersionRow[]>([]);
  const [serviceType, setServiceType] = useState("minecraft");
  const [softwareId, setSoftwareId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [workingId, setWorkingId] = useState<string | null>(null);
  const { show, node } = useToast();

  const load = async () => {
    try {
      const [res, userRes] = await Promise.all([
        api.get<{ items?: ServiceRow[] } | ServiceRow[]>("/services"),
        api.get<{ items: { _id: string; username: string; role?: string }[] }>("/users"),
      ]);
      setServices(Array.isArray(res) ? res : res.items ?? []);
      setUsers((userRes.items ?? []).filter(u => u.role === "customer"));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load services", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const loadCatalogVersions = async (id: string) => {
    const page = await api.get<SoftwareVersionPage>("/software/" + id + "/versions?page=1&limit=100");
    const published = page.items.filter(item => item.publicationStatus === "published" && !item.deprecated && item.compatible !== false);
    setCatalogVersions(published);
    setVersionId((published.find(item => item.recommended) ?? published[0])?._id ?? "");
  };

  const changeCatalogSoftware = async (id: string) => {
    setSoftwareId(id);
    setVersionId("");
    setCatalogVersions([]);
    if (!id) return;
    try { await loadCatalogVersions(id); }
    catch (err) { show(err instanceof Error ? err.message : "Could not load published versions", "err"); }
  };

  const changeServiceType = async (type: string) => {
    setServiceType(type);
    const first = catalog.find(item => item.enabled && item.serviceTypes.includes(type) && item.installationConfig?.method === "docker-image-template");
    setSoftwareId(first?._id ?? "");
    setVersionId("");
    setCatalogVersions([]);
    if (first) {
      try { await loadCatalogVersions(first._id); }
      catch (err) { show(err instanceof Error ? err.message : "Could not load published versions", "err"); }
    }
  };

  const openWizard = async () => {
    setOpen(true);
    setWizardLoading(true);
    setNodes([]);
    setNodeId("");
    setCatalog([]);
    setCatalogVersions([]);
    setSoftwareId("");
    setVersionId("");
    try {
      const [u, n, softwareRows] = await Promise.all([
        api.get<{ items: { _id: string; username: string; role?: string }[] }>("/users"),
        api.get<NodeOption[]>("/nodes/capacity"),
        api.get<SoftwareCatalogRow[]>("/software"),
      ]);
      setUsers((u.items ?? []).filter(user => user.role === "customer"));
      setNodes(n);
      setNodeId(n.length === 1 ? n[0].nodeId : "");
      setCatalog(softwareRows);
      if (!n.length) show("No healthy compute nodes with recent heartbeats. Check Admin → Nodes and the node agent before assigning services.", "err");
      setServiceType("minecraft");
      const first = softwareRows.find(item => item.enabled && item.serviceTypes.includes("minecraft") && item.installationConfig?.method === "docker-image-template");
      setSoftwareId(first?._id ?? "");
      setVersionId("");
      setCatalogVersions([]);
      if (first) await loadCatalogVersions(first._id);
    } catch {
      show("Could not load users, node capacity or software catalog", "err");
    } finally { setWizardLoading(false); }
  };

  const assignOwner = async (serviceId: string, ownerId: string) => {
    try {
      await api.patch(`/services/${serviceId}/owner`, { ownerId });
      show("Service access updated", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not update service access", "err");
      void load();
    }
  };

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (creating || wizardLoading) return;
    const f = new FormData(e.currentTarget);
    setCreating(true);
    try {
      if (!nodes.length) {
        show("No healthy compute node available. Verify the node agent heartbeat under Admin → Nodes.", "err");
        return;
      }
      if (!softwareId || !versionId) {
        show("Choose a published software version before assigning this service.", "err");
        return;
      }
      const created = await api.post<ServiceRow>("/software/provision", {
        name: f.get("name"),
        type: f.get("type"),
        ownerId: f.get("ownerId"),
        nodeId: f.get("nodeId"),
        cpuPercent: Number(f.get("cpuPercent")),
        ramMb: Number(f.get("ramMb")),
        diskGb: Number(f.get("diskGb")),
        startupCommand: String(f.get("startupCommand") ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        softwareId,
        versionId,
        expiresAt: f.get("durationDays") ? new Date(Date.now() + Number(f.get("durationDays")) * 86_400_000).toISOString() : undefined,
      });
      setOpen(false);
      if (created.status === "online") show("Service installed and container version verification completed.", "ok");
      else {
        const failure = [...(created.activity ?? [])].reverse().find(item => item.action === "install" && !item.ok);
        show(`Service record created, but installation failed: ${failure?.detail ?? "Check node-agent connectivity and operation history."}`, "err");
      }
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Assignment failed", "err");
    } finally { setCreating(false); }
  };

  const updateExpiry = async (service: ServiceRow) => {
    const value = window.prompt("Service duration in days (1–3650). Leave blank for unlimited.", service.expiresAt ? String(Math.max(1, Math.ceil((new Date(service.expiresAt).getTime() - Date.now()) / 86_400_000))) : "");
    if (value === null) return;
    const days = value.trim() === "" ? null : Number(value);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) { show("Enter 1–3650 days or leave blank for unlimited", "err"); return; }
    setWorkingId(service._id);
    try { await api.patch(`/services/${service._id}/expiry`, { days }); show("Service duration updated", "ok"); await load(); }
    catch (err) { show(err instanceof Error ? err.message : "Duration update failed", "err"); }
    finally { setWorkingId(null); }
  };

  const serviceAction = async (service: ServiceRow, action: "suspend" | "unsuspend" | "delete") => {
    if (!window.confirm(action === "delete" ? `Permanently delete "${service.name}" and its container? This cannot be undone.` : `${action === "suspend" ? "Suspend" : "Unsuspend"} "${service.name}"?`)) return;
    setWorkingId(service._id);
    try {
      if (action === "delete") await api.del(`/services/${service._id}`);
      else await api.post(`/services/${service._id}/${action}`, {});
      show(`Service ${action === "delete" ? "deleted" : action === "suspend" ? "suspended" : "unsuspended"}`, "ok");
      await load();
    } catch (err) { show(err instanceof Error ? err.message : "Service operation failed", "err"); }
    finally { setWorkingId(null); }
  };

  const nodeName = (n: ServiceRow["nodeId"]) => (typeof n === "object" ? n?.name : "—");
  const ownerName = (o: ServiceRow["ownerId"]) => (typeof o === "object" ? o?.username : "—");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">All Services</h1>
          <p className="mt-1 text-sm text-muted">Assign and manage every hosted service.</p>
        </div>
        <button className="btn-primary" onClick={() => void openWizard()}>Assign Service</button>
      </header>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">Service</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">Owner</th>
              <th className="px-5 py-3 font-medium">Node</th>
              <th className="px-5 py-3 font-medium">Resources</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Expires</th>
              <th className="px-5 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s._id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                <td className="px-5 py-3 font-medium">{s.name}</td>
                <td className="px-5 py-3 text-xs uppercase tracking-wider text-muted">{s.type}</td>
                <td className="px-5 py-3 text-muted">
                  <select className="input min-w-36 !py-1 text-xs" aria-label={`Assign ${s.name} to customer`} value={typeof s.ownerId === "object" ? s.ownerId?._id ?? "" : s.ownerId} onChange={(e) => void assignOwner(s._id, e.target.value)}>
                    {users.map((u) => <option key={u._id} value={u._id}>{u.username}</option>)}
                  </select>
                </td>
                <td className="px-5 py-3 text-muted">{nodeName(s.nodeId)}</td>
                <td className="tnum px-5 py-3 text-xs text-muted">
                  {s.ramMb} MB · {s.diskGb} GB
                </td>
                <td className="px-5 py-3"><StatusBadge status={s.status} /></td>
                <td className="px-5 py-3 text-xs">{s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : "Unlimited"}</td>
                <td className="px-5 py-3"><div className="flex flex-wrap gap-2"><button disabled={workingId === s._id} className="btn-ghost text-xs" onClick={() => void updateExpiry(s)}>Duration</button><button disabled={workingId === s._id} className="btn-ghost text-xs" onClick={() => void serviceAction(s, s.subscriptionStatus === "suspended" ? "unsuspend" : "suspend")}>{s.subscriptionStatus === "suspended" ? "Unsuspend" : "Suspend"}</button><button disabled={workingId === s._id} className="btn-danger text-xs" onClick={() => void serviceAction(s, "delete")}>Delete</button></div></td>
              </tr>
            ))}
            {services.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-muted">No services assigned yet</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      <Modal open={open} title="Create a service" onClose={() => { if (!creating) setOpen(false); }}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <p className="col-span-2 text-sm text-muted">Choose a customer, software and node. The recommended version is selected automatically. Review the resource limits, then create the service.</p>
          {wizardLoading && <p className="col-span-2 text-sm text-muted" role="status">Checking nodes, customers and available software…</p>}
          {!wizardLoading && !nodes.length && <p className="col-span-2 text-sm text-amber-300">No healthy node found. <a className="underline" href="/admin/nodes">Set up a compute node</a> first.</p>}
          <div className="col-span-2">
            <label className="label" htmlFor="s-owner">Customer</label>
            <select id="s-owner" name="ownerId" required className="input" defaultValue={users.length === 1 ? users[0]._id : ""}>
              <option value="">Select user…</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>{u.username}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-name">Service name</label>
            <input id="s-name" name="name" required className="input" placeholder="mc-survival" />
          </div>
          <div>
            <label className="label" htmlFor="s-type">Type</label>
            <select id="s-type" name="type" className="input" value={serviceType} onChange={event => void changeServiceType(event.target.value)}>
              <option value="minecraft">Minecraft</option>
              <option value="discord">Discord Bot</option>
              <option value="website">Website</option>
              <option value="backend">Backend</option>
              <option value="database">Database</option>
              <option value="mongodb">MongoDB</option>
              <option value="nodejs">Node.js Application</option>
              <option value="python">Python Application</option>
              <option value="lavalink">Lavalink</option>
              <option value="custom">Custom Application</option>
              <option value="docker">Docker</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="s-node">Node (only healthy nodes with capacity are listed)</label>
            <select id="s-node" name="nodeId" required className="input" value={nodeId} onChange={event => setNodeId(event.target.value)}>
              <option value="">Select node…</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.name ?? n.nodeId.slice(-6)} — {((n.ramTotalMb - n.ramAllocatedMb) / 1024).toFixed(1)} GB RAM free
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-ram">RAM (MB)</label>
            <input id="s-ram" name="ramMb" type="number" min={256} defaultValue={2048} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="s-disk">Disk (GB)</label>
            <input id="s-disk" name="diskGb" type="number" min={1} defaultValue={10} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="s-cpu">CPU (%)</label>
            <input id="s-cpu" name="cpuPercent" type="number" min={10} max={400} defaultValue={100} required className="input" />
          </div>
          <div className="col-span-2"><label className="label" htmlFor="s-duration">Duration (days, optional)</label><input id="s-duration" name="durationDays" type="number" min={1} max={3650} className="input" placeholder="Leave blank for unlimited" /></div>
          <details className="col-span-2"><summary className="cursor-pointer text-sm text-muted">Advanced startup settings (optional)</summary><div className="mt-2">
            <label className="label" htmlFor="s-startup">Startup command (optional, one argument per line)</label>
            <textarea id="s-startup" name="startupCommand" rows={2} className="input" placeholder={"npm\nstart"} />
            <p className="mt-1 text-xs text-muted">Examples: npm then start, or python then app.py. Leave blank for software images that provide their own startup.</p>
          </div></details>
          <div className="col-span-2">
            <label className="label" htmlFor="s-software">Approved software</label>
            <select id="s-software" name="softwareId" className="input" value={softwareId} onChange={event => void changeCatalogSoftware(event.target.value)}>
              <option value="">Select installable software…</option>
              {catalog.filter(item => item.enabled && item.serviceTypes.includes(serviceType) && item.installationConfig?.method === "docker-image-template").map(item => <option key={item._id} value={item._id}>{item.name}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="s-version">Published version</label>
            <select id="s-version" name="versionId" className="input" value={versionId} onChange={event => setVersionId(event.target.value)} disabled={!softwareId}>
              <option value="">Select published version…</option>
              {catalogVersions.map(item => <option key={item._id} value={item._id}>{item.version}{item.recommended ? " · Recommended" : ""}</option>)}
            </select>
            {!catalogVersions.length ? <p className="mt-1 text-xs text-muted">No published installable versions. <a className="underline" href="/admin/software">Add or publish a version</a> first.</p> : null}
          </div>
          <div className="col-span-2">
            <button className="btn-primary w-full disabled:opacity-50" disabled={creating || wizardLoading || !nodes.length || !softwareId || !versionId}>{creating ? "Installing service… do not submit again" : "Create & install service"}</button>
          </div>
        </form>
      </Modal>

      {node}
    </div>
  );
}
