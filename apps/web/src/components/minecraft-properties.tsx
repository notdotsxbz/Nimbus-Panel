"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, useToast } from "@/components/glass";

type Values = Record<string, string>;

const FIELDS: { key: string; label: string; kind?: "number" | "select"; options?: string[]; help?: string }[] = [
  { key: "motd", label: "Server message", help: "Shown in the multiplayer server list." },
  { key: "max-players", label: "Maximum players", kind: "number" },
  { key: "difficulty", label: "Difficulty", kind: "select", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Default game mode", kind: "select", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "view-distance", label: "View distance", kind: "number", help: "Maximum chunk view distance." },
  { key: "simulation-distance", label: "Simulation distance", kind: "number" },
  { key: "spawn-protection", label: "Spawn protection radius", kind: "number" },
];

const TOGGLES = [
  ["online-mode", "Online mode", "Verify players with Minecraft account services."],
  ["pvp", "Player versus player", "Allow players to damage one another."],
  ["white-list", "Whitelist", "Only allow players on the whitelist to join."],
  ["allow-flight", "Allow flight", "Do not kick players for flying."],
  ["enable-command-block", "Command blocks", "Allow command blocks to run."],
] as const;

function parseProperties(content: string): Values {
  const values: Values = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function updateProperties(original: string, values: Values): string {
  const pending = new Map(Object.entries(values));
  const lines = original.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return line;
    const index = line.indexOf("=");
    if (index < 1) return line;
    const key = line.slice(0, index).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return key + "=" + value.replace(/[\r\n]/g, " ");
  });
  for (const [key, value] of pending) lines.push(key + "=" + value.replace(/[\r\n]/g, " "));
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function MinecraftProperties({ serviceId }: { serviceId: string }) {
  const [original, setOriginal] = useState("");
  const [values, setValues] = useState<Values>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ content: string }>(`/services/${serviceId}/files/content?path=${encodeURIComponent("/server.properties")}`);
      setOriginal(result.content);
      setValues(parseProperties(result.content));
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not load server.properties", "err");
    } finally {
      setLoading(false);
    }
  }, [serviceId, show]);

  useEffect(() => { void load(); }, [load]);

  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const content = updateProperties(original, values);
      await api.post(`/services/${serviceId}/files/write`, { path: "/server.properties", content });
      setOriginal(content);
      setValues(parseProperties(content));
      show("Minecraft properties saved. Some settings require a server restart.", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not save server.properties", "err");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <GlassCard className="p-6 text-sm text-muted">Loading server.properties…</GlassCard>;

  return (
    <GlassCard className="p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Minecraft server properties</h2>
          <p className="mt-1 text-xs text-muted">Edit common server settings without manually editing the file. Unlisted properties and comments are preserved.</p>
        </div>
        <button type="button" className="btn-ghost !px-3 text-xs" onClick={() => void load()}>Reload file</button>
      </div>
      {!original && <p className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">The server.properties file is empty. Save will create it in the service directory.</p>}
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.key} className="block space-y-1.5">
              <span className="text-sm font-medium">{field.label}</span>
              {field.kind === "select" ? (
                <select className="input w-full" value={values[field.key] ?? field.options?.[0] ?? ""} onChange={(e) => set(field.key, e.target.value)}>
                  {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input className="input w-full" type={field.kind === "number" ? "number" : "text"} value={values[field.key] ?? ""} onChange={(e) => set(field.key, e.target.value)} />
              )}
              {field.help ? <span className="block text-[11px] text-muted">{field.help}</span> : null}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TOGGLES.map(([key, label, help]) => (
            <label key={key} className="flex items-start gap-3 rounded-lg border border-white/10 p-3">
              <input type="checkbox" className="mt-1" checked={(values[key] ?? "true") === "true"} onChange={(e) => set(key, String(e.target.checked))} />
              <span><span className="block text-sm font-medium">{label}</span><span className="mt-0.5 block text-[11px] text-muted">{help}</span></span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <p className="max-w-xl text-[11px] text-muted">Changes are written to the service's server.properties file. Stop the server before changing settings that require a restart, then start it again.</p>
          <button className="btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save properties"}</button>
        </div>
      </form>
      {node}
    </GlassCard>
  );
}
