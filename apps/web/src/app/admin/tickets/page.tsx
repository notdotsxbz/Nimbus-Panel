"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, Toast, useToast } from "@/components/glass";

interface TicketRow {
  _id: string;
  subject: string;
  status: "open" | "in_progress" | "waiting" | "closed";
  priority: string;
  updatedAt: string;
  ownerId?: { username?: string; email?: string } | null;
}

interface Message {
  authorRole: string;
  body: string;
  at: string;
}

interface TicketDetail extends TicketRow {
  messages: Message[];
}

const STATUSES = ["open", "in_progress", "waiting", "closed"] as const;
const STATUS_LABELS: Record<string, string> = {
  open: "Open", in_progress: "In Progress", waiting: "Waiting", closed: "Closed",
};

export default function AdminTickets() {
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items?: TicketRow[] } | TicketRow[]>(`/tickets${statusFilter ? `?status=${statusFilter}` : ""}`);
      setTickets(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load tickets", "err");
    }
  }, [statusFilter, show]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    try {
      setDetail(await api.get<TicketDetail>(`/tickets/${id}`));
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load ticket", "err");
    }
  };

  const reply = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!detail) return;
    const body = String(new FormData(e.currentTarget).get("body") ?? "").trim();
    if (!body) return;
    try {
      setDetail(await api.post<TicketDetail>(`/tickets/${detail._id}/reply`, { body }));
      show("Reply sent", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Reply failed", "err");
    }
  };

  const deleteTicket = async (ticket: TicketRow) => {
    if (!window.confirm(`Permanently delete ticket "${ticket.subject}"? This cannot be undone.`)) return;
    try {
      await api.del(`/tickets/${ticket._id}`);
      if (detail?._id === ticket._id) setDetail(null);
      show("Ticket deleted", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Ticket deletion failed", "err");
    }
  };

  const setStatus = async (status: string) => {
    if (!detail) return;
    try {
      setDetail(await api.post<TicketDetail>(`/tickets/${detail._id}/status`, { status }));
      show(`Status: ${STATUS_LABELS[status]}`, "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Status change failed", "err");
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Support Tickets</h1>
          <p className="mt-1 text-sm text-muted">Customer conversations, priorities and statuses.</p>
        </div>
        <select className="input max-w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </header>

      {tickets === null ? (
        <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>
      ) : tickets.length === 0 ? (
        <GlassCard className="p-10 text-center text-sm text-muted">No tickets match this filter.</GlassCard>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <GlassCard key={t._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">{t.subject}</p>
                <p className="text-xs text-muted">
                  {typeof t.ownerId === "object" ? t.ownerId?.username ?? "unknown" : "unknown"} · {t.priority} · updated {new Date(t.updatedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="glass-soft rounded-lg px-2.5 py-1 text-xs">{STATUS_LABELS[t.status]}</span>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void openDetail(t._id)}>Open</button>
                <button className="btn-danger !px-3 !py-1.5 text-xs" onClick={() => void deleteTicket(t)}>Delete</button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      <Modal open={detail !== null} title={detail?.subject ?? ""} onClose={() => setDetail(null)}>
        {detail ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  className={`btn-ghost !px-3 !py-1 text-xs ${detail.status === s ? "!bg-white/20" : ""}`}
                  onClick={() => void setStatus(s)}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {detail.messages.map((m, i) => (
                <div key={i} className={`glass-soft p-3 text-sm ${m.authorRole !== "customer" ? "border border-white/20" : ""}`}>
                  <p className="text-[10px] uppercase tracking-wider text-muted">
                    {m.authorRole === "customer" ? "Customer" : "Support"} · {new Date(m.at).toLocaleString()}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
            <form onSubmit={reply} className="flex gap-2">
              <input name="body" required maxLength={4000} className="input" placeholder="Reply to customer…" aria-label="Staff reply" />
              <button className="btn-primary !px-4 text-xs" type="submit">Send</button>
            </form>
          </div>
        ) : null}
      </Modal>

      {node}
    </div>
  );
}
