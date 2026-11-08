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
}

interface Message {
  authorRole: string;
  body: string;
  at: string;
}

interface TicketDetail extends TicketRow {
  messages: Message[];
}

const STATUS_LABELS: Record<string, string> = {
  open: "Open", in_progress: "In Progress", waiting: "Waiting", closed: "Closed",
};

export default function CustomerSupport() {
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items?: TicketRow[] } | TicketRow[]>("/tickets");
      setTickets(Array.isArray(res) ? res : res.items ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load tickets", "err");
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/tickets", { subject: f.get("subject"), body: f.get("body"), priority: f.get("priority") });
      setOpen(false);
      show("Ticket created — our team will reply soon", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Create failed", "err");
    }
  };

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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Support</h1>
          <p className="mt-1 text-sm text-muted">Open a ticket and track replies from our team.</p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>New Ticket</button>
      </header>

      {tickets === null ? (
        <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>
      ) : tickets.length === 0 ? (
        <GlassCard className="p-10 text-center text-sm text-muted">
          No tickets yet. Need help? Create your first ticket above.
        </GlassCard>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <GlassCard key={t._id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="font-medium">{t.subject}</p>
                <p className="text-xs text-muted">Updated {new Date(t.updatedAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="glass-soft rounded-lg px-2.5 py-1 text-xs">{STATUS_LABELS[t.status]}</span>
                <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => void openDetail(t._id)}>Open</button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      <Modal open={open} title="New support ticket" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <div>
            <label className="label" htmlFor="t-subject">Subject</label>
            <input id="t-subject" name="subject" required minLength={3} maxLength={120} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="t-priority">Priority</label>
            <select id="t-priority" name="priority" className="input" defaultValue="normal">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="t-body">Message</label>
            <textarea id="t-body" name="body" required maxLength={4000} rows={5} className="input" />
          </div>
          <button className="btn-primary w-full">Create ticket</button>
        </form>
      </Modal>

      <Modal open={detail !== null} title={detail?.subject ?? ""} onClose={() => setDetail(null)}>
        {detail ? (
          <div className="space-y-3">
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {detail.messages.map((m, i) => (
                <div key={i} className={`glass-soft p-3 text-sm ${m.authorRole !== "customer" ? "border border-white/20" : ""}`}>
                  <p className="text-[10px] uppercase tracking-wider text-muted">
                    {m.authorRole === "customer" ? "You" : "Support"} · {new Date(m.at).toLocaleString()}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
            {detail.status !== "closed" ? (
              <form onSubmit={reply} className="flex gap-2">
                <input name="body" required maxLength={4000} className="input" placeholder="Type your reply…" aria-label="Reply" />
                <button className="btn-primary !px-4 text-xs" type="submit">Send</button>
              </form>
            ) : (
              <p className="text-xs text-muted">This ticket is closed.</p>
            )}
          </div>
        ) : null}
      </Modal>

      {node}
    </div>
  );
}
