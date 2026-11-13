"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function BackgroundVideo() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { api.get<{ backgroundVideoUrl?: string | null }>("/appearance/public-settings").then(v => setUrl(v.backgroundVideoUrl ?? null)).catch(() => setUrl(null)); }, []);
  if (!url) return null;
  return <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
    <video key={url} autoPlay muted loop playsInline preload="metadata" className="h-full w-full object-cover" style={{ filter: "blur(5px)", opacity: 0.32, transform: "scale(1.04)" }}>
      <source src={url} />
    </video>
    <div className="absolute inset-0 bg-black/55" />
  </div>;
}
