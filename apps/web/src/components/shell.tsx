"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { currentUser, logout, type SessionUser } from "@/lib/api";
import { useNimbusClient } from "@/lib/pwa";

export interface NavSection {
  title: string;
  items: { href: string; label: string; icon: string }[];
}

export function Shell({
  sections,
  children,
}: {
  sections: NavSection[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const { lowBandwidth, toggleLowBandwidth } = useNimbusClient();

  useEffect(() => {
    const u = currentUser();
    if (!u) router.replace("/login");
    else {
      setUser(u);
      // Role-based route guard: customers never belong in the admin panel.
      // (The API enforces this server-side too — this only fixes the UX.)
      if (u.role === "customer" && pathname.startsWith("/admin")) {
        router.replace("/dashboard");
      }
    }
  }, [router, pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setDrawer(false), [pathname]);

  const doLogout = async () => {
    logout();
    router.replace("/login");
  };

  const sidebar = (
    <nav aria-label="Primary" className="flex h-full flex-col gap-6 overflow-y-auto p-5">
      <Link href="/" className="px-2 text-lg font-semibold tracking-[0.3em]">
        NIMBUS
      </Link>
      {sections.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                      active ? "bg-white/10 font-medium text-white" : "text-neutral-400 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <span aria-hidden className="w-4 text-center text-xs opacity-70">{item.icon}</span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="mt-auto space-y-2 px-2">
        <button onClick={toggleLowBandwidth} className="text-xs text-muted hover:text-white">
          Low Bandwidth Mode: {lowBandwidth ? "On" : "Off"}
        </button>
        {user ? (
          <div className="glass-soft px-3 py-2 text-xs">
            <p className="truncate font-medium">{user.username}</p>
            <p className="truncate text-muted">{user.email}</p>
            <p className="mt-0.5 uppercase tracking-wider text-muted">{user.role}</p>
          </div>
        ) : null}
        <button onClick={doLogout} className="btn-ghost w-full text-xs">
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-64 rounded-none border-y-0 border-l-0 lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawer ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="glass-raised absolute inset-y-0 left-0 w-72 animate-rise rounded-none">{sidebar}</aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="glass sticky top-0 z-20 flex items-center justify-between gap-3 rounded-none border-x-0 border-t-0 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              className="btn-ghost !px-2.5 lg:hidden"
              onClick={() => setDrawer(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
            <button
              onClick={() => setPalette(true)}
              className="btn-ghost hidden !justify-start !px-3 text-sm text-muted sm:flex sm:w-64"
            >
              <span aria-hidden>⌕</span> Search…
              <kbd className="ml-auto rounded border border-white/15 px-1.5 text-[10px]">Ctrl K</kbd>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/account" className="btn-ghost !px-3 text-xs">
              Account
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>

      {/* Command palette — searches the current nav scope */}
      {palette ? (
        <CommandPalette sections={sections} onClose={() => setPalette(false)} />
      ) : null}
    </div>
  );
}

function CommandPalette({ sections, onClose }: { sections: NavSection[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const router = useRouter();
  const all = sections.flatMap((s) => s.items);
  const results = all.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-24 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="glass-raised animate-rise w-full max-w-xl overflow-hidden">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search services, users, nodes, pages…"
          className="w-full border-b border-white/10 bg-transparent px-5 py-4 text-sm outline-none placeholder:text-neutral-500"
          aria-label="Search"
        />
        <ul className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted">No matches</li>
          ) : (
            results.map((item) => (
              <li key={item.href}>
                <button
                  onClick={() => {
                    router.push(item.href);
                    onClose();
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm hover:bg-white/10"
                >
                  <span aria-hidden className="opacity-60">{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
