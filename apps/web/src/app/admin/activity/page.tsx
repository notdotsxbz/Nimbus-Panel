"use client";

import { GlassCard } from "@/components/glass";

export default function AdminActivity() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-muted">Immutable audit trail of sensitive operations.</p>
      </header>
      <GlassCard className="p-10 text-center text-sm text-muted">
        Audit events appear here as soon as sensitive operations occur — logins, service
        lifecycle actions, allocation and domain changes, backup and restore operations.
        Query the trail programmatically via <code className="font-mono text-xs">GET /api/v1/activities</code>
        {" "}with an API key (see docs/API_GUIDE.md).
      </GlassCard>
    </div>
  );
}
