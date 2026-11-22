"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

type SoftwareRow = {
  _id: string; name: string; identifier: string; description: string; category: string;
  serviceTypes: string[]; sourceType: string; sourceConfig: Record<string, string>;
  enabled: boolean; customerAvailable: boolean; autoPublish: boolean; autoSync: boolean; syncFrequency: string; lastSyncedAt?: string; nextSyncAt?: string; lastSyncStatus: string; syncHistory?: Array<{ startedAt: string; completedAt?: string; status: string; discovered?: number; imported?: number; skipped?: number; failed?: number; error?: string }>;
};
type VersionRow = { _id: string; version: string; releaseName: string; releaseDate?: string; prerelease: boolean; publicationStatus: string; recommended: boolean; deprecated: boolean };
type PreviewRow = { version: string; releaseName?: string; prerelease?: boolean; alreadyImported: boolean };
type OperationRow = { _id: string; serviceId: { name?: string; type?: string } | string; requestedSoftware: string; requestedVersion: string; status: string; progress: number; error?: string; warning?: string; verification?: { previousContainerRemoved?: boolean; previousContainerName?: string }; createdAt: string };

export default function AdminSoftwarePage() {
  const [items, setItems] = useState<SoftwareRow[]>([]);
  const [selected, setSelected] = useState<SoftwareRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [manualVersion, setManualVersion] = useState("");
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [selectedPreview, setSelectedPreview] = useState<string[]>([]);
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const [recentOperations, setRecentOperations] = useState<OperationRow[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try { const [catalog, operations] = await Promise.all([api.get<SoftwareRow[]>("/software"), api.get<OperationRow[]>("/software/operations")]); setItems(catalog); setRecentOperations(operations); }
    catch (e) { show(e instanceof Error ? e.message : "Could not load catalog", "err"); }
  };
  useEffect(() => { void load(); }, []);

  const openSoftware = async (software: SoftwareRow) => {
    setSelected(software);
    setSelectedVersionIds([]);
    try { setVersions(await api.get<VersionRow[]>(`/software/${software._id}/versions`)); }
    catch (e) { show(e instanceof Error ? e.message : "Could not load versions", "err"); }
  };

  const fetchVersions = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.post<{ discovered: number; newVersions: number; existingVersions: number; versions: PreviewRow[] }>(`/software/${selected._id}/preview`);
      setPreview(result.versions);
      setSelectedPreview(result.versions.filter(item => !item.alreadyImported).map(item => item.version));
      show("Discovered " + result.discovered + " versions; " + result.newVersions + " new and " + result.existingVersions + " already imported.", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Version fetch failed", "err"); }
    finally { setBusy(false); }
  };

  const saveSoftware = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const serviceTypes = String(data.get("serviceTypes") ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    const sourceType = String(data.get("sourceType") ?? "manual");
    const sourceConfig: Record<string, string> = {};
    if (sourceType === "github-releases" || sourceType === "dockerhub-tags") sourceConfig.repository = String(data.get("repository") ?? "").trim();
    if (sourceType === "modrinth") sourceConfig.projectId = String(data.get("projectId") ?? "").trim();
    const imageTemplate = String(data.get("imageTemplate") ?? "").trim();
    try {
      await api.post("/software", {
        name: data.get("name"), identifier: data.get("identifier"), description: data.get("description"),
        category: data.get("category"), serviceTypes, sourceType, sourceConfig,
        enabled: true, customerAvailable: true, autoPublish: data.get("autoPublish") === "true",
        autoSync: data.get("autoSync") === "true", syncFrequency: data.get("syncFrequency") || "manual",
        installationConfig: imageTemplate ? { method: "docker-image-template", imageTemplate } : {},
      });
      setFormOpen(false); show("Software added to catalog", "ok"); await load();
    } catch (e) { show(e instanceof Error ? e.message : "Could not save software", "err"); }
  };

  const importPreview = async (all: boolean) => {
    if (!selected) return;
    try {
      const result = await api.post<{ discovered: number; imported: number; skipped: number; failed: number }>("/software/" + selected._id + "/import", { versions: selectedPreview, all });
      show("Imported " + result.imported + "; already present " + result.skipped + "; failed " + result.failed, result.failed ? "info" : "ok");
      setPreview([]); setSelectedPreview([]); await openSoftware(selected); await load();
    } catch (e) { show(e instanceof Error ? e.message : "Version import failed", "err"); }
  };
  const updateAutoPublish = async (autoPublish: boolean) => {
    if (!selected) return;
    try {
      await api.patch("/software/" + selected._id, { autoPublish });
      const updated = { ...selected, autoPublish }; setSelected(updated);
      setItems(current => current.map(item => item._id === updated._id ? updated : item));
      show("Stable-release auto-publish setting updated", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not update auto-publish", "err"); }
  };
  const updateSyncSettings = async (autoSync: boolean, syncFrequency: string) => {
    if (!selected) return;
    try {
      await api.patch("/software/" + selected._id, { autoSync, syncFrequency });
      const updated = { ...selected, autoSync, syncFrequency }; setSelected(updated);
      setItems(current => current.map(item => item._id === updated._id ? updated : item));
      show("Automatic synchronization settings updated", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not update sync settings", "err"); }
  };
  const retryCleanup = async (operation: OperationRow) => {
    try {
      await api.post("/software/operations/" + operation._id + "/cleanup", {});
      show("Previous container cleanup completed", "ok");
      await load();
    } catch (e) { show(e instanceof Error ? e.message : "Cleanup is still pending", "err"); }
  };
  const editSoftware = async () => {
    if (!selected) return;
    const name = window.prompt("Software name", selected.name);
    if (name === null || !name.trim()) return;
    const description = window.prompt("Description", selected.description ?? "");
    if (description === null) return;
    try {
      await api.patch("/software/" + selected._id, { name: name.trim(), description });
      const updated = { ...selected, name: name.trim(), description };
      setSelected(updated); setItems(current => current.map(item => item._id === updated._id ? updated : item));
      show("Software details updated", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not update software", "err"); }
  };
  const deleteSoftware = async () => {
    if (!selected || !window.confirm("Delete " + selected.name + "? Software used by a service cannot be deleted.")) return;
    try { await api.del("/software/" + selected._id); setSelected(null); setVersions([]); show("Software deleted", "ok"); await load(); }
    catch (e) { show(e instanceof Error ? e.message : "Could not delete software", "err"); }
  };

  const deleteVersion = async (version: VersionRow) => {
    if (!selected || !window.confirm("Delete version " + version.version + "?")) return;
    try { await api.del("/software/" + selected._id + "/versions/" + version._id); await openSoftware(selected); show("Version deleted", "ok"); }
    catch (e) { show(e instanceof Error ? e.message : "Could not delete version", "err"); }
  };
  const toggleSoftware = async (field: "enabled" | "customerAvailable", value: boolean) => {
    if (!selected) return;
    try {
      await api.patch("/software/" + selected._id, { [field]: !value });
      const updated = { ...selected, [field]: !value }; setSelected(updated);
      setItems(current => current.map(item => item._id === updated._id ? updated : item));
      show(field === "enabled" ? "Software status updated" : "Customer availability updated", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not update software", "err"); }
  };
  const addManualVersion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !manualVersion.trim()) return;
    try {
      await api.post("/software/" + selected._id + "/versions", { version: manualVersion.trim() });
      setManualVersion(""); await openSoftware(selected); show("Version added as pending approval", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not add version", "err"); }
  };

  const bulkAction = async (action: string) => {
    if (!selected || !selectedVersionIds.length) return;
    try {
      const result = await api.post<{ matched: number; modified: number }>("/software/" + selected._id + "/versions/bulk", { versionIds: selectedVersionIds, action });
      show("Updated " + result.modified + " version(s)", "ok"); setSelectedVersionIds([]); await openSoftware(selected);
    } catch (e) { show(e instanceof Error ? e.message : "Bulk update failed", "err"); }
  };
  const setVersionStatus = async (version: VersionRow, publicationStatus: string) => {
    if (!selected) return;
    try {
      await api.patch(`/software/${selected._id}/versions/${version._id}`, { publicationStatus });
      await openSoftware(selected);
      show("Version status updated", "ok");
    } catch (e) { show(e instanceof Error ? e.message : "Could not update version", "err"); }
  };

  return <div className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Software &amp; Versions</h1><p className="mt-1 text-sm text-muted">Manage supported software and discover releases from official sources.</p></div>
      <button className="btn-primary" onClick={() => setFormOpen(v => !v)}>Add Software</button>
    </header>
    {formOpen && <GlassCard className="p-5">
      <form onSubmit={saveSoftware} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Name<input name="name" required className="input w-full" /></label>
        <label className="space-y-1 text-sm">Identifier<input name="identifier" required pattern="[a-z0-9][a-z0-9._-]{1,63}" className="input w-full" placeholder="nodejs" /></label>
        <label className="space-y-1 text-sm">Category<input name="category" className="input w-full" defaultValue="runtime" /></label>
        <label className="space-y-1 text-sm">Service types<input name="serviceTypes" required className="input w-full" placeholder="discord,website,backend" /></label>
        <label className="space-y-1 text-sm">Version source<select name="sourceType" className="input w-full"><option value="manual">Manual</option><option value="github-releases">GitHub Releases</option><option value="nodejs-index">Official Node.js releases</option><option value="modrinth">Modrinth project</option><option value="dockerhub-tags">Docker Hub tags</option></select></label>
        <label className="space-y-1 text-sm">GitHub / Docker Hub repository<input name="repository" className="input w-full" placeholder="owner/repository or namespace/repository" /></label>
        <label className="space-y-1 text-sm">Modrinth project ID<input name="projectId" className="input w-full" /></label>
        <label className="space-y-1 text-sm sm:col-span-2">Description<input name="description" className="input w-full" /></label>
        <div className="flex gap-2 sm:col-span-2"><button className="btn-primary" type="submit">Save software</button><button className="btn-ghost" type="button" onClick={() => setFormOpen(false)}>Cancel</button></div>
      </form>
      <p className="mt-3 text-xs text-muted">Service type values must match NIMBUS service types. Manual is available when an official source adapter is not configured.</p>
    </GlassCard>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <GlassCard className="overflow-hidden">
        <div className="border-b border-white/10 px-5 py-4 font-semibold">Catalog</div>
        {items.map(item => <button key={item._id} onClick={() => void openSoftware(item)} className={`block w-full border-b border-white/5 px-5 py-4 text-left hover:bg-white/5 ${selected?._id === item._id ? "bg-white/5" : ""}`}>
          <span className="flex items-center justify-between gap-2"><strong>{item.name}</strong><span className="text-xs text-muted">{item.enabled ? "Enabled" : "Disabled"}</span></span>
          <span className="mt-1 block text-xs text-muted">{item.identifier} · {item.serviceTypes.join(", ")}</span>
        </button>)}
        {!items.length && <p className="p-5 text-sm text-muted">No software entries yet.</p>}
      </GlassCard>
      <GlassCard className="p-5">
        {selected ? <>
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{selected.name}</h2><p className="text-xs text-muted">Last sync: {selected.lastSyncedAt ? new Date(selected.lastSyncedAt).toLocaleString() : "Never"} · {selected.lastSyncStatus} · Next: {selected.nextSyncAt ? new Date(selected.nextSyncAt).toLocaleString() : "Manual"}</p></div><div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={() => void editSoftware()}>Edit</button><button className="btn-ghost" onClick={() => void toggleSoftware("enabled", selected.enabled)}>{selected.enabled ? "Disable software" : "Enable software"}</button><button className="btn-ghost" onClick={() => void deleteSoftware()}>Delete software</button><button className="btn-ghost" onClick={() => void toggleSoftware("customerAvailable", selected.customerAvailable)}>{selected.customerAvailable ? "Hide from customers" : "Show to customers"}</button><button className="btn-primary" disabled={busy || selected.sourceType === "manual"} onClick={() => void fetchVersions()}>{busy ? "Fetching…" : "Fetch versions"}</button></div></div>
          {preview.length > 0 && <div className="mt-4 rounded-lg border border-white/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">Discovered versions</strong><div className="flex gap-2"><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void importPreview(false)} disabled={!selectedPreview.length}>Import selected</button><button className="btn-primary !px-2 !py-1 text-xs" onClick={() => void importPreview(true)}>Import all</button></div></div>
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
              {preview.map(item => <label key={item.version} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={selectedPreview.includes(item.version)} disabled={item.alreadyImported} onChange={e => setSelectedPreview(current => e.target.checked ? [...current, item.version] : current.filter(version => version !== item.version))} />
                <span className="font-mono">{item.version}</span><span className="text-muted">{item.releaseName ?? ""} {item.prerelease ? "· Prerelease" : ""}</span>{item.alreadyImported ? <span className="ml-auto text-muted">Already imported</span> : null}
              </label>)}
            </div>
          </div>}
          <form onSubmit={addManualVersion} className="mt-4 flex gap-2">
            <input className="input min-w-0 flex-1" value={manualVersion} onChange={e => setManualVersion(e.target.value)} placeholder="Add version manually" aria-label="Version number" />
            <button className="btn-ghost" type="submit">Add version</button>
          </form>
          {selectedVersionIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2 rounded-lg border border-white/10 p-3">
            <span className="self-center text-xs text-muted">{selectedVersionIds.length} selected</span>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("publish")}>Publish</button>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("disable")}>Disable</button>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("deprecate")}>Deprecate</button><button className="btn-ghost !px-2 !py-1 text-xs" disabled={selectedVersionIds.length !== 1} onClick={() => void bulkAction("recommend")}>Recommend</button>
          </div>}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
            <label className="flex items-center gap-2"><input type="checkbox" checked={selected.autoPublish} onChange={e => void updateAutoPublish(e.target.checked)} /> Auto-publish stable releases</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={selected.autoSync} onChange={e => void updateSyncSettings(e.target.checked, e.target.checked && selected.syncFrequency === "manual" ? "24h" : selected.syncFrequency)} /> Automatic sync</label>
            <label className="flex items-center gap-2">Frequency<select className="input !w-auto !py-1" value={selected.syncFrequency} onChange={e => void updateSyncSettings(selected.autoSync, e.target.value)}>{["manual", "6h", "12h", "24h", "7d"].map(value => <option key={value} value={value} disabled={selected.autoSync && value === "manual"}>{value === "manual" ? "Manual" : value}</option>)}</select></label>
          </div>
          {selected.syncHistory?.length ? <div className="mt-4 rounded-lg border border-white/10 p-3">
            <strong className="text-sm">Recent sync history</strong>
            <div className="mt-2 space-y-1">{selected.syncHistory.slice(-5).reverse().map((entry, index) => <p key={index} className="text-xs text-muted">{new Date(entry.startedAt).toLocaleString()} · {entry.status} · found {entry.discovered ?? 0}, imported {entry.imported ?? 0}, skipped {entry.skipped ?? 0}, failed {entry.failed ?? 0}{entry.error ? " · " + entry.error : ""}</p>)}</div>
          </div> : null}
          <div className="mt-4 space-y-2">
            {versions.map(version => <div key={version._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-3">
              <input type="checkbox" checked={selectedVersionIds.includes(version._id)} onChange={e => setSelectedVersionIds(current => e.target.checked ? [...current, version._id] : current.filter(id => id !== version._id))} aria-label={"Select version " + version.version} />
              <div><strong className="font-mono text-sm">{version.version}</strong><p className="text-xs text-muted">{version.releaseName} · {version.prerelease ? "Prerelease" : "Stable"} · {version.publicationStatus}{version.recommended ? " · Recommended" : ""}{version.deprecated ? " · Deprecated" : ""}</p></div>
              <div className="flex gap-2">{version.publicationStatus !== "published" ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "published")}>Publish</button> : <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "disabled")}>Disable</button>}<button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void deleteVersion(version)}>Delete</button></div>
            </div>)}
            {!versions.length && <p className="text-sm text-muted">No versions imported yet. Fetch releases or add them manually through the API.</p>}
          </div>
        </> : <p className="py-12 text-center text-sm text-muted">Select software to view versions.</p>}
      </GlassCard>
    </div>
        <GlassCard className="p-5">
      <h2 className="font-semibold">Recent software operations</h2>
      <div className="mt-3 space-y-2">
        {recentOperations.map(operation => <div key={operation._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-3 text-sm">
          <div><strong>{operation.requestedSoftware} · {operation.requestedVersion}</strong><p className="text-xs text-muted">{typeof operation.serviceId === "object" ? operation.serviceId?.name ?? "Service" : operation.serviceId} · {new Date(operation.createdAt).toLocaleString()}</p></div>
          <span className="text-xs text-muted">{operation.status} · {operation.progress}%</span>
          {operation.error ? <p className="w-full text-xs text-rose-300">{operation.error}</p> : null}{operation.warning ? <p className="w-full text-xs text-amber-300">{operation.warning}</p> : null}{operation.warning && operation.verification?.previousContainerName && !operation.verification.previousContainerRemoved ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void retryCleanup(operation)}>Retry old-container cleanup</button> : null}
        </div>)}
        {!recentOperations.length && <p className="text-sm text-muted">No software operations yet.</p>}
      </div>
    </GlassCard>
    {node}
  </div>;
}
