"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function BackgroundImage() {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ backgroundImageData?: string | null }>("/appearance/public-settings")
      .then(settings => setImage(settings.backgroundImageData ?? null))
      .catch(() => setImage(null));
  }, []);
  if (!image) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="absolute inset-0 h-full w-full bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url("${image}")`, filter: "blur(5px)", opacity: 0.32, transform: "scale(1.04)" }}
      />
      <div className="absolute inset-0 bg-black/55" />
    </div>
  );
}
