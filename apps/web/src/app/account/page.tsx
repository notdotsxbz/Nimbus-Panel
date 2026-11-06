"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, currentUser } from "@/lib/api";
import { GlassCard, Toast, useToast } from "@/components/glass";

export default function AccountSettings() {
  const router = useRouter();
  const [user, setUser] = useState<{ username: string; email: string; role: string; mustChangePassword?: boolean } | null>(null);
  const { show, node } = useToast();

  useEffect(() => {
    void (async () => {
      try {
        setUser(await api.get<typeof user>("/auth/me"));
      } catch {
        router.replace("/login");
      }
    })();
  }, [router]);

  const changePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/users/me/password", { current: f.get("current"), next: f.get("next") });
      show("Password updated", "ok");
      e.currentTarget.reset();
    } catch (err) {
      show(err instanceof Error ? err.message : "Change failed", "err");
    }
  };

  const changeUsername = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.patch("/users/me/username", { username: f.get("username") });
      show("Username updated — sign in again to refresh", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Change failed", "err");
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {user?.mustChangePassword ? (
        <GlassCard className="border-amber-400/30 p-5" role="alert">
          <p className="text-sm text-amber-300">
            You are using initial credentials. Change your password below — this is required.
          </p>
        </GlassCard>
      ) : null}

      <header>
        <h1 className="text-2xl font-semibold">Account Settings</h1>
        <p className="mt-1 text-sm text-muted">
          {user ? `${user.email} · ${user.role}` : "Loading…"}
        </p>
      </header>

      <GlassCard className="p-6">
        <h2 className="mb-4 font-semibold">Change password</h2>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="label" htmlFor="p-current">Current password</label>
            <input id="p-current" name="current" type="password" required className="input" autoComplete="current-password" />
          </div>
          <div>
            <label className="label" htmlFor="p-next">New password (min 8 chars)</label>
            <input id="p-next" name="next" type="password" required minLength={8} className="input" autoComplete="new-password" />
          </div>
          <button className="btn-primary">Update password</button>
        </form>
      </GlassCard>

      <GlassCard className="p-6">
        <h2 className="mb-4 font-semibold">Change username</h2>
        <form onSubmit={changeUsername} className="space-y-4">
          <div>
            <label className="label" htmlFor="u-new">New username</label>
            <input
              id="u-new"
              name="username"
              required
              className="input"
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
              defaultValue={user?.username}
            />
          </div>
          <button className="btn-ghost">Update username</button>
        </form>
      </GlassCard>

      <GlassCard className="p-6">
        <h2 className="mb-2 font-semibold">Install as app (PWA)</h2>
        <p className="text-sm text-muted">
          Android: open the browser menu → “Install app”. iPhone: Share → “Add to Home Screen”.
          Desktop: use the install icon in the address bar. NIMBUS runs standalone and keeps
          essential controls available; no private data is cached offline.
        </p>
      </GlassCard>

      {node}
    </div>
  );
}
