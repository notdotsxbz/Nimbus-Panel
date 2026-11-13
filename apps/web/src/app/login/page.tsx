"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, firebaseGoogleRegister, firebaseLogin } from "@/lib/api";

type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: { credential: string }) => void;
      }) => void;
      renderButton: (element: HTMLElement, options: Record<string, unknown>) => void;
    };
  };
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");

  useEffect(() => {
    let active = true;
    let script: HTMLScriptElement | null = null;

    const setupGoogle = (clientId: string) => {
      const google = (window as Window & { google?: GoogleIdentity }).google;
      const target = document.getElementById("google-signin");
      if (!active || !google || !target) return;

      google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          if (!response.credential) return;
          setBusy(true);
          setError(null);
          try {
            const session = await firebaseGoogleRegister(response.credential);
            router.replace(session.redirect);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Google sign-in failed");
            setBusy(false);
          }
        },
      });
      google.accounts.id.renderButton(target, {
        theme: "filled_black",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        width: 300,
      });
    };

    api.get<{ googleClientId?: string }>("/auth/firebase-config")
      .then((config) => {
        if (!active || !config.googleClientId) return;
        setGoogleClientId(config.googleClientId);
        const existing = (window as Window & { google?: GoogleIdentity }).google;
        if (existing) {
          setupGoogle(config.googleClientId);
          return;
        }
        script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = () => setupGoogle(config.googleClientId!);
        script.onerror = () => {
          if (active) setError("Google sign-in could not be loaded. Please try again.");
        };
        document.head.appendChild(script);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      if (script?.parentNode) script.parentNode.removeChild(script);
    };
  }, [router]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await firebaseLogin(email.trim(), password);
      router.replace(session.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[-20%] h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-white/[0.04] blur-3xl" />
      <div className="glass-raised animate-rise w-full max-w-sm p-8">
        <h1 className="text-center text-xl font-semibold tracking-[0.35em]">NIMBUS</h1>
        <p className="mt-1 text-center text-xs text-muted">One platform. Every service.</p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4" aria-describedby={error ? "login-error" : undefined}>
          <div>
            <label className="label" htmlFor="email">Email address</label>
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" type="password" className="input" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          {error ? <p id="login-error" role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>

        {googleClientId ? (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-white/10" />or<span className="h-px flex-1 bg-white/10" /></div>
            <div id="google-signin" className="flex justify-center" />
          </>
        ) : null}

        <p className="mt-5 text-center text-sm text-muted">New here? <Link className="text-white underline underline-offset-4" href="/register">Create an account</Link></p>
        <p className="mt-6 text-center text-[11px] leading-relaxed text-muted">
          Protected by rate limiting and audit logging.<br />
          New customers start with no service access. The owner assigns services after registration.
        </p>
      </div>
    </main>
  );
}
