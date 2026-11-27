"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Short branded transition on initial load and route changes; never blocks indefinitely. */
export function RocketLoadingScreen() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 850);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  if (!visible) return null;
  return (
    <div className="nimbus-rocket-loader" role="status" aria-live="polite" aria-label="Loading NIMBUS">
      <div className="nimbus-rocket-stage" aria-hidden="true">
        <svg className="nimbus-rocket" viewBox="0 0 100 140" width="110" height="154" fill="none">
          <path d="M50 8C32 25 27 47 29 79H71C73 47 68 25 50 8Z" fill="#f3f4f6" stroke="#a3a3a3" strokeWidth="2"/>
          <path d="M50 8C61 23 67 46 66 79H50V8Z" fill="#cbd5e1"/>
          <circle cx="50" cy="46" r="12" fill="#0f172a" stroke="#60a5fa" strokeWidth="4"/>
          <path d="M29 65 12 88V105L32 92ZM71 65 88 88V105L68 92Z" fill="#ef4444"/>
          <path d="M39 79V94H61V79" fill="#9ca3af"/>
          <path className="nimbus-rocket-flame" d="M39 95Q50 135 61 95Z" fill="#fb923c"/>
          <path className="nimbus-rocket-flame-inner" d="M44 96Q50 123 56 96Z" fill="#fef08a"/>
        </svg>
        <div className="nimbus-rocket-smoke" />
      </div>
      <div className="nimbus-rocket-brand">NIMBUS</div>
      <div className="nimbus-rocket-powered">Powered by <strong>ASTREVONE</strong></div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
