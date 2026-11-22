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
}

interface NodeOption {
  nodeId: string;
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
  const [step, setStep] = useState(1);
  const [users, setUsers] = useState<{ _id: string; username: string; role?: string }[]>([]);
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [catalog, setCatalog] = useState<SoftwareCatalogRow[]>([]);
  const [catalogVersions, setCatalogVersions] = useState<SoftwareVersionRow[]>([]);
  const [serviceType, setServiceType] = useState("minecraft");
  const [softwareId, setSoftwareId] = useState("");
  const [versionId, setVersionId] = useState("");
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
    setVersionId(published[0]?._id ?? "");
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
    setStep(1);
    setOpen(true);
    try {
      const [u, n, softwareRows] = await Promise.all([
        api.get<{ items: { _id: string; username: string; role?: string }[] }>("/users"),
        api.get<NodeOption[]>("/nodes/capacity"),
        api.get<SoftwareCatalogRow[]>("/software"),
      ]);
      setUsers((u.items ?? []).filter(user => user.role === "customer"));
      setNodes(n);
      setCatalog(softwareRows);
      setServiceType("minecraft");
      const first = softwareRows.find(item => item.enabled && item.serviceTypes.includes("minecraft") && item.installationConfig?.method === "docker-image-template");
      setSoftwareId(first?._id ?? "");
      setVersionId("");
      setCatalogVersions([]);
      if (first) await loadCatalogVersions(first._id);
    } catch {
      show("Could not load users, node capacity or software catalog", "err");
    }
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
    const f = new FormData(e.currentTarget);
    try {
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
        softwareId,
        versionId,
      });
      setOpen(false);
      if (created.status === "online") show("Service installed and container version verification completed.", "ok");
      else show("Service record created, but installation failed. Check the service status and operation history.", "err");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Assignment failed", "err");
    }
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
              </tr>
            ))}
            {services.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-muted">No services assigned yet</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      <Modal open={open} title={`Assign Service — Step ${step} of 2`} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label" htmlFor="s-owner">Customer</label>
            <select id="s-owner" name="ownerId" required className="input" onChange={() => setStep(2)}>
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
            <select id="s-node" name="nodeId" required className="input">
              <option value="">Select node…</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.nodeId.slice(-6)} — {(n.ramTotalMb - n.ramAllocatedMb) / 1024} GB RAM free
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
            {!catalogVersions.length ? <p className="mt-1 text-xs text-muted">No published installable versions for this software. Fetch and publish versions in Admin → Software &amp; Versions first.</p> : null}
          </div>
          <div className="col-span-2">
            <button className="btn-primary w-full">Review & Assign</button>
          </div>
        </form>
      </Modal>

      {node}
    </div>
  );
}
