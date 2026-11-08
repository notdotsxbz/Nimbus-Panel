"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { currentUser } from "@/lib/api";

/** Entry point — routes by session. Renders the branded NIMBUS splash while
 *  checking, with an error/retry state when initialization fails. Never a
 *  blank white screen: the theme background is applied pre-paint. */
export default function Home() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setState("error"); // no infinite spinner
    }, 8000);
    try {
      const token = localStorage.getItem("nimbus.token");
      router.replace(token ? "/dashboard" : "/login");
    } catch {
      setState("error");
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <div className="glass animate-rise flex flex-col items-center gap-4 px-12 py-10 text-center" role="status" aria-live="polite">
        <p className="text-3xl font-semibold tracking-[0.35em]">NIMBUS</p>
        {state === "loading" ? (
          <>
            <div
              aria-hidden
              className="h-1 w-40 overflow-hidden rounded-full bg-white/10"
            >
              <div className="h-full w-1/2 animate-[nimbusslide_1.2s_ease-in-out_infinite] rounded-full bg-white/70" />
            </div>
            <p className="text-sm text-muted">Preparing your panel…</p>
          </>
        ) : (
          <>
            <p className="max-w-xs text-sm text-muted">
              The panel could not be initialized. Check your connection and try again.
            </p>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Retry
            </button>
          </>
        )}
      </div>
      <style>{`@keyframes nimbusslide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
    </main>
  );
}
