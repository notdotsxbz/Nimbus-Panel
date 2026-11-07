"use client";

import { useEffect } from "react";
import { syncAppearance } from "@/lib/theme";

/** Mounted once in the root layout — re-syncs the theme from the API
 *  after mount and whenever the user returns to the tab (multi-device
 *  persistence: preferences follow the account, not the browser). */
export function AppearanceSync() {
  useEffect(() => {
    void syncAppearance();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncAppearance();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
