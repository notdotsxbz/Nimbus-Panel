"use client";

import { Shell } from "@/components/shell";
import type { NavSection } from "@/components/shell";

const SECTIONS: NavSection[] = [
  {
    title: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: "◈" },
      { href: "/dashboard/services", label: "My Services", icon: "▣" },
    ],
  },
  {
    title: "Manage",
    items: [
      { href: "/dashboard/domains", label: "My Domains", icon: "◉" },
      { href: "/dashboard/backups", label: "Backups", icon: "⇩" },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/account", label: "Account Settings", icon: "⚙" },
    ],
  },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Shell sections={SECTIONS}>{children}</Shell>;
}
