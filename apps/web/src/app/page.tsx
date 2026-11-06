"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem("nimbus.token");
    router.replace(token ? "/dashboard" : "/login");
  }, [router]);
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <div className="glass animate-rise px-10 py-8 text-center">
        <p className="text-2xl font-semibold tracking-[0.35em]">NIMBUS</p>
        <p className="mt-2 text-sm text-muted">Loading…</p>
      </div>
    </main>
  );
}
