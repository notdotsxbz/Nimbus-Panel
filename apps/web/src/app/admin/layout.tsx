"use client";

import { Shell } from "@/components/shell";
import type { NavSection } from "@/components/shell";

const SECTIONS: NavSection[] = [
  {
    title: "Overview",
    items: [
      { href: "/admin", label: "Dashboard", icon: "◈" },
      { href: "/admin/activity", label: "Activity", icon: "≡" },
    ],
  },
  {
    title: "Customers",
    items: [
      { href: "/admin/users", label: "Users", icon: "◍" },
      { href: "/admin/tickets", label: "Support Tickets", icon: "✉" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { href: "/admin/nodes", label: "Nodes", icon: "▤" },
      { href: "/admin/network", label: "Allocations", icon: "⇄" },
    ],
  },
  {
    title: "Hosting",
    items: [{ href: "/admin/services", label: "All Services", icon: "▣" }],
  },
  {
    title: "Management",
    items: [
      { href: "/admin/domains", label: "Domains", icon: "◉" },
      { href: "/admin/backups", label: "Backups", icon: "⇩" },
    ],
  },
  {
    title: "Platform",
    items: [{ href: "/admin/settings", label: "Settings", icon: "⚙" }],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <Shell sections={SECTIONS}>{children}</Shell>;
}
