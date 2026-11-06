"use client";

import { useEffect, useState } from "react";

/** PWA registration + Low Bandwidth Mode (persisted preference).
 *  The service worker caches ONLY the app shell — never API responses,
 *  tokens or private service data. */
export function useNimbusClient() {
  const [lowBandwidth, setLowBandwidth] = useState(false);

  useEffect(() => {
    const pref = localStorage.getItem("nimbus.lowBandwidth") === "1";
    setLowBandwidth(pref);
    document.documentElement.classList.toggle("low-bandwidth", pref);

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  const toggleLowBandwidth = () => {
    setLowBandwidth((prev) => {
      const next = !prev;
      localStorage.setItem("nimbus.lowBandwidth", next ? "1" : "0");
      document.documentElement.classList.toggle("low-bandwidth", next);
      return next;
    });
  };

  return { lowBandwidth, toggleLowBandwidth };
}
