"use client";

import { useState } from "react";
import type { ServiceStatus } from "@nimbus/shared";

export function GlassCard({
  children,
  className = "",
  raised = false,
  role,
}: {
  children: React.ReactNode;
  className?: string;
  raised?: boolean;
  role?: string;
}) {
  return (
    <div className={`${raised ? "glass-raised" : "glass"} ${className}`} role={role}>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <GlassCard className="animate-rise p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className="tnum mt-2 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </GlassCard>
  );
}

const STATUS_LABELS: Record<ServiceStatus, string> = {
  online: "Online",
  offline: "Offline",
  starting: "Starting",
  stopping: "Stopping",
  restarting: "Restarting",
  installing: "Installing",
  updating: "Updating",
  suspended: "Suspended",
  error: "Error",
};

export function StatusBadge({ status }: { status: ServiceStatus | string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-neutral-300">
      <span className={`status-dot status-${status}`} aria-hidden />
      {STATUS_LABELS[status as ServiceStatus] ?? status}
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <GlassCard raised className="animate-rise w-full max-w-lg p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost !px-2.5 !py-1" aria-label="Close dialog">
            ✕
          </button>
        </div>
        {children}
      </GlassCard>
    </div>
  );
}

export function CopyField({ label, value }: { label: string; value?: string | number }) {
  const [copied, setCopied] = useState(false);
  if (value === undefined || value === null || value === "") return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="glass-soft flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</p>
        <p className="tnum truncate font-mono text-sm">{value}</p>
      </div>
      <button onClick={copy} className="btn-ghost shrink-0 !px-2.5 !py-1 text-xs" aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <GlassCard className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div className="glass-soft flex h-14 w-14 items-center justify-center rounded-full text-2xl" aria-hidden>
        ☁
      </div>
      <p className="text-lg font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-muted">{hint}</p> : null}
      {action}
    </GlassCard>
  );
}

export function Toast({ message, tone = "info" }: { message: string; tone?: "info" | "ok" | "err" }) {
  const color =
    tone === "ok" ? "border-green-400/30 text-green-300" : tone === "err" ? "border-red-400/30 text-red-300" : "";
  return (
    <div
      role="status"
      className={`glass-raised animate-rise fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 border px-5 py-3 text-sm ${color}`}
    >
      {message}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: "info" | "ok" | "err" } | null>(null);
  const show = (message: string, tone: "info" | "ok" | "err" = "info") => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 3200);
  };
  const node = toast ? <Toast message={toast.message} tone={toast.tone} /> : null;
  return { show, node };
}
