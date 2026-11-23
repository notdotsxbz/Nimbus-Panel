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

interface DriveStats {
  totalBackups: number;
  lastSuccessfulBackup: string | null;
  totalSizeBytes: number;
}

interface DriveStatus {
  connected: boolean;
  connectedAt: string | null;
  accountEmail?: string | null;
  folderId?: string | null;
  reconnectRequired?: boolean;
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
  const [drive, setDrive] = useState<DriveStatus>({ connected: false, connectedAt: null });
  const [driveStats, setDriveStats] = useState<DriveStats | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
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

  useEffect(() => {
    void Promise.all([
      api.get<DriveStatus>("/integrations/customer/google-drive"),
      api.get<DriveStats>("/backups/drive-summary"),
    ]).then(([status, stats]) => { setDrive(status); setDriveStats(stats); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    setDriveBusy(true);
    api.post("/integrations/customer/google-drive/exchange", { code, state })
      .then(() => {
        show("Your Google Drive is connected. Your backups will be stored in your Drive.", "ok");
        return Promise.all([
          api.get<DriveStatus>("/integrations/customer/google-drive").then(setDrive),
          api.get<DriveStats>("/backups/drive-summary").then(setDriveStats),
        ]);
      })
      .catch((error) => show(error instanceof Error ? error.message : "Google Drive connection failed", "err"))
      .finally(() => {
        setDriveBusy(false);
        router.replace("/account");
      });
  }, [router, show]);

  const connectDrive = async () => {
    setDriveBusy(true);
    try {
      const result = await api.post<{ url: string }>("/integrations/customer/google-drive/connect");
      window.location.href = result.url;
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not start Google Drive connection", "err");
      setDriveBusy(false);
    }
  };

  const testDriveConnection = async () => {
    setDriveBusy(true);
    try {
      const status = await api.get<DriveStatus>("/integrations/customer/google-drive");
      setDrive(status);
      if (!status.connected) throw new Error("Google Drive authorization needs to be reconnected");
      show("Google Drive connection is working", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Google Drive test failed", "err");
    } finally {
      setDriveBusy(false);
    }
  };

  const openDriveFolder = () => {
    if (drive.folderId) window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(drive.folderId)}`, "_blank", "noopener,noreferrer");
  };

  const disconnectDrive = async () => {
    if (!window.confirm("Disconnect your Google Drive? Existing Drive backups will not be deleted.")) return;
    setDriveBusy(true);
    try {
      await api.del("/integrations/customer/google-drive");
      setDrive({ connected: false, connectedAt: null });
      show("Google Drive disconnected. Existing backups remain in your Drive.", "ok");
    } catch (error) {
      show(error instanceof Error ? error.message : "Could not disconnect Google Drive", "err");
    } finally {
      setDriveBusy(false);
    }
  };

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

      {user?.role === "customer" ? (
        <GlassCard className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Personal Google Drive</h2>
              <p className="mt-1 text-sm text-muted">Your service backups are stored in your own Google Drive, separate from the panel administrator's backups.</p>
              {drive.accountEmail ? <p className="mt-2 text-xs text-muted">{drive.accountEmail}</p> : null}
              {drive.connectedAt ? <p className="mt-1 text-xs text-muted">Connected {new Date(drive.connectedAt).toLocaleString()}</p> : null}
              {driveStats ? <p className="mt-1 text-xs text-muted">{driveStats.totalBackups} backups · {driveStats.lastSuccessfulBackup ? "Last successful backup " + new Date(driveStats.lastSuccessfulBackup).toLocaleString() : "No successful backups yet"}</p> : null}
              {drive.reconnectRequired ? <p className="mt-2 text-sm text-amber-400">Authorization expired. Reconnect your Drive.</p> : null}
            </div>
            <div className="flex gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs ${drive.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>{drive.connected ? "Connected" : "Not connected"}</span>
              <button className="btn-primary" disabled={driveBusy} onClick={() => void connectDrive()}>{driveBusy ? "Please wait…" : drive.connected ? "Reconnect" : "Connect Google Drive"}</button>
              {drive.connected ? (
                <>
                  <button className="btn-ghost" disabled={driveBusy} onClick={() => void testDriveConnection()}>Test connection</button>
                  {drive.folderId ? <button className="btn-ghost" onClick={openDriveFolder}>Open backup folder</button> : null}
                  <button className="btn-ghost" disabled={driveBusy} onClick={() => void disconnectDrive()}>Disconnect</button>
                </>
              ) : null}
            </div>
          </div>
        </GlassCard>
      ) : null}

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
