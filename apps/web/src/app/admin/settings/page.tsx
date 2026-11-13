"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { GlassCard, Modal, useToast } from "@/components/glass";

type FirebaseStatus = { connected: boolean; projectId: string | null; webConfigured?: boolean; connectedAt: string | null };
type ConnectionStatus = { connected: boolean; zoneId?: string | null; connectedAt: string | null };

export default function AdminSettings() {
  const router = useRouter();
  const [firebase, setFirebase] = useState<FirebaseStatus>({ connected: false, projectId: null, webConfigured: false, connectedAt: null });
  const [cloudflare, setCloudflare] = useState<ConnectionStatus>({ connected: false, connectedAt: null });
  const [drive, setDrive] = useState<ConnectionStatus>({ connected: false, connectedAt: null });
  const [backgroundImageData, setBackgroundImageData] = useState("");
  const [firebaseJson, setFirebaseJson] = useState("");
  const [firebaseWeb, setFirebaseWeb] = useState({ apiKey: "", authDomain: "", projectId: "", appId: "", storageBucket: "", messagingSenderId: "", googleClientId: "" });
  const [cfToken, setCfToken] = useState("");
  const [cfZone, setCfZone] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [firebaseOpen, setFirebaseOpen] = useState(false);
  const [cloudflareOpen, setCloudflareOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = async () => {
    const results = await Promise.allSettled([
      api.get<FirebaseStatus>("/integrations/firebase"),
      api.get<ConnectionStatus>("/integrations/cloudflare"),
      api.get<ConnectionStatus>("/integrations/google-drive"),
      api.get<{ backgroundImageData?: string }>("/appearance/settings"),
    ]);
    if (results[0].status === "fulfilled") setFirebase(results[0].value);
    if (results[1].status === "fulfilled") setCloudflare(results[1].value);
    if (results[2].status === "fulfilled") setDrive(results[2].value);
    if (results[3].status === "fulfilled") setBackgroundImageData(results[3].value.backgroundImageData ?? "");
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    setBusy(true);
    api.post("/integrations/google-drive/exchange", { code, state })
      .then(() => { show("Google Drive connected. Backups can now be sent to Drive.", "ok"); void load(); })
      .catch((error) => show(error instanceof Error ? error.message : "Google Drive connection failed", "err"))
      .finally(() => { setBusy(false); router.replace("/admin/settings"); });
  }, [router]);

  const connectFirebase = async () => {
    setBusy(true);
    try {
      const webConfig = { ...firebaseWeb, storageBucket: firebaseWeb.storageBucket || undefined, messagingSenderId: firebaseWeb.messagingSenderId || undefined };
      const result = await api.post<FirebaseStatus & { connected: boolean }>("/integrations/firebase", { serviceAccountJson: firebaseJson, webConfig });
      setFirebase({ connected: result.connected, projectId: result.projectId, webConfigured: true, connectedAt: new Date().toISOString() });
      setFirebaseJson(""); setFirebaseOpen(false); show("Firebase Authentication connected", "ok");
    } catch (error) { show(error instanceof Error ? error.message : "Firebase connection failed", "err"); }
    finally { setBusy(false); }
  };

  const disconnectFirebase = async () => {
    if (!window.confirm("Disconnect Firebase Authentication? Panel sign-in and Firebase user management will stop working.")) return;
    setBusy(true);
    try { await api.del("/integrations/firebase"); setFirebase({ connected: false, projectId: null, webConfigured: false, connectedAt: null }); show("Firebase disconnected", "ok"); }
    catch (error) { show(error instanceof Error ? error.message : "Disconnect failed", "err"); }
    finally { setBusy(false); }
  };

  const connectCloudflare = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ connected: boolean; zoneId: string }>("/integrations/cloudflare", { apiToken: cfToken, zoneId: cfZone });
      setCloudflare({ connected: result.connected, zoneId: result.zoneId, connectedAt: new Date().toISOString() });
      setCfToken(""); setCloudflareOpen(false); show("Cloudflare connected", "ok");
    } catch (error) { show(error instanceof Error ? error.message : "Cloudflare connection failed", "err"); }
    finally { setBusy(false); }
  };

  const disconnectCloudflare = async () => {
    if (!window.confirm("Disconnect Cloudflare from Nimbus?")) return;
    setBusy(true);
    try { await api.del("/integrations/cloudflare"); setCloudflare({ connected: false, connectedAt: null }); show("Cloudflare disconnected", "ok"); }
    catch (error) { show(error instanceof Error ? error.message : "Disconnect failed", "err"); }
    finally { setBusy(false); }
  };

  const connectDrive = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ url: string }>("/integrations/google-drive/connect", { clientId: googleClientId, clientSecret: googleClientSecret });
      window.location.href = result.url;
    } catch (error) { show(error instanceof Error ? error.message : "Could not start Google connection", "err"); setBusy(false); }
  };

  const disconnectDrive = async () => {
    if (!window.confirm("Disconnect Google Drive? New Drive backups will no longer upload.")) return;
    setBusy(true);
    try { await api.del("/integrations/google-drive"); setDrive({ connected: false, connectedAt: null }); show("Google Drive disconnected", "ok"); }
    catch (error) { show(error instanceof Error ? error.message : "Disconnect failed", "err"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Connect the services used by your Nimbus installation.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <GlassCard className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Firebase Authentication</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs ${firebase.connected && firebase.webConfigured ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>
              {firebase.connected && firebase.webConfigured ? "Connected" : "Setup required"}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">Panel email/password sign-in and owner-managed user accounts. Customer registration and Google sign-in use Firebase Authentication. New customers receive no service access until the owner assigns a service.</p>
          {firebase.projectId ? <p className="mt-3 text-xs text-muted">Project: <span className="font-mono">{firebase.projectId}</span></p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setFirebaseOpen(true)}>{firebase.connected ? "Update Firebase" : "Connect Firebase"}</button>
            {firebase.connected ? <button className="btn-ghost" disabled={busy} onClick={() => void disconnectFirebase()}>Disconnect</button> : null}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Cloudflare</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs ${cloudflare.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>{cloudflare.connected ? "Connected" : "Not connected"}</span>
          </div>
          <p className="mt-2 text-sm text-muted">Connect a scoped Cloudflare API token and Zone ID. Nimbus uses it for DNS record operations; the token is encrypted on the server.</p>
          {cloudflare.zoneId ? <p className="mt-3 text-xs text-muted">Zone: <span className="font-mono">{cloudflare.zoneId}</span></p> : null}
          <div className="mt-4 flex gap-2">
            <button className="btn-primary" onClick={() => setCloudflareOpen(true)}>{cloudflare.connected ? "Update Cloudflare" : "Connect Cloudflare"}</button>
            {cloudflare.connected ? <button className="btn-ghost" disabled={busy} onClick={() => void disconnectCloudflare()}>Disconnect</button> : null}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Google Drive Backups</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs ${drive.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>{drive.connected ? "Connected" : "Not connected"}</span>
          </div>
          <p className="mt-2 text-sm text-muted">Authorize Nimbus through Google OAuth. Completed node snapshots are checksum-verified and uploaded to your Drive.</p>
          <div className="mt-4 flex gap-2">
            <button className="btn-primary" onClick={() => setDriveOpen(true)}>{drive.connected ? "Reconnect Google Drive" : "Connect Google Drive"}</button>
            {drive.connected ? <button className="btn-ghost" disabled={busy} onClick={() => void disconnectDrive()}>Disconnect</button> : null}
          </div>
        </GlassCard>

        <GlassCard className="p-6 md:col-span-2">
          <h2 className="font-semibold">Panel background image</h2>
          <p className="mt-2 text-sm text-muted">Upload a PNG, JPEG, WebP or GIF image up to 1 MB. It will appear softly blurred behind the panel for every user. Leave empty and save to remove it.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input className="input min-w-0 flex-1" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 1_000_000) { show("Choose an image smaller than 1 MB", "err"); e.target.value = ""; return; }
              const reader = new FileReader();
              reader.onload = () => setBackgroundImageData(typeof reader.result === "string" ? reader.result : "");
              reader.onerror = () => show("Could not read that image file", "err");
              reader.readAsDataURL(file);
            }} />
            <button className="btn-primary" disabled={busy || !backgroundImageData} onClick={async () => { setBusy(true); try { await api.patch("/appearance/settings", { backgroundImageData }); show("Background image saved for all users", "ok"); } catch (error) { show(error instanceof Error ? error.message : "Could not save background image", "err"); } finally { setBusy(false); } }}>Save image</button>
            <button className="btn-ghost" disabled={busy || !backgroundImageData} onClick={async () => { setBusy(true); try { await api.patch("/appearance/settings", { backgroundImageData: "" }); setBackgroundImageData(""); show("Background image removed", "ok"); } catch (error) { show(error instanceof Error ? error.message : "Could not remove image", "err"); } finally { setBusy(false); } }}>Remove</button>
          </div>
          {backgroundImageData ? <img src={backgroundImageData} alt="Selected panel background preview" className="mt-4 max-h-40 max-w-xs rounded-xl object-cover" /> : null}
        </GlassCard>
      </div>

      <Modal open={firebaseOpen} title="Connect Firebase Authentication" onClose={() => !busy && setFirebaseOpen(false)} footer={<div className="flex justify-end gap-2"><button className="btn-ghost" disabled={busy} onClick={() => setFirebaseOpen(false)}>Cancel</button><button className="btn-primary" disabled={busy || !firebaseJson.trim() || !firebaseWeb.apiKey || !firebaseWeb.authDomain || !firebaseWeb.projectId || !firebaseWeb.appId} onClick={() => void connectFirebase()}>{busy ? "Connecting…" : "Validate & connect"}</button></div>}>
        <div className="space-y-3">
          <p className="text-sm text-muted">Paste the Firebase Admin service-account JSON and the Firebase Web App configuration from the same project. Enable Email/Password under Firebase Authentication → Sign-in method.</p>
          <label className="label">Firebase Web App API key</label><input className="input w-full" value={firebaseWeb.apiKey} onChange={e => setFirebaseWeb(v => ({ ...v, apiKey: e.target.value }))} />
          <label className="label">Auth domain</label><input className="input w-full" placeholder="your-project.firebaseapp.com" value={firebaseWeb.authDomain} onChange={e => setFirebaseWeb(v => ({ ...v, authDomain: e.target.value }))} />
          <label className="label">Project ID</label><input className="input w-full" value={firebaseWeb.projectId} onChange={e => setFirebaseWeb(v => ({ ...v, projectId: e.target.value }))} />
          <label className="label">App ID</label><input className="input w-full" value={firebaseWeb.appId} onChange={e => setFirebaseWeb(v => ({ ...v, appId: e.target.value }))} />
          <label className="label">Storage bucket (optional)</label><input className="input w-full" value={firebaseWeb.storageBucket} onChange={e => setFirebaseWeb(v => ({ ...v, storageBucket: e.target.value }))} />
          <label className="label">Messaging sender ID (optional)</label><input className="input w-full" value={firebaseWeb.messagingSenderId} onChange={e => setFirebaseWeb(v => ({ ...v, messagingSenderId: e.target.value }))} />
          <label className="label">Google OAuth Web Client ID (required for Google sign-in)</label><input className="input w-full" placeholder="...apps.googleusercontent.com" value={firebaseWeb.googleClientId} onChange={e => setFirebaseWeb(v => ({ ...v, googleClientId: e.target.value }))} />
          <label className="label">Firebase Admin service-account JSON</label>
          <textarea value={firebaseJson} onChange={e => setFirebaseJson(e.target.value)} rows={7} spellCheck={false} autoComplete="off" className="input w-full resize-y font-mono text-xs" placeholder={'{ "type": "service_account", ... }'} />
          <p className="text-xs text-muted">The service-account private key is sent over HTTPS and encrypted in the Nimbus database. Never share it in chat or public repositories.</p>
        </div>
      </Modal>

      <Modal open={cloudflareOpen} title="Connect Cloudflare" onClose={() => !busy && setCloudflareOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-muted">Create an API token limited to the zone and DNS permissions Nimbus needs. Do not use your Global API Key.</p>
          <label className="label">Cloudflare API token</label><input type="password" autoComplete="off" className="input w-full" value={cfToken} onChange={e => setCfToken(e.target.value)} />
          <label className="label">Zone ID</label><input className="input w-full" value={cfZone} onChange={e => setCfZone(e.target.value)} />
          <div className="flex justify-end gap-2"><button className="btn-ghost" disabled={busy} onClick={() => setCloudflareOpen(false)}>Cancel</button><button className="btn-primary" disabled={busy || !cfToken || !cfZone} onClick={() => void connectCloudflare()}>{busy ? "Validating…" : "Validate & connect"}</button></div>
        </div>
      </Modal>

      <Modal open={driveOpen} title="Connect Google Drive" onClose={() => !busy && setDriveOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-muted">Create a Google OAuth Web application client. Add this authorized redirect URI: <span className="font-mono break-all">{typeof window !== "undefined" ? window.location.origin : ""}/admin/settings</span>. Nimbus stores the refresh token encrypted and only requests the Drive file scope.</p>
          <label className="label">OAuth Client ID</label><input className="input w-full" value={googleClientId} onChange={e => setGoogleClientId(e.target.value)} />
          <label className="label">OAuth Client Secret</label><input type="password" autoComplete="off" className="input w-full" value={googleClientSecret} onChange={e => setGoogleClientSecret(e.target.value)} />
          <div className="flex justify-end gap-2"><button className="btn-ghost" disabled={busy} onClick={() => setDriveOpen(false)}>Cancel</button><button className="btn-primary" disabled={busy || !googleClientId || !googleClientSecret} onClick={() => void connectDrive()}>{busy ? "Opening Google…" : "Continue to Google"}</button></div>
        </div>
      </Modal>
      {node}
    </div>
  );
}
