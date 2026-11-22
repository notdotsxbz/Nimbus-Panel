"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function BackgroundImage() {
  const [background, setBackground] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ backgroundImageData?: string | null }>("/appearance/public-settings")
      .then(settings => setBackground(settings.backgroundImageData ?? null))
      .catch(() => setBackground(null));
  }, []);

  if (!background) return null;

  const isRemote = /^https:\/\//i.test(background);
  const path = isRemote ? new URL(background).pathname.toLowerCase() : "";
  const isGif = path.endsWith(".gif");
  const isVideo = /\.(mp4|webm|ogg|ogv)$/.test(path);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {isVideo ? (
        <video
          className="absolute inset-0 h-full w-full scale-[1.04] object-cover"
          src={background}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
        />
      ) : isGif ? (
        <img
          src={background}
          alt=""
          className="absolute inset-0 h-full w-full scale-[1.04] object-cover"
        />
      ) : (
        <div
          className="absolute inset-0 h-full w-full bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${background}")`, filter: "blur(5px)", opacity: 0.32, transform: "scale(1.04)" }}
        />
      )}
      <div className="absolute inset-0 bg-black/55" />
    </div>
  );
}
