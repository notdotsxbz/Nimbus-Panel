"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, currentUser } from "@/lib/api";
import { CopyField, GlassCard, Modal, StatusBadge, Toast, useToast } from "@/components/glass";

interface ServiceDetail {
  _id: string;
  name: string;
  type: string;
  status: string;
  ramMb: number;
  diskGb: number;
  cpuPercent: number;
  software?: string;
  subdomain?: string;
  expiresAt?: string;
  nodeId: { name?: string; ip?: string } | string;
  containerId?: string;
}

const TABS = ["Overview", "Console", "Files", "Backups", "Network", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function ServicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [confirm, setConfirm] = useState<"reinstall" | null>(null);
  const [busy, setBusy] = useState(false);
  const { show, node } = useToast();

  const load = useCallback(async () => {
    try {
      setService(await api.get<ServiceDetail>(`/services/${params.id}`));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        router.replace("/dashboard");
        return;
      }
      show(err instanceof Error ? err.message : "Failed to load service", "err");
    }
  }, [params.id, router, show]);

  useEffect(() => {
    if (currentUser()) void load();
  }, [load]);

  const power = async (action: "start" | "stop" | "restart" | "reinstall") => {
    setBusy(true);
    try {
      await api.post(`/services/${params.id}/power/${action}`);
      show(`${action} sent — waiting for node confirmation…`, "info");
      setTimeout(() => void load(), 1500);
    } catch (err) {
      show(err instanceof Error ? err.message : "Operation failed", "err");
    }
    setBusy(false);
    setConfirm(null);
  };

  if (!service) {
    return <GlassCard className="p-10 text-center text-sm text-muted">Loading…</GlassCard>;
  }

  const nodeIp = typeof service.nodeId === "object" ? service.nodeId?.ip : undefined;

  return (
    <div className="space-y-6">
      {/* Header + power controls */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{service.name}</h1>
            <StatusBadge status={service.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {service.type} · {typeof service.nodeId === "object" ? service.nodeId?.name : ""}
          </p>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button className="btn-primary !px-3" disabled={busy} onClick={() => void power("start")}>Start</button>
          <button className="btn-ghost !px-3" disabled={busy} onClick={() => void power("stop")}>Stop</button>
          <button className="btn-ghost !px-3" disabled={busy} onClick={() => void power("restart")}>Restart</button>
          <button className="btn-danger !px-3" disabled={busy} onClick={() => setConfirm("reinstall")}>Reinstall</button>
        </div>
      </header>

      {/* Tabs */}
      <div role="tablist" aria-label="Service sections" className="glass-soft flex overflow-x-auto rounded-xl p-1">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors ${
              tab === t ? "bg-white/10 font-medium text-white" : "text-muted hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <GlassCard className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Connection details</h2>
            <div className="space-y-2">
              {service.subdomain ? <CopyField label="Domain" value={service.subdomain} /> : null}
              <CopyField label="IP" value={nodeIp} />
              <CopyField label="Software" value={service.software} />
            </div>
          </GlassCard>
          <GlassCard className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Resources</h2>
            <dl className="tnum space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted">CPU limit</dt><dd>{service.cpuPercent}%</dd></div>
              <div className="flex justify-between"><dt className="text-muted">RAM</dt><dd>{service.ramMb} MB</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Disk</dt><dd>{service.diskGb} GB</dd></div>
              {service.expiresAt ? (
                <div className="flex justify-between"><dt className="text-muted">Expires</dt><dd>{new Date(service.expiresAt).toLocaleDateString()}</dd></div>
              ) : null}
            </dl>
          </GlassCard>
        </div>
      )}

      {tab === "Console" && <Console serviceId={service._id} status={service.status} />}

      {tab === "Files" && (
        <GlassCard className="p-10 text-center text-sm text-muted">
          The file manager streams through the node agent (authenticated, per-service root only).
          Browser upload/download endpoints are served by the agent at the node — this keeps
          customer file traffic off the control plane.
        </GlassCard>
      )}

      {tab === "Backups" && (
        <GlassCard className="p-6">
          <button
            className="btn-primary"
            onClick={() =>
              void api
                .post("/backups", { serviceId: service._id })
                .then(() => show("Backup queued", "ok"))
                .catch((e: Error) => show(e.message, "err"))
            }
          >
            Create backup now
          </button>
          <p className="mt-3 text-xs text-muted">
            Snapshots include sha256 integrity checksums. Scheduled backups can be enabled after
            connecting Google Drive in Account → Backups.
          </p>
        </GlassCard>
      )}

      {tab === "Network" && (
        <GlassCard className="p-6 text-sm text-muted">
          Allocations assigned to this service (IP, port, protocol) appear here. Ports are
          allocated by your administrator from the node pool (default 4001–4050).
        </GlassCard>
      )}

      {tab === "Settings" && (
        <GlassCard className="p-6 text-sm text-muted">
          Service-level settings (startup command, environment variables, recovery policy) are
          managed by your administrator per plan policy. Contact support to request changes.
        </GlassCard>
      )}

      {/* Destructive confirmation */}
      <Modal open={confirm === "reinstall"} title="Reinstall service?" onClose={() => setConfirm(null)}>
        <p className="text-sm text-muted">
          Reinstalling wipes the service data and reinstalls the software image. Create a backup
          first — existing data cannot be recovered afterwards.
        </p>
        <div className="mt-5 flex gap-2">
          <button className="btn-danger flex-1" disabled={busy} onClick={() => void power("reinstall")}>
            Reinstall now
          </button>
          <button className="btn-ghost flex-1" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </Modal>

      {node}
    </div>
  );
}

/** Mobile-friendly console: WebSocket to the node stream, touch input,
 *  auto-scroll, copy and full-screen. Authorization is validated per message. */
function Console({ serviceId, status }: { serviceId: string; status: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const wsUrl = `${apiBase.replace(/^http/, "ws")}/api/v1/services/${serviceId}/console`;
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (e) => setLines((prev) => [...prev.slice(-500), String(e.data)]);
      return () => ws.close();
    } catch {
      return undefined;
    }
  }, [serviceId]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [lines]);

  const send = () => {
    if (command.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", command }));
      setCommand("");
    }
  };

  return (
    <GlassCard className={`flex flex-col overflow-hidden ${fullscreen ? "fixed inset-4 z-50" : ""}`}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className={`status-dot ${connected ? "status-online" : "status-offline"}`} />
          {connected ? "Stream connected" : "Stream offline"} · {status}
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost !px-2.5 !py-1 text-xs"
            onClick={() => void navigator.clipboard.writeText(lines.join("\n"))}
          >
            Copy log
          </button>
          <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setFullscreen((f) => !f)}>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </div>
      <div
        ref={boxRef}
        className="h-80 overflow-y-auto bg-black/60 p-4 font-mono text-xs leading-relaxed"
        aria-live="polite"
        aria-label="Service console output"
      >
        {lines.length === 0 ? (
          <p className="text-neutral-600">Console output appears here in real time…</p>
        ) : (
          lines.map((l, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-neutral-200">{l}</p>
          ))
        )}
      </div>
      <form
        className="flex gap-2 border-t border-white/10 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="input font-mono text-xs"
          placeholder="Type a command…"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          aria-label="Console command"
        />
        <button className="btn-primary !px-4 text-xs" type="submit">Send</button>
      </form>
    </GlassCard>
  );
}
