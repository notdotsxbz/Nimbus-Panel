"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

type SoftwareRow = {
  _id: string; name: string; identifier: string; description: string; category: string;
  serviceTypes: string[]; sourceType: string; sourceConfig: Record<string, string>; installationConfig?: { method?: string; imageTemplate?: string; environment?: Record<string, string>; provider?: string; imageId?: string; minRamMb?: number; architecture?: string }; officialWebsite?: string; iconUrl?: string; supportedOperatingSystems?: string[]; supportedArchitectures?: string[]; requiredRuntime?: string; defaultVersion?: string;
  enabled: boolean; customerAvailable: boolean; autoPublish: boolean; autoSync: boolean; syncFrequency: string; lastSyncedAt?: string; nextSyncAt?: string; lastSyncStatus: string; syncHistory?: Array<{ startedAt: string; completedAt?: string; status: string; discovered?: number; imported?: number; skipped?: number; failed?: number; error?: string }>;
};
type VersionRow = { _id: string; version: string; releaseName: string; releaseDate?: string; prerelease: boolean; publicationStatus: string; recommended: boolean; deprecated: boolean; channel?: string; importedAt?: string; compatibility?: string[]; architectures?: string[]; runtimeRequirements?: Record<string, unknown>; checksum?: string; signature?: string; sourceUrl?: string };
type PreviewRow = { version: string; releaseName?: string; prerelease?: boolean; alreadyImported: boolean };
type SyncJobRow = { _id: string; softwareId: { name?: string; identifier?: string } | string; status: string; attempts: number; maxAttempts: number; runAt: string; lastError?: string; discovered?: number; imported?: number; failed?: number };
type OperationRow = { _id: string; serviceId: { name?: string; type?: string } | string; requestedBy?: { username?: string } | string; requestedSoftware: string; requestedVersion: string; previousSoftware?: string; previousVersion?: string; status: string; progress: number; error?: string; warning?: string; startedAt?: string; completedAt?: string; verification?: { running?: boolean; installedImage?: string; containerId?: string; healthStatus?: string; previousContainerRemoved?: boolean; previousContainerName?: string }; createdAt: string };

export default function AdminSoftwarePage() {
  const [items, setItems] = useState<SoftwareRow[]>([]);
  const [selected, setSelected] = useState<SoftwareRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [selectedPreview, setSelectedPreview] = useState<string[]>([]);
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const [recentOperations, setRecentOperations] = useState<OperationRow[]>([]);
  const [syncJobs, setSyncJobs] = useState<SyncJobRow[]>([]);
  const { show, node } = useToast();

  const load = async () => {
    try { const [catalog, operations, jobs] = await Promise.all([api.get<SoftwareRow[]>("/software"), api.get<OperationRow[]>("/software/operations"), api.get<SyncJobRow[]>("/software/sync-jobs")]); setItems(catalog); setRecentOperations(operations); setSyncJobs(jobs); }
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
    const supportedOperatingSystems = String(data.get("supportedOperatingSystems") ?? "").split(",").map(v => v.trim()).filter(Boolean);
    const supportedArchitectures = String(data.get("supportedArchitectures") ?? "").split(",").map(v => v.trim()).filter(Boolean);
    const sourceType = String(data.get("sourceType") ?? "manual");
    const sourceConfig: Record<string, string> = {};
    if (sourceType === "github-releases" || sourceType === "dockerhub-tags") sourceConfig.repository = String(data.get("repository") ?? "").trim();
    if (sourceType === "modrinth") sourceConfig.projectId = String(data.get("projectId") ?? "").trim();
    if (sourceType === "dotnet-index") sourceConfig.channelVersion = String(data.get("channelVersion") ?? "").trim();
    if (sourceType === "papermc") sourceConfig.project = String(data.get("paperProject") ?? "paper");
    if (sourceType === "php-releases") sourceConfig.majorVersion = String(data.get("phpMajorVersion") ?? "").trim();
    const imageTemplate = String(data.get("imageTemplate") ?? "").trim();
    const installationMethod = String(data.get("installationMethod") ?? "none");
    const environment: Record<string, string> = {};
    for (const line of String(data.get("environment") ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) { show("Environment entries must use KEY=VALUE, one per line.", "err"); return; }
      environment[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
    }
    try {
      const payload = {
        name: data.get("name"), identifier: data.get("identifier"), description: data.get("description"),
        officialWebsite: data.get("officialWebsite"), iconUrl: data.get("iconUrl"), supportedOperatingSystems, supportedArchitectures,
        requiredRuntime: data.get("requiredRuntime"), defaultVersion: data.get("defaultVersion"),
        category: data.get("category"), serviceTypes, sourceType, sourceConfig,
        enabled: data.get("enabled") === "true", customerAvailable: data.get("customerAvailable") === "true",
        autoPublish: data.get("autoPublish") === "true",
        autoSync: data.get("autoSync") === "true", syncFrequency: data.get("syncFrequency") || "manual",
        installationConfig: installationMethod === "virtualization-image"
          ? { method: "virtualization-image", provider: "kvm-libvirt", imageId: String(data.get("osImageId") ?? "").trim(), minRamMb: Number(data.get("osMinRamMb")), architecture: String(data.get("osArchitecture") ?? "amd64") }
          : imageTemplate || installationMethod === "docker-image-template"
            ? { method: "docker-image-template", imageTemplate, environment }
            : {},
      };
      if (editingId) await api.patch("/software/" + editingId, payload);
      else await api.post("/software", payload);
      setFormOpen(false); setEditingId(null); show(editingId ? "Software updated" : "Software added to catalog", "ok"); await load();
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
  const retrySyncJob = async (job: SyncJobRow) => {
    try {
      await api.post("/software/sync-jobs/" + job._id + "/retry", {});
      show("Synchronization job queued for retry", "ok");
      await load();
    } catch (e) { show(e instanceof Error ? e.message : "Could not retry synchronization", "err"); }
  };
  const retryCleanup = async (operation: OperationRow) => {
    try {
      await api.post("/software/operations/" + operation._id + "/cleanup", {});
      show("Previous container cleanup completed", "ok");
      await load();
    } catch (e) { show(e instanceof Error ? e.message : "Cleanup is still pending", "err"); }
  };
  const editSoftware = () => {
    if (!selected) return;
    setEditingId(selected._id);
    setFormOpen(true);
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
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const version = String(data.get("version") ?? "").trim();
    if (!version) return;
    let runtimeRequirements: Record<string, unknown> = {};
    const runtimeText = String(data.get("runtimeRequirements") ?? "").trim();
    if (runtimeText) {
      try {
        const parsed = JSON.parse(runtimeText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Runtime requirements must be a JSON object");
        runtimeRequirements = parsed;
      } catch (error) {
        show(error instanceof Error ? error.message : "Invalid runtime requirements JSON", "err");
        return;
      }
    }
    const channel = String(data.get("channel") ?? "stable");
    try {
      await api.post("/software/" + selected._id + "/versions", {
        version,
        releaseName: String(data.get("releaseName") ?? "").trim(),
        releaseDate: data.get("releaseDate") || undefined,
        channel,
        prerelease: channel === "prerelease" || channel === "nightly",
        sourceUrl: String(data.get("sourceUrl") ?? "").trim() || undefined,
        compatibility: String(data.get("compatibility") ?? "").split(",").map(value => value.trim()).filter(Boolean),
        architectures: String(data.get("architectures") ?? "").split(",").map(value => value.trim()).filter(Boolean),
        checksum: String(data.get("checksum") ?? "").trim(),
        signature: String(data.get("signature") ?? "").trim(),
        runtimeRequirements,
      });
      form.reset();
      await openSoftware(selected);
      show("Version added as pending approval", "ok");
    } catch (error) { show(error instanceof Error ? error.message : "Could not add version", "err"); }
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
      <form key={editingId ?? "new"} onSubmit={saveSoftware} className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Name<input name="name" required className="input w-full" defaultValue={editingId ? selected?.name : ""} /></label>
        <label className="space-y-1 text-sm">Official website<input name="officialWebsite" type="url" className="input w-full" placeholder="https://example.com" defaultValue={editingId ? selected?.officialWebsite : ""} /></label>
        <label className="space-y-1 text-sm">Icon URL<input name="iconUrl" type="url" className="input w-full" placeholder="https://example.com/icon.png" defaultValue={editingId ? selected?.iconUrl : ""} /></label>
        <label className="space-y-1 text-sm">Identifier<input name="identifier" required readOnly={!!editingId} pattern="[a-z0-9][a-z0-9._-]{1,63}" className="input w-full" placeholder="nodejs" defaultValue={editingId ? selected?.identifier : ""} /></label>
        <label className="space-y-1 text-sm">Category<input name="category" className="input w-full" defaultValue={editingId ? selected?.category : "runtime"} /></label>
        <label className="space-y-1 text-sm">Service types<input name="serviceTypes" required className="input w-full" placeholder="discord,website,backend" defaultValue={editingId ? selected?.serviceTypes.join(",") : ""} /></label>
        <label className="space-y-1 text-sm">Version source<select name="sourceType" className="input w-full" defaultValue={editingId ? selected?.sourceType : "manual"}><option value="manual">Manual</option><option value="github-releases">GitHub Releases</option><option value="minecraft-manifest">Official Minecraft Vanilla versions</option><option value="nodejs-index">Official Node.js releases</option><option value="modrinth">Modrinth project</option><option value="dockerhub-tags">Docker Hub tags</option><option value="go-index">Official Go releases</option><option value="dotnet-index">Official .NET channel</option><option value="papermc">PaperMC project versions</option><option value="purpur">Purpur Minecraft versions</option><option value="fabric-meta">Fabric Minecraft versions</option><option value="quilt-meta">Quilt Minecraft versions</option><option value="java-adoptium">Eclipse Temurin Java</option><option value="forge-maven">Minecraft Forge</option><option value="neoforge-maven">Minecraft NeoForge</option><option value="python-releases">Official Python releases</option><option value="php-releases">Official PHP releases</option><option value="lavalink-releases">Official Lavalink releases</option></select></label>
        <label className="space-y-1 text-sm">GitHub / Docker Hub repository<input name="repository" className="input w-full" placeholder="owner/repository or namespace/repository" defaultValue={editingId ? selected?.sourceConfig?.repository : ""} /></label>
        <label className="space-y-1 text-sm">Modrinth project ID<input name="projectId" className="input w-full" defaultValue={editingId ? selected?.sourceConfig?.projectId : ""} /></label>
        <label className="space-y-1 text-sm">.NET channel version<input name="channelVersion" className="input w-full" placeholder="8.0 or 10.0" defaultValue={editingId ? selected?.sourceConfig?.channelVersion : ""} /></label>
        <label className="space-y-1 text-sm">PaperMC project<select name="paperProject" className="input w-full" defaultValue={editingId ? selected?.sourceConfig?.project ?? "paper" : "paper"}><option value="paper">Paper</option><option value="folia">Folia</option><option value="velocity">Velocity</option><option value="waterfall">Waterfall</option></select></label>
        {editingId || true ? <label className="space-y-1 text-sm">PHP major version (optional)<input name="phpMajorVersion" className="input w-full" placeholder="8" defaultValue={editingId ? selected?.sourceConfig?.majorVersion ?? "" : ""} /></label> : null}
        <label className="space-y-1 text-sm sm:col-span-2">Docker image template (optional)<input name="imageTemplate" className="input w-full" placeholder="itzg/minecraft-server:java21 (use VERSION={version} below)" defaultValue={editingId ? selected?.installationConfig?.imageTemplate : ""} /></label>
        <label className="space-y-1 text-sm">Installation adapter<select name="installationMethod" className="input w-full" defaultValue={editingId ? selected?.installationConfig?.method ?? "none" : "none"}><option value="none">Catalog only / not installable</option><option value="docker-image-template">Docker image template</option><option value="virtualization-image">KVM/libvirt OS image metadata</option></select></label>
        <label className="space-y-1 text-sm">KVM OS image ID<input name="osImageId" className="input w-full" placeholder="kvm/ubuntu-2404" defaultValue={editingId ? selected?.installationConfig?.imageId : ""} /></label>
        <label className="space-y-1 text-sm">Minimum VM RAM (MB)<input name="osMinRamMb" type="number" min={512} max={262144} className="input w-full" defaultValue={editingId ? selected?.installationConfig?.minRamMb ?? 1024 : 1024} /></label>
        <label className="space-y-1 text-sm">OS architecture<select name="osArchitecture" className="input w-full" defaultValue={editingId ? selected?.installationConfig?.architecture ?? "amd64" : "amd64"}><option value="amd64">amd64</option><option value="arm64">arm64</option></select></label>
        <p className="text-xs text-amber-200 sm:col-span-2">KVM/libvirt OS entries are catalog metadata only. This repository does not yet contain a virtualization Node Agent/provider, so no OS reinstall or apply action is offered.</p>
        <label className="space-y-1 text-sm sm:col-span-2">Installer environment overrides (KEY=VALUE, one per line)<textarea name="environment" className="input min-h-24 w-full font-mono" placeholder={"TYPE=PAPER\nEULA=TRUE"} defaultValue={editingId ? Object.entries(selected?.installationConfig?.environment ?? {}).map(([key, value]) => key + "=" + value).join("\n") : ""} /></label>
        <label className="space-y-1 text-sm sm:col-span-2">Description<input name="description" className="input w-full" defaultValue={editingId ? selected?.description : ""} /></label>
        <label className="space-y-1 text-sm">Supported OS<input name="supportedOperatingSystems" className="input w-full" placeholder="linux,windows" defaultValue={editingId ? selected?.supportedOperatingSystems?.join(",") : ""} /></label>
        <label className="space-y-1 text-sm">Architectures<input name="supportedArchitectures" className="input w-full" placeholder="amd64,arm64" defaultValue={editingId ? selected?.supportedArchitectures?.join(",") : ""} /></label>
        <label className="space-y-1 text-sm">Required runtime<input name="requiredRuntime" className="input w-full" placeholder="Java 21, Node.js 22" defaultValue={editingId ? selected?.requiredRuntime : ""} /></label>
        <label className="space-y-1 text-sm">Default version<input name="defaultVersion" className="input w-full" defaultValue={editingId ? selected?.defaultVersion : ""} /></label>
        <label className="space-y-1 text-sm">Enabled<select name="enabled" className="input w-full" defaultValue={editingId ? String(selected?.enabled ?? true) : "true"}><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
        <label className="space-y-1 text-sm">Customer availability<select name="customerAvailable" className="input w-full" defaultValue={editingId ? String(selected?.customerAvailable ?? true) : "true"}><option value="true">Available</option><option value="false">Admin only</option></select></label>
        <label className="space-y-1 text-sm">Automatic publishing<select name="autoPublish" className="input w-full" defaultValue={editingId ? String(selected?.autoPublish ?? false) : "false"}><option value="false">Approval required</option><option value="true">Publish stable releases automatically</option></select></label>
        <label className="space-y-1 text-sm">Automatic sync<select name="autoSync" className="input w-full" defaultValue={editingId ? String(selected?.autoSync ?? false) : "false"}><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
        <label className="space-y-1 text-sm">Sync frequency<select name="syncFrequency" className="input w-full" defaultValue={editingId ? selected?.syncFrequency : "manual"}><option value="manual">Manual only</option><option value="6h">Every 6 hours</option><option value="12h">Every 12 hours</option><option value="24h">Every 24 hours</option><option value="7d">Every 7 days</option></select></label>
        <div className="flex gap-2 sm:col-span-2"><button className="btn-primary" type="submit">{editingId ? "Save changes" : "Save software"}</button><button className="btn-ghost" type="button" onClick={() => { setFormOpen(false); setEditingId(null); }}>Cancel</button></div>
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
          <form onSubmit={addManualVersion} className="mt-4 grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-2">
            <input name="version" required className="input min-w-0" placeholder="Version number" aria-label="Version number" />
            <input name="releaseName" className="input min-w-0" placeholder="Release name" />
            <input name="releaseDate" type="date" className="input min-w-0" aria-label="Release date" />
            <select name="channel" className="input min-w-0" defaultValue="stable"><option value="stable">Stable</option><option value="lts">LTS</option><option value="prerelease">Prerelease</option><option value="nightly">Nightly</option></select>
            <input name="sourceUrl" type="url" className="input min-w-0 sm:col-span-2" placeholder="HTTPS release source URL" />
            <input name="architectures" className="input min-w-0" placeholder="Architectures: amd64,arm64" />
            <input name="compatibility" className="input min-w-0" placeholder="Compatibility: 1.21,1.21.1" />
            <input name="checksum" className="input min-w-0 sm:col-span-2" placeholder="Checksum (SHA-256 where available)" />
            <input name="signature" className="input min-w-0 sm:col-span-2" placeholder="Signature / verification reference" />
            <textarea name="runtimeRequirements" className="input min-w-0 font-mono sm:col-span-2" rows={2} placeholder='Runtime requirements JSON, e.g. {"java":"21"}' />
            <button className="btn-ghost sm:col-span-2" type="submit">Add manual version for approval</button>
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
              <div><strong className="font-mono text-sm">{version.version}</strong><p className="text-xs text-muted">{version.releaseName} · {version.prerelease ? "Prerelease" : "Stable"} · {version.publicationStatus}{version.recommended ? " · Recommended" : ""}{version.deprecated ? " · Deprecated" : ""}</p>
              <p className="text-xs text-muted">Channel: {version.channel ?? (version.prerelease ? "prerelease" : "stable")}{version.importedAt ? " · Imported " + new Date(version.importedAt).toLocaleDateString() : ""}</p>
              {version.signature ? <p className="break-all text-xs text-muted">Signature: {version.signature}</p> : null}
              {version.releaseDate ? <p className="text-xs text-muted">Released {new Date(version.releaseDate).toLocaleDateString()}</p> : null}
              {version.architectures?.length ? <p className="text-xs text-muted">Architectures: {version.architectures.join(", ")}</p> : null}
              {version.compatibility?.length ? <p className="text-xs text-muted">Compatibility: {version.compatibility.join(", ")}</p> : null}
              {version.runtimeRequirements && Object.keys(version.runtimeRequirements).length ? <p className="text-xs text-muted">Runtime: {JSON.stringify(version.runtimeRequirements)}</p> : null}
              {version.checksum ? <p className="break-all text-xs text-muted">Checksum: {version.checksum}</p> : null}
              {version.sourceUrl ? <a className="text-xs text-sky-300 underline" href={version.sourceUrl} target="_blank" rel="noreferrer">Release source</a> : null}
              {version.releaseDate ? <p className="text-xs text-muted">Released {new Date(version.releaseDate).toLocaleDateString()}</p> : null}
              {version.architectures?.length ? <p className="text-xs text-muted">Architectures: {version.architectures.join(", ")}</p> : null}
              {version.compatibility?.length ? <p className="text-xs text-muted">Compatibility: {version.compatibility.join(", ")}</p> : null}
              {version.runtimeRequirements && Object.keys(version.runtimeRequirements).length ? <p className="text-xs text-muted">Runtime: {JSON.stringify(version.runtimeRequirements)}</p> : null}
              {version.checksum ? <p className="break-all text-xs text-muted">Checksum: {version.checksum}</p> : null}
              {version.sourceUrl ? <a className="text-xs text-sky-300 underline" href={version.sourceUrl} target="_blank" rel="noreferrer">Release source</a> : null}</div>
              <div className="flex gap-2">{version.publicationStatus !== "published" ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "published")}>Publish</button> : <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void setVersionStatus(version, "disabled")}>Disable</button>}<button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void deleteVersion(version)}>Delete</button></div>
            </div>)}
            {!versions.length && <p className="text-sm text-muted">No versions imported yet. Fetch releases or add them manually through the API.</p>}
          </div>
        </> : <p className="py-12 text-center text-sm text-muted">Select software to view versions.</p>}
      </GlassCard>
    </div>
        <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Automatic synchronization queue</h2><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void load()}>Refresh</button></div>
      <div className="mt-3 space-y-2">
        {syncJobs.map(job => <div key={job._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-3 text-sm">
          <div><strong>{typeof job.softwareId === "object" ? job.softwareId?.name ?? "Software" : job.softwareId}</strong><p className="text-xs text-muted">Attempt {job.attempts}/{job.maxAttempts} · next run {new Date(job.runAt).toLocaleString()}</p>{job.lastError ? <p className="text-xs text-rose-300">{job.lastError}</p> : null}</div>
          <div className="flex items-center gap-2"><span className="text-xs text-muted">{job.status} · discovered {job.discovered ?? 0}, imported {job.imported ?? 0}</span>{["failed", "retry"].includes(job.status) ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void retrySyncJob(job)}>Retry</button> : null}</div>
        </div>)}
        {!syncJobs.length && <p className="text-sm text-muted">No synchronization jobs have been queued.</p>}
      </div>
    </GlassCard>
    <GlassCard className="p-5">
      <h2 className="font-semibold">Recent software operations</h2>
      <div className="mt-3 space-y-2">
        {recentOperations.map(operation => <div key={operation._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 p-3 text-sm">
          <div><strong>{operation.requestedSoftware} · {operation.requestedVersion}</strong><p className="text-xs text-muted">{typeof operation.serviceId === "object" ? operation.serviceId?.name ?? "Service" : operation.serviceId} · {new Date(operation.createdAt).toLocaleString()}</p><p className="text-xs text-muted">Requested by: {typeof operation.requestedBy === "object" ? operation.requestedBy?.username ?? "Staff" : operation.requestedBy ?? "—"} · Started: {operation.startedAt ? new Date(operation.startedAt).toLocaleString() : "—"} · Completed: {operation.completedAt ? new Date(operation.completedAt).toLocaleString() : "—"}</p><p className="text-xs text-muted">Previous: {operation.previousSoftware || "—"} {operation.previousVersion || ""} → {operation.requestedSoftware} {operation.requestedVersion}</p>{operation.verification ? <p className="text-xs text-muted">Verified: {operation.verification.running ? "running" : "not confirmed"} · Image: {operation.verification.installedImage ?? "—"} · Health: {operation.verification.healthStatus ?? "—"}</p> : null}</div>
          <span className="text-xs text-muted">{operation.status} · {operation.progress}%</span>
          {operation.error ? <p className="w-full text-xs text-rose-300">{operation.error}</p> : null}{operation.warning ? <p className="w-full text-xs text-amber-300">{operation.warning}</p> : null}{operation.warning && operation.verification?.previousContainerName && !operation.verification.previousContainerRemoved ? <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void retryCleanup(operation)}>Retry old-container cleanup</button> : null}
        </div>)}
        {!recentOperations.length && <p className="text-sm text-muted">No software operations yet.</p>}
      </div>
    </GlassCard>
    {node}
  </div>;
}
