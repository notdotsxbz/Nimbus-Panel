"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";
import { syncAppearance } from "@/lib/theme";
import { ANIMATION_PRESETS } from "@nimbus/shared";

interface ThemeRow {
  key: string;
  name: string;
  mode: string;
  isBuiltIn: boolean;
}

interface PublicSettings {
  allowCustomerThemes: boolean;
  allowCustomerAnimations: boolean;
  defaultThemeKey: string;
  defaultAnimationPreset: string;
}

interface MeAppearance {
  themeKey: string;
  colorMode: "light" | "dark" | "system";
  animationsEnabled: boolean;
  reducedMotion: boolean;
  animationPreset: string;
}

export default function AccountSettings() {
  const router = useRouter();
  const [user, setUser] = useState<{ username: string; email: string; role: string; mustChangePassword?: boolean } | null>(null);
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [pub, setPub] = useState<PublicSettings | null>(null);
  const [prefs, setPrefs] = useState<MeAppearance | null>(null);
  const { show, node } = useToast();
  // Visible Back navigation — Settings must never be a dead end.
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/dashboard");
  };

  useEffect(() => {
    void (async () => {
      try {
        setUser(await api.get<typeof user>("/auth/me"));
      } catch {
        router.replace("/login");
        return;
      }
      try {
        const [t, s, me] = await Promise.all([
          api.get<{ items?: ThemeRow[] } | ThemeRow[]>("/appearance/themes"),
          api.get<PublicSettings>("/appearance/public-settings"),
          api.get<MeAppearance>("/appearance/me"),
        ]);
        setThemes(Array.isArray(t) ? t : t.items ?? []);
        setPub(s);
        setPrefs(me);
      } catch {
        /* appearance is optional — leave defaults */
      }
    })();
  }, [router]);

  const savePrefs = async (patch: Partial<MeAppearance>) => {
    try {
      setPrefs(await api.put<MeAppearance>("/appearance/me", patch));
      await syncAppearance(true); // apply immediately across the whole app
      show("Appearance updated", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Update failed", "err");
    }
  };

  const resetPrefs = async () => {
    if (!confirm("Reset your appearance preferences to the panel defaults?")) return;
    await api.post("/appearance/me/reset");
    await syncAppearance(true);
    const me = await api.get<MeAppearance>("/appearance/me");
    setPrefs(me);
    show("Appearance reset to defaults", "ok");
  };

  const changePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/users/me/password", { current: f.get("current"), next: f.get("next") });
      show("Password updated", "ok");
      e.currentTarget.reset();
    } catch (err) {
      show(err instanceof Error ? err.message : "Change failed", "err");
    }
  };

  const changeUsername = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.patch("/users/me/username", { username: f.get("username") });
      show("Username updated — sign in again to refresh", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Change failed", "err");
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {user?.mustChangePassword ? (
        <GlassCard className="border-amber-400/30 p-5" role="alert">
          <p className="text-sm text-amber-300">
            You are using initial credentials. Change your password below — this is required.
          </p>
        </GlassCard>
      ) : null}

      <header className="flex items-center gap-3">
        <button className="btn-ghost !px-3" onClick={goBack} aria-label="Go back">← Back</button>
        <h1 className="text-2xl font-semibold">Account Settings</h1>
        <p className="mt-1 text-sm text-muted">
          {user ? `${user.email} · ${user.role}` : "Loading…"}
        </p>
      </header>

      <GlassCard className="p-6">
        <h2 className="mb-4 font-semibold">Change password</h2>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="label" htmlFor="p-current">Current password</label>
            <input id="p-current" name="current" type="password" required className="input" autoComplete="current-password" />
          </div>
          <div>
            <label className="label" htmlFor="p-next">New password (min 8 chars)</label>
            <input id="p-next" name="next" type="password" required minLength={8} className="input" autoComplete="new-password" />
          </div>
          <button className="btn-primary">Update password</button>
        </form>
      </GlassCard>

      <GlassCard className="p-6">
        <h2 className="mb-4 font-semibold">Change username</h2>
        <form onSubmit={changeUsername} className="space-y-4">
          <div>
            <label className="label" htmlFor="u-new">New username</label>
            <input
              id="u-new"
              name="username"
              required
              className="input"
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
              defaultValue={user?.username}
            />
          </div>
          <button className="btn-ghost">Update username</button>
        </form>
      </GlassCard>

      <GlassCard className="p-6">
        <h2 className="mb-2 font-semibold">Appearance</h2>
        {pub && prefs ? (
          <div className="space-y-4 text-sm">
            <div>
              <label className="label" htmlFor="ap-theme">Theme</label>
              {pub.allowCustomerThemes ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {themes.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => void savePrefs({ themeKey: t.key })}
                      className={`flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors ${
                        prefs.themeKey === t.key || (prefs.themeKey === undefined && t.key === pub.defaultThemeKey)
                          ? "bg-white/10 font-medium"
                          : "glass-soft hover:bg-white/5"
                      }`}
                    >
                      <span>{t.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted">{t.mode}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="glass-soft px-3.5 py-2.5 text-muted">Theme selection is managed by your administrator.</p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="ap-mode">Color mode</label>
              <select
                id="ap-mode"
                className="input"
                value={prefs.colorMode}
                onChange={(e) => void savePrefs({ colorMode: e.target.value as MeAppearance["colorMode"] })}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span>Animations</span>
              <input
                type="checkbox" className="h-5 w-5 accent-white" aria-label="Animations enabled"
                checked={prefs.animationsEnabled}
                onChange={(e) => void savePrefs({ animationsEnabled: e.target.checked })}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <span>Reduced motion</span>
              <input
                type="checkbox" className="h-5 w-5 accent-white" aria-label="Reduced motion"
                checked={prefs.reducedMotion}
                onChange={(e) => void savePrefs({ reducedMotion: e.target.checked })}
              />
            </div>

            {pub.allowCustomerAnimations ? (
              <div>
                <label className="label" htmlFor="ap-preset">Animation preset</label>
                <select
                  id="ap-preset"
                  className="input"
                  value={prefs.animationPreset ?? pub.defaultAnimationPreset}
                  onChange={(e) => void savePrefs({ animationPreset: e.target.value })}
                >
                  {ANIMATION_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="glass-soft px-3.5 py-2.5 text-muted">Animation preferences are managed by your administrator.</p>
            )}

            <button className="btn-ghost" onClick={() => void resetPrefs()}>Reset to default</button>
          </div>
        ) : (
          <p className="text-sm text-muted">Loading appearance preferences…</p>
        )}
      </GlassCard>

      <GlassCard className="p-6">
        <h2 className="mb-2 font-semibold">Install as app (PWA)</h2>
        <p className="text-sm text-muted">
          Android: open the browser menu → “Install app”. iPhone: Share → “Add to Home Screen”.
          Desktop: use the install icon in the address bar. NIMBUS runs standalone and keeps
          essential controls available; no private data is cached offline.
        </p>
      </GlassCard>

      {node}
    </div>
  );
}
