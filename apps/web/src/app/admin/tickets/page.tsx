"use client";

import { GlassCard, EmptyState } from "@/components/glass";

export default function AdminTickets() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Support Tickets</h1>
        <p className="mt-1 text-sm text-muted">Customer conversations, priorities and response times.</p>
      </header>
      <EmptyState
        title="No open tickets"
        hint="Customer tickets will appear here with category, priority and status. Reply threads notify both sides."
      />
    </div>
  );
}
