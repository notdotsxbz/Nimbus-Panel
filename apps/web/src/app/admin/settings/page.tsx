"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, useToast } from "@/components/glass";

type FirebaseStatus = { connected: boolean; projectId: string | null; connectedAt: string | null };

export default function AdminSettings() {
  const [firebase, setFirebase] = useState<FirebaseStatus>({ connected: false, projectId: null, connectedAt: null });
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const { show, node } = useToast();

  const loadFirebase = async () => {
    try { setFirebase(await api.get<FirebaseStatus>("/integrations/firebase")); }
    catch (error) { show(error instanceof Error ? error.message : "Could not load Firebase status", "err"); }
  };
  useEffect(() => { void loadFirebase(); }, []);

  const connectFirebase = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ connected: boolean; projectId: string }>("/integrations/firebase", { serviceAccountJson: json });
      setFirebase({ connected: result.connected, projectId: result.projectId, connectedAt: new Date().toISOString() });
      setJson(""); setOpen(false); show("Firebase connected successfully", "ok");
    } catch (error) { show(error instanceof Error ? error.message : "Firebase connection failed", "err"); }
    finally { setBusy(false); }
  };
  const disconnectFirebase = async () => {
    if (!window.confirm("Disconnect Firebase from this Nimbus installation?")) return;
    setBusy(true);
    try { await api.del("/integrations/firebase"); setFirebase({ connected: false, projectId: null, connectedAt: null }); show("Firebase disconnected", "ok"); }
    catch (error) { show(error instanceof Error ? error.message : "Could not disconnect Firebase", "err"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Platform integrations and appearance.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <GlassCard className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Firebase Authentication</h2>
            <span className="text-xs text-muted">Existing login</span>
          </div>
          <p className="mt-2 text-sm text-muted">
            Existing Firebase Authentication configuration is unchanged. This integration is separate and does not change how administrators or customers sign in.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Firebase Integration</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs ${firebase.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-white/10 text-muted"}`}>
              {firebase.connected ? "Connected" : "Not connected"}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">
            Connect a Firebase project using its service-account JSON. Credentials are encrypted by the API and never sent back to the browser.
          </p>
          {firebase.projectId ? <p className="mt-3 text-xs text-muted">Project: <span className="font-mono">{firebase.projectId}</span></p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setOpen(true)}>{firebase.connected ? "Replace credentials" : "Connect Firebase"}</button>
            {firebase.connected ? <button className="btn-ghost" disabled={busy} onClick={() => void disconnectFirebase()}>Disconnect</button> : null}
          </div>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Cloudflare</h2>
          <p className="mt-2 text-sm text-muted">
            Cloudflare DNS integration is currently configured through server environment settings. A secure website-based token manager is not included in this update.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Google Drive Backups</h2>
          <p className="mt-2 text-sm text-muted">
            Google Drive OAuth support is partially present. Configure its OAuth client on the server before connecting Drive accounts. Website-based OAuth setup is not included in this update.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Appearance</h2>
          <p className="mt-2 text-sm text-muted">
            The Liquid Glass system ships with the black-and-white NIMBUS brand. Glass intensity, animation level and Low Bandwidth Mode follow system preferences and per-user toggles.
          </p>
        </GlassCard>
      </div>
      <Modal open={open} title="Connect Firebase" onClose={() => !busy && setOpen(false)}>
        <div className="space-y-3">
          <p className="text-sm text-muted">Paste the complete JSON file for a Firebase service account. Use a dedicated service account with only the permissions your integration needs.</p>
          <textarea
            value={json}
            onChange={(event) => setJson(event.target.value)}
            rows={9}
            spellCheck={false}
            autoComplete="off"
            className="input-field w-full resize-y font-mono text-xs"
            placeholder={'{\n  "type": "service_account",\n  "project_id": "your-project",\n  ...\n}'}
          />
          <p className="text-xs text-muted">The private key is sent only to the Nimbus API over HTTPS and stored encrypted. Never paste this JSON into a public issue or chat.</p>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={busy || !json.trim()} onClick={() => void connectFirebase()}>{busy ? "Connecting…" : "Validate & connect"}</button>
          </div>
        </div>
      </Modal>
      {node}
    </div>
  );
}
