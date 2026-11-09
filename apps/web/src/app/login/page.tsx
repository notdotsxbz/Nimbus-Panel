"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { firebaseLogin } from "@/lib/api";

/** ONE common login page — no separate admin/customer entry points.
 *  Role routing happens server-side (redirect field). */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await firebaseLogin(email.trim(), password);
      router.replace(res.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      {/* Ambient light — one soft reflection, deliberately restrained */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-20%] h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-white/[0.04] blur-3xl"
      />
      <div className="glass-raised animate-rise w-full max-w-sm p-8">
        <h1 className="text-center text-xl font-semibold tracking-[0.35em]">NIMBUS</h1>
        <p className="mt-1 text-center text-xs text-muted">One platform. Every service.</p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4" aria-describedby={error ? "login-error" : undefined}>
          <div>
            <label className="label" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? (
            <p id="login-error" role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
          Protected by rate limiting and audit logging.
          <br />
          Accounts are created by the Nimbus owner. Self-registration is disabled. For password help, contact your administrator.
        </p>
      </div>
    </main>
  );
}
