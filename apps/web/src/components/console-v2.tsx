"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard } from "@/components/glass";

/** Universal service console — live logs (polled through the authenticated
 *  panel API, relayed to the node agent) + command execution. Works for every
 *  service type; Minecraft commands are piped into the server console. */
export function ConsoleV2({
  serviceId,
  type,
  status,
  fullscreen,
  onToggleFullscreen,
  initialCommand,
  onInitialCommandSent,
}: {
  serviceId: string;
  type: string;
  status: string;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  initialCommand?: string | null;
  onInitialCommandSent?: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const out = await api.get<{ lines: string[] }>(`/services/${serviceId}/console/logs?tail=300`);
      setLines(out.lines ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Log fetch failed");
    }
  }, [serviceId]);

  useEffect(() => {
    void fetchLogs();
    if (!auto) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void fetchLogs();
    }, 4000);
    return () => clearInterval(t);
  }, [fetchLogs, auto]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [lines]);

  // Execute a command handed over from another tab (e.g. Minecraft actions).
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialCommand || sentRef.current === initialCommand) return;
    sentRef.current = initialCommand;
    setCommand(initialCommand);
    (async () => {
      await new Promise((r) => setTimeout(r, 50));
      setHistory((h) => [initialCommand, ...h].slice(0, 50));
      try {
        await api.post(`/services/${serviceId}/console/exec`, {
          command: initialCommand,
          minecraft: type === "minecraft",
        });
        await fetchLogs();
      } catch (err) {
        setError(err instanceof Error ? err.message : "execution failed");
      }
      onInitialCommandSent?.();
    })();
  }, [initialCommand, serviceId, type, fetchLogs, onInitialCommandSent]);

  const send = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setHistory((h) => [cmd, ...h].slice(0, 50));
    setHistoryIdx(-1);
    setCommand("");
    setLines((prev) => [...prev.slice(-400), `> ${cmd}`]);
    try {
      await api.post(`/services/${serviceId}/console/exec`, { command: cmd, minecraft: type === "minecraft" });
      await fetchLogs();
    } catch (err) {
      setLines((prev) => [...prev, `execution failed: ${err instanceof Error ? err.message : "unknown"}`]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const idx = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(idx);
      setCommand(history[idx] ?? "");
    } else if (e.key === "ArrowDown" && historyIdx >= 0) {
      e.preventDefault();
      const idx = historyIdx - 1;
      setHistoryIdx(idx);
      setCommand(idx >= 0 ? history[idx] ?? "" : "");
    }
  };

  return (
    <GlassCard className={`flex flex-col overflow-hidden ${fullscreen ? "fixed inset-4 z-50" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span aria-hidden>⌨</span> {type} console · {status}
          {error ? <span className="text-err">· {error}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-3.5 w-3.5 accent-white" />
            Auto-refresh
          </label>
          <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void fetchLogs()}>Refresh</button>
          <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void navigator.clipboard.writeText(lines.join("\n"))}>Copy</button>
          <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setLines([])}>Clear</button>
          {onToggleFullscreen ? (
            <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onToggleFullscreen}>
              {fullscreen ? "Exit" : "Full screen"}
            </button>
          ) : null}
        </div>
      </div>
      <div
        ref={boxRef}
        className={`overflow-y-auto bg-black/70 p-4 font-mono text-xs leading-relaxed ${fullscreen ? "h-[calc(100%-7.5rem)]" : "h-80"}`}
        aria-live="polite"
        aria-label="Service console output"
      >
        {lines.length === 0 ? (
          <p className="text-neutral-600">Console output appears here — {auto ? "refreshing automatically" : "press Refresh"}…</p>
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
          void send();
        }}
      >
        <input
          className="input font-mono text-xs"
          placeholder={type === "minecraft" ? "Minecraft command (e.g. list, say hi, op Steve)…" : "Shell command inside your service…"}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Console command (↑ for history)"
        />
        <button className="btn-primary !px-4 text-xs" type="submit">Send</button>
      </form>
    </GlassCard>
  );
}
