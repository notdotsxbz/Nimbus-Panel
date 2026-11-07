"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { applySnapshot } from "@/lib/theme";
import { GlassCard, Modal, Toast, useToast } from "@/components/glass";
import {
  THEME_TOKENS,
  ANIMATION_PRESETS,
  type ThemeColors,
} from "@nimbus/shared";

interface ThemeRow {
  key: string;
  name: string;
  description?: string;
  colors: ThemeColors;
  mode: "light" | "dark";
  isBuiltIn: boolean;
  isPublished: boolean;
}

interface Settings {
  allowCustomerThemes: boolean;
  allowCustomerAnimations: boolean;
  allowCustomThemes: boolean;
  defaultThemeKey: string;
  defaultAnimationPreset: string;
  animationsEnabled: boolean;
  animationSpeed: number;
  animationIntensity: number;
}

interface Stats {
  publishedThemes: number;
  totalThemes: number;
  customerPreferences: number;
}

type Tab = "overview" | "themes" | "animations" | "customers" | "advanced";
const TABS: Tab[] = ["overview", "themes", "animations", "customers", "advanced"];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  themes: "Theme Studio",
  animations: "Animation Studio",
  customers: "Customer Appearance",
  advanced: "Advanced",
};

const TOKEN_LABELS: Record<string, string> = {
  bg: "Background", surface: "Surface / card", surfaceRaised: "Elevated surface",
  border: "Border", text: "Text", textMuted: "Muted text", primary: "Primary",
  primaryText: "Primary button text", secondary: "Secondary", sidebarBg: "Sidebar",
  sidebarText: "Sidebar text", navbarBg: "Navbar", inputBg: "Input",
  inputBorder: "Input border", modalBg: "Modal", statusOnline: "Status: online",
  statusPending: "Status: pending", statusError: "Status: error",
  chart1: "Chart 1", chart2: "Chart 2", chart3: "Chart 3",
};

export default function AppearanceStudio() {
  const [tab, setTab] = useState<Tab>("overview");
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [editing, setEditing] = useState<{ key?: string; name: string; description: string; mode: string; colors: Partial<ThemeColors> } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { show, node } = useToast();

  const reload = useCallback(async () => {
    try {
      const [t, s, st] = await Promise.all([
        api.get<{ items?: ThemeRow[] } | ThemeRow[]>("/appearance/themes"),
        api.get<Settings>("/appearance/settings"),
        api.get<Stats>("/appearance/stats"),
      ]);
      setThemes(Array.isArray(t) ? t : t.items ?? []);
      setSettings(s);
      setStats(st);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load appearance data", "err");
    }
  }, [show]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const defaultTheme = useMemo(
    () => themes.find((t) => t.key === settings?.defaultThemeKey),
    [themes, settings],
  );

  // ── theme mutations ──────────────────────────────────────────────
  const saveTheme = async () => {
    if (!editing) return;
    try {
      const payload = {
        name: editing.name,
        description: editing.description || undefined,
        mode: editing.mode,
        colors: Object.fromEntries(Object.entries(editing.colors).filter(([, v]) => !!v)),
      };
      if (editing.key) await api.patch(`/appearance/themes/${editing.key}`, payload);
      else await api.post("/appearance/themes", payload);
      setEditing(null);
      show("Theme saved", "ok");
      void reload();
    } catch (err) {
      show(err instanceof Error ? err.message : "Save failed", "err");
    }
  };

  const themeAction = async (key: string, action: string, body?: unknown) => {
    try {
      await api.post(`/appearance/themes/${key}/${action}`, body);
      void reload();
    } catch (err) {
      show(err instanceof Error ? err.message : "Action failed", "err");
    }
  };

  const deleteTheme = async (key: string) => {
    try {
      await api.del(`/appearance/themes/${key}`);
      show("Theme deleted", "ok");
      void reload();
    } catch (err) {
      show(err instanceof Error ? err.message : "Delete failed", "err");
    }
  };

  const patchSettings = async (patch: Partial<Settings>) => {
    try {
      const updated = await api.patch<Settings>("/appearance/settings", patch);
      setSettings(updated);
      show("Settings updated", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const previewTheme = (colors: ThemeColors) => {
    // Live preview: apply to the real document (restored on close/save via reload+sync)
    applySnapshot({ themeKey: "preview", colors, animation: { enabled: true, speed: 1, intensity: 0.8, effects: {} } });
  };

  if (!settings) {
    return <GlassCard className="p-10 text-center text-sm text-muted">Loading appearance settings…</GlassCard>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Theme & Animation Studio</h1>
        <p className="mt-1 text-sm text-muted">
          Control how the panel looks for every customer — themes, motion and defaults.
        </p>
      </header>

      <div role="tablist" aria-label="Appearance sections" className="glass-soft flex overflow-x-auto rounded-xl p-1">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors ${
              tab === t ? "bg-white/10 font-medium" : "text-muted hover:text-current"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <GlassCard className="animate-rise p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Active default theme</p>
            <p className="mt-2 text-lg font-semibold">{defaultTheme?.name ?? settings.defaultThemeKey}</p>
            <p className="mt-1 text-xs text-muted">{defaultTheme?.mode ?? "?"} mode · {defaultTheme?.isBuiltIn ? "built-in" : "custom"}</p>
          </GlassCard>
          <GlassCard className="animate-rise p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Published themes</p>
            <p className="tnum mt-2 text-2xl font-semibold">{stats?.publishedThemes ?? "—"}</p>
            <p className="mt-1 text-xs text-muted">of {stats?.totalThemes ?? "—"} total</p>
          </GlassCard>
          <GlassCard className="animate-rise p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Customer preferences</p>
            <p className="tnum mt-2 text-2xl font-semibold">{stats?.customerPreferences ?? "—"}</p>
            <p className="mt-1 text-xs text-muted">users chose their own theme</p>
          </GlassCard>
          <GlassCard className="animate-rise p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Animations</p>
            <p className="mt-2 text-lg font-semibold">{settings.animationsEnabled ? "Enabled" : "Disabled"}</p>
            <p className="mt-1 text-xs text-muted">preset: {settings.defaultAnimationPreset}</p>
          </GlassCard>
        </div>
      )}

      {tab === "themes" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setEditing({ name: "", description: "", mode: "dark", colors: { bg: "#000000", surface: "#141414", text: "#ffffff", border: "#262626" } })}>
              Create theme
            </button>
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>Import</button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {themes.map((t) => (
              <GlassCard key={t.key} className="animate-rise p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {t.mode} · {t.isBuiltIn ? "built-in" : "custom"} {t.isPublished ? "· published" : "· draft"}
                      {t.key === settings.defaultThemeKey ? " · DEFAULT" : ""}
                    </p>
                  </div>
                  <div className="flex gap-1" aria-hidden>
                    {(["bg", "primary", "text", "surface"] as const).map((k) => (
                      <span key={k} className="h-5 w-5 rounded-md border border-white/10" style={{ background: t.colors[k] }} />
                    ))}
                  </div>
                </div>
                {t.description ? <p className="mt-2 text-xs text-muted">{t.description}</p> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setEditing({ key: t.key, name: t.name, description: t.description ?? "", mode: t.mode, colors: { ...t.colors } })}>
                    {t.isBuiltIn ? "View" : "Edit"}
                  </button>
                  {!t.isBuiltIn ? (
                    <>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void themeAction(t.key, "duplicate")}>Duplicate</button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void themeAction(t.key, "publish", { published: !t.isPublished })}>
                        {t.isPublished ? "Unpublish" : "Publish"}
                      </button>
                      <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void themeAction(t.key, "default")}>Set default</button>
                      <button className="btn-danger !px-2.5 !py-1 text-xs" onClick={() => { if (confirm(`Delete theme "${t.name}"?`)) void deleteTheme(t.key); }}>Delete</button>
                    </>
                  ) : null}
                  {t.isPublished && t.key !== settings.defaultThemeKey ? (
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void themeAction(t.key, "default")}>Set default</button>
                  ) : null}
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      )}

      {tab === "animations" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <GlassCard className="p-6">
            <h2 className="font-semibold">Global animation</h2>
            <label className="mt-4 flex items-center justify-between gap-4 text-sm">
              <span>Enable animations</span>
              <input
                type="checkbox"
                checked={settings.animationsEnabled}
                onChange={(e) => void patchSettings({ animationsEnabled: e.target.checked })}
                className="h-5 w-5 accent-white"
              />
            </label>
            <label className="label mt-5" htmlFor="anim-speed">Speed ({settings.animationSpeed.toFixed(2)}×)</label>
            <input
              id="anim-speed" type="range" min={0.5} max={1.5} step={0.05}
              value={settings.animationSpeed}
              onChange={(e) => setSettings({ ...settings, animationSpeed: Number(e.target.value) })}
              onMouseUp={(e) => void patchSettings({ animationSpeed: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={(e) => void patchSettings({ animationSpeed: Number((e.target as HTMLInputElement).value) })}
              className="w-full"
            />
            <label className="label mt-4" htmlFor="anim-intensity">Intensity ({settings.animationIntensity.toFixed(2)})</label>
            <input
              id="anim-intensity" type="range" min={0} max={1.2} step={0.05}
              value={settings.animationIntensity}
              onChange={(e) => setSettings({ ...settings, animationIntensity: Number(e.target.value) })}
              onMouseUp={(e) => void patchSettings({ animationIntensity: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={(e) => void patchSettings({ animationIntensity: Number((e.target as HTMLInputElement).value) })}
              className="w-full"
            />
          </GlassCard>

          <GlassCard className="p-6">
            <h2 className="font-semibold">Presets</h2>
            <div className="mt-4 space-y-2">
              {ANIMATION_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void patchSettings({ defaultAnimationPreset: p.id })}
                  className={`w-full rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                    settings.defaultAnimationPreset === p.id ? "bg-white/10 font-medium" : "glass-soft hover:bg-white/5"
                  }`}
                >
                  <p>{p.name} {settings.defaultAnimationPreset === p.id ? "· active" : ""}</p>
                  <p className="mt-0.5 text-xs text-muted">{p.description}</p>
                </button>
              ))}
            </div>
          </GlassCard>

          <GlassCard className="p-6 lg:col-span-2">
            <h2 className="font-semibold">Live preview</h2>
            <p className="mt-1 text-xs text-muted">Current document applies your settings instantly — toggle and watch the cards below.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="glass animate-rise p-4 text-sm">Rising card</div>
              <div className="glass p-4 text-sm transition-transform hover:-translate-y-1">Hover card</div>
              <div className="glass p-4 text-sm"><span className="status-dot status-starting mr-2" aria-hidden />Pulsing status</div>
            </div>
          </GlassCard>
        </div>
      )}

      {tab === "customers" && (
        <GlassCard className="max-w-2xl p-6">
          <h2 className="font-semibold">Customer appearance permissions</h2>
          <p className="mt-1 text-sm text-muted">When disabled, customers use the published default theme and preset.</p>
          <label className="mt-5 flex items-center justify-between gap-4 text-sm">
            <span>Allow customers to choose themes</span>
            <input type="checkbox" checked={settings.allowCustomerThemes} onChange={(e) => void patchSettings({ allowCustomerThemes: e.target.checked })} className="h-5 w-5 accent-white" />
          </label>
          <label className="mt-4 flex items-center justify-between gap-4 text-sm">
            <span>Allow customers to customize animations</span>
            <input type="checkbox" checked={settings.allowCustomerAnimations} onChange={(e) => void patchSettings({ allowCustomerAnimations: e.target.checked })} className="h-5 w-5 accent-white" />
          </label>
          <label className="mt-4 flex items-center justify-between gap-4 text-sm">
            <span>Allow customer-created custom themes</span>
            <input type="checkbox" checked={settings.allowCustomThemes} onChange={(e) => void patchSettings({ allowCustomThemes: e.target.checked })} className="h-5 w-5 accent-white" />
          </label>
        </GlassCard>
      )}

      {tab === "advanced" && (
        <div className="grid gap-4 md:grid-cols-2">
          <GlassCard className="p-6">
            <h2 className="font-semibold">Export / Import</h2>
            <p className="mt-1 text-sm text-muted">Theme configurations are sanitized JSON (hex colors only, bounded size).</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="btn-ghost"
                onClick={() => {
                  if (!defaultTheme) return show("No default theme to export", "err");
                  const blob = new Blob([JSON.stringify({ name: defaultTheme.name, description: defaultTheme.description, mode: defaultTheme.mode, colors: defaultTheme.colors }, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = `${defaultTheme.key}.json`; a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export default theme
              </button>
              <button className="btn-ghost" onClick={() => setImportOpen(true)}>Import theme</button>
            </div>
          </GlassCard>
          <GlassCard className="p-6">
            <h2 className="font-semibold">Restore</h2>
            <p className="mt-1 text-sm text-muted">Reset the published default back to the original NIMBUS theme.</p>
            <button
              className="btn-danger mt-4"
              onClick={() => {
                if (!confirm("Restore the default NIMBUS theme for all customers?")) return;
                void themeAction("nimbus-dark", "default");
              }}
            >
              Restore Nimbus Dark default
            </button>
          </GlassCard>
        </div>
      )}

      {/* Theme editor modal */}
      <Modal open={editing !== null} title={editing?.key ? (themes.find((t) => t.key === editing.key)?.isBuiltIn ? `View: ${editing.name}` : "Edit theme") : "Create theme"} onClose={() => { setEditing(null); void reload(); }}>
        {editing ? (
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="t-name">Name</label>
              <input id="t-name" className="input" value={editing.name} disabled={!!editing.key && themes.find((t) => t.key === editing.key)?.isBuiltIn} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="t-desc">Description</label>
              <input id="t-desc" className="input" value={editing.description} disabled={!!editing.key && themes.find((t) => t.key === editing.key)?.isBuiltIn} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="t-mode">Mode</label>
              <select id="t-mode" className="input" value={editing.mode} disabled={!!editing.key && themes.find((t) => t.key === editing.key)?.isBuiltIn} onChange={(e) => setEditing({ ...editing, mode: e.target.value })}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
            <div>
              <p className="label">Colors (hex)</p>
              <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
                {THEME_TOKENS.map((token) => {
                  const value = editing.colors[token] ?? "";
                  return (
                    <div key={token} className="glass-soft flex items-center gap-2 px-2.5 py-1.5">
                      <input
                        type="color"
                        aria-label={`${TOKEN_LABELS[token]} color picker`}
                        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
                        disabled={!!editing.key && themes.find((t) => t.key === editing.key)?.isBuiltIn}
                        onChange={(e) => {
                          const colors = { ...editing.colors, [token]: e.target.value };
                          setEditing({ ...editing, colors });
                          previewTheme(colors as ThemeColors);
                        }}
                        className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                      />
                      <span className="flex-1 truncate text-[11px] text-muted">{TOKEN_LABELS[token]}</span>
                      <input
                        className="w-20 rounded bg-transparent px-1 py-0.5 text-right font-mono text-[11px]"
                        value={value}
                        disabled={!!editing.key && themes.find((t) => t.key === editing.key)?.isBuiltIn}
                        onChange={(e) => {
                          const v = e.target.value;
                          const colors = { ...editing.colors, [token]: v };
                          setEditing({ ...editing, colors });
                          if (/^#[0-9a-fA-F]{6}$/.test(v)) previewTheme(colors as ThemeColors);
                        }}
                        aria-label={`${TOKEN_LABELS[token]} hex value`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-2">
              {!editing.key || !themes.find((t) => t.key === editing.key)?.isBuiltIn ? (
                <button className="btn-primary flex-1" onClick={() => void saveTheme()}>Save theme</button>
              ) : null}
              <button className="btn-ghost flex-1" onClick={() => { setEditing(null); void reload(); }}>Close</button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Import modal */}
      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { setImportOpen(false); void reload(); }}
        show={show}
      />

      {node}
    </div>
  );
}

function ImportModal({ open, onClose, onImported, show }: { open: boolean; onClose: () => void; onImported: () => void; show: (m: string, t?: "info" | "ok" | "err") => void }) {
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title="Import theme configuration" onClose={onClose}>
      <p className="text-sm text-muted">Paste an exported theme JSON. Invalid colors, unknown tokens and oversized payloads are rejected server-side.</p>
      <textarea
        className="input mt-3 h-40 font-mono text-xs"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        aria-label="Theme JSON"
        placeholder='{ "name": "My theme", "colors": { ... } }'
      />
      <button
        className="btn-primary mt-3 w-full"
        disabled={busy || !payload.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await api.post("/appearance/themes/import", { payload: JSON.parse(payload) });
            show("Theme imported", "ok");
            onImported();
          } catch (err) {
            show(err instanceof Error ? err.message : "Import failed", "err");
          }
          setBusy(false);
        }}
      >
        {busy ? "Importing…" : "Import theme"}
      </button>
    </Modal>
  );
}
