"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

type SoftwareRow = {
  _id: string; name: string; identifier: string; description: string; category: string;
  serviceTypes: string[]; sourceType: string; sourceConfig: Record<string, string>;
  enabled: boolean; customerAvailable: boolean; autoPublish: boolean; lastSyncedAt?: string; lastSyncStatus: string;
};
type VersionRow = { _id: string; version: string; releaseName: string; releaseDate?: string; prerelease: boolean; publicationStatus: string; recommended: boolean; deprecated: boolean };

export default function AdminSoftwarePage() {
  const [items, setItems] = useState<SoftwareRow[]>([]);
  const [selected, setSelected] = useState<SoftwareRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [manualVersion, setManualVersion] = useState("");
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try { setItems(await api.get<SoftwareRow[]>("/software")); }
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
      const result = await api.post<{ discovered: number; imported: number; skipped: number; failed: number }>(`/software/${selected._id}/fetch`);
      show(`Found ${result.discovered}; imported ${result.imported}; already present ${result.skipped}; failed ${result.failed}`, result.failed ? "info" : "ok");
      await openSoftware(selected);
      await load();
    } catch (e) { show(e instanceof Error ? e.message : "Version fetch failed", "err"); }
    finally { setBusy(false); }
  };

  const saveSoftware = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const serviceTypes = String(data.get("serviceTypes") ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    const sourceType = String(data.get("sourceType") ?? "manual");
    const sourceConfig: Record<string, string> = {};
    if (sourceType === "github-releases") sourceConfig.repository = String(data.get("repository") ?? "").trim();
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
        <label className="space-y-1 text-sm">Version source<select name="sourceType" className="input w-full"><option value="manual">Manual</option><option value="github-releases">GitHub Releases</option><option value="nodejs-index">Official Node.js releases</option><option value="modrinth">Modrinth project</option></select></label>
        <label className="space-y-1 text-sm">GitHub repository<input name="repository" className="input w-full" placeholder="owner/repository" /></label>
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
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{selected.name}</h2><p className="text-xs text-muted">Last sync: {selected.lastSyncedAt ? new Date(selected.lastSyncedAt).toLocaleString() : "Never"} · {selected.lastSyncStatus}</p></div><div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={() => void toggleSoftware("enabled", selected.enabled)}>{selected.enabled ? "Disable software" : "Enable software"}</button><button className="btn-ghost" onClick={() => void toggleSoftware("customerAvailable", selected.customerAvailable)}>{selected.customerAvailable ? "Hide from customers" : "Show to customers"}</button><button className="btn-primary" disabled={busy || selected.sourceType === "manual"} onClick={() => void fetchVersions()}>{busy ? "Fetching…" : "Fetch versions"}</button></div></div>
          <form onSubmit={addManualVersion} className="mt-4 flex gap-2">
            <input className="input min-w-0 flex-1" value={manualVersion} onChange={e => setManualVersion(e.target.value)} placeholder="Add version manually" aria-label="Version number" />
            <button className="btn-ghost" type="submit">Add version</button>
          </form>
          {selectedVersionIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2 rounded-lg border border-white/10 p-3">
            <span className="self-center text-xs text-muted">{selectedVersionIds.length} selected</span>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("publish")}>Publish</button>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("disable")}>Disable</button>
            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void bulkAction("deprecate")}>Deprecate</button>
          </div>}
          <div className="mt-4 space-y-2">
            {versions.map(version => <div key={version._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-3">
              <input type="checkbox" checked={selectedVersionIds.includes(version._id)} onChange={e => setSelectedVersionIds(current => e.target.checked ? [...current, version._id] : current.filter(id => id !== version._id))} aria-label={"Select version " + version.version} />
              <div><strong className="font-mono text-sm">{version.version}</strong><p className="text-xs text-muted">{version.releaseName} · {version.prerelease ? "Prerelease" : "Stable"} · {version.publicationStatus}</p></div>
              <div className="flex gap-2">{version.publicationStatus !== "published" ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "published")}>Publish</button> : <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "disabled")}>Disable</button>}</div>
            </div>)}
            {!versions.length && <p className="text-sm text-muted">No versions imported yet. Fetch releases or add them manually through the API.</p>}
          </div>
        </> : <p className="py-12 text-center text-sm text-muted">Select software to view versions.</p>}
      </GlassCard>
    </div>
    {node}
  </div>;
}
