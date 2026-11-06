"use client";

import { GlassCard } from "@/components/glass";

/** Platform settings — integration status is read from the server env,
 *  secrets themselves are never exposed to the browser. */
export default function AdminSettings() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Platform integrations and appearance.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <GlassCard className="p-6">
          <h2 className="font-semibold">Firebase Authentication</h2>
          <p className="mt-2 text-sm text-muted">
            Configure <code className="font-mono text-xs">FIREBASE_ADMIN_CREDENTIALS_BASE64</code> and the
            NEXT_PUBLIC_FIREBASE_* variables in the environment, then restart the API. Until then local
            credential login remains available. Private credentials never reach the browser.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Cloudflare</h2>
          <p className="mt-2 text-sm text-muted">
            Set a scoped API token (DNS:Edit on the hosting zone only) via
            <code className="font-mono text-xs"> CLOUDFLARE_API_TOKEN</code> and
            <code className="font-mono text-xs"> CLOUDFLARE_ZONE_ID</code>. Account passwords are never requested.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Google Drive Backups</h2>
          <p className="mt-2 text-sm text-muted">
            Configure the OAuth client (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI). Refresh tokens are
            encrypted at rest. Each admin and customer connects their own Drive.
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <h2 className="font-semibold">Appearance</h2>
          <p className="mt-2 text-sm text-muted">
            The Liquid Glass system ships with the black-and-white NIMBUS brand. Glass intensity,
            animation level and Low Bandwidth Mode follow system preferences and per-user toggles.
          </p>
        </GlassCard>
      </div>
    </div>
  );
}
