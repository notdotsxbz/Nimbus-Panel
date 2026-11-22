"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

type VersionOption = { _id: string; version: string; releaseName?: string; releaseDate?: string; recommended?: boolean; prerelease?: boolean; publicationStatus: string; compatibility?: string[]; sourceUrl?: string };
type SoftwareOption = { software: { id: string; name: string; identifier: string; description: string; category: string; logoUrl?: string; officialUrl?: string; requiredRuntime?: string; defaultVersion?: string; supportedOperatingSystems?: string[]; supportedArchitectures?: string[]; installable: boolean }; versions: VersionOption[] };
type OptionsResponse = { serviceType: string; currentSoftware: string | null; currentVersion: string | null; options: SoftwareOption[] };
type Operation = { _id: string; requestedSoftware: string; requestedVersion: string; previousSoftware: string; previousVersion: string; status: string; progress: number; error?: string; warning?: string; createdAt: string; completedAt?: string };

export function SoftwareManager({ serviceId, serviceType }: { serviceId: string; serviceType: string }) {
  const [data, setData] = useState<OptionsResponse | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [softwareId, setSoftwareId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [options, history] = await Promise.all([
        api.get<OptionsResponse>("/software/for-service/" + serviceId),
        api.get<Operation[]>("/software/services/" + serviceId + "/operations"),
      ]);
      setData(options);
      setOperations(history);
      const first = options.options.find(item => item.software.installable && item.versions.length);
      setSoftwareId(current => current || first?.software.id || "");
      setVersionId(current => current || first?.versions[0]?._id || "");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not load software options", "err");
    } finally { setLoading(false); }
  }, [serviceId, show]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => data?.options.find(item => item.software.id === softwareId), [data, softwareId]);

  const change = async () => {
    if (!softwareId || !versionId) return;
    setBusy(true);
    try {
      const operation = await api.post<Operation>("/software/services/" + serviceId + "/change", { softwareId, versionId });
      show("Upgrade completed and the new container was verified as running.", "ok");
      await load();
      setOperations(current => [operation, ...current.filter(item => item._id !== operation._id)]);
    } catch (error) {
      show(error instanceof Error ? error.message : "Software upgrade failed", "err");
      await load();
    } finally { setBusy(false); }
  };

  if (loading) return <GlassCard className="p-6 text-sm text-muted">Loading software catalog…</GlassCard>;

  return <div className="space-y-4">
    <GlassCard className="p-6">
      <h2 className="font-semibold">Software &amp; version</h2>
      <p className="mt-1 text-xs text-muted">Current software: <strong>{data?.currentSoftware || "Not recorded"}</strong> · Version: <strong>{data?.currentVersion || "Not recorded"}</strong></p>
      {["vps", "vds"].includes(serviceType.toLowerCase()) ? (
        <p className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-100">VPS and VDS operating-system changes are restricted to authorized administrators. Customer OS controls are not available here.</p>
      ) : (
        <>
          <p className="mt-4 text-xs text-muted">Only published versions with a configured, supported installation adapter can be installed. A local pre-update backup is created before the service container is replaced.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">Software
              <select className="input w-full" value={softwareId} onChange={event => { setSoftwareId(event.target.value); setVersionId(""); }}>
                <option value="">Choose software…</option>
                {(data?.options ?? []).map(item => <option key={item.software.id} value={item.software.id} disabled={!item.software.installable || item.versions.length === 0}>{item.software.name}{!item.software.installable ? " (not installable yet)" : ""}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">Published version
              <select className="input w-full" value={versionId} onChange={event => setVersionId(event.target.value)} disabled={!selected}>
                <option value="">Choose version…</option>
                {(selected?.versions ?? []).map(version => <option key={version._id} value={version._id}>{version.version}{version.recommended ? " · Recommended" : ""}{version.prerelease ? " · Prerelease" : ""}</option>)}
              </select>
            </label>
          </div>
          {selected ? <div className="mt-3 rounded-lg border border-white/10 p-3 text-xs text-muted">
            <p>{selected.software.requiredRuntime ? "Required runtime: " + selected.software.requiredRuntime : "Runtime requirements not specified"}</p>
            {selected.software.supportedOperatingSystems?.length ? <p className="mt-1">Operating systems: {selected.software.supportedOperatingSystems.join(", ")}</p> : null}
            {selected.software.supportedArchitectures?.length ? <p className="mt-1">Architectures: {selected.software.supportedArchitectures.join(", ")}</p> : null}
            {selected.software.officialUrl ? <a className="mt-1 inline-block text-cyan-300 hover:underline" href={selected.software.officialUrl} target="_blank" rel="noreferrer">Official software website</a> : null}
            {selected.versions.find(version => version._id === versionId)?.compatibility?.length ? <p className="mt-1">Selected release compatibility: {selected.versions.find(version => version._id === versionId)?.compatibility?.join(", ")}</p> : null}
            {selected.versions.find(version => version._id === versionId)?.releaseDate ? <p className="mt-1">Release date: {new Date(selected.versions.find(version => version._id === versionId)!.releaseDate!).toLocaleDateString()}</p> : null}
          </div> : null}
          <button className="btn-primary mt-4" disabled={busy || !selected?.software.installable || !versionId} onClick={() => void change()}>{busy ? "Backing up and upgrading…" : "Back up & change version"}</button>
          {!data?.options.some(item => item.software.installable && item.versions.length) && <p className="mt-3 text-xs text-muted">No installable software versions have been published for this service type yet.</p>}
        </>
      )}
    </GlassCard>
    <GlassCard className="p-6">
      <h3 className="font-semibold">Software operation history</h3>
      <div className="mt-3 space-y-2">
        {operations.map(operation => <div key={operation._id} className="rounded-lg border border-white/10 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>{operation.requestedSoftware} · {operation.requestedVersion}</strong><span className="text-xs text-muted">{operation.status} · {operation.progress}%</span></div>
          <p className="mt-1 text-xs text-muted">{operation.previousSoftware || "—"} {operation.previousVersion ? "· " + operation.previousVersion : ""} → {operation.requestedSoftware} · {new Date(operation.createdAt).toLocaleString()}</p>
          {operation.error ? <p className="mt-2 text-xs text-rose-300">{operation.error}</p> : null}{operation.warning ? <p className="mt-2 text-xs text-amber-300">{operation.warning}</p> : null}
        </div>)}
        {!operations.length && <p className="text-sm text-muted">No software changes recorded yet.</p>}
      </div>
    </GlassCard>
    {node}
  </div>;
}
