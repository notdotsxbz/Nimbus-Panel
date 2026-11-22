"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, firebaseGoogleRegister, firebaseRegister } from "@/lib/api";

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

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let script: HTMLScriptElement | null = null;

    const setupGoogle = (clientId: string) => {
      const google = (window as Window & { google?: GoogleIdentity }).google;
      const target = document.getElementById("google-signup");
      if (!active || !google || !target) return;

      google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          if (!response.credential) return;
          const cleanUsername = username.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanUsername)) {
            setError("Choose a username of 3–32 characters using letters, numbers, dots, underscores or hyphens. It must start with a letter or number.");
            return;
          }
          setBusy(true);
          setError(null);
          try {
            const session = await firebaseGoogleRegister(response.credential, cleanUsername);
            router.replace(session.redirect);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Google registration failed");
            setBusy(false);
          }
        },
      });
      google.accounts.id.renderButton(target, {
        theme: "filled_black",
        size: "large",
        shape: "rectangular",
        text: "signup_with",
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
          if (active) setError("Google sign-up could not be loaded. Please try again.");
        };
        document.head.appendChild(script);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      if (script?.parentNode) script.parentNode.removeChild(script);
    };
  }, [router, username]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanUsername)) {
      setError("Username must be 3–32 characters and use only letters, numbers, dots, underscores or hyphens.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await firebaseRegister(email.trim(), password, cleanUsername);
      router.replace(session.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-raised w-full max-w-sm p-8">
        <h1 className="text-center text-xl font-semibold tracking-[0.35em]">NIMBUS</h1>
        <p className="mt-2 text-center text-sm text-muted">Create your customer account</p>
        <form onSubmit={onSubmit} className="mt-7 space-y-4">
          <div>
            <label className="label" htmlFor="reg-username">Username</label>
            <input id="reg-username" className="input" type="text" autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" required value={username} onChange={(event) => setUsername(event.target.value)} />
            <p className="mt-1 text-[11px] text-muted">3–32 characters: letters, numbers, dots, underscores or hyphens.</p>
          </div>
          <div>
            <label className="label" htmlFor="reg-email">Email address</label>
            <input id="reg-email" className="input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="reg-password">Password</label>
            <input id="reg-password" className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          {error ? <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
          <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
        </form>

        {googleClientId ? (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-white/10" />or sign up with<span className="h-px flex-1 bg-white/10" /></div>
            <div id="google-signup" className="flex justify-center" />
          </>
        ) : null}

        <p className="mt-5 text-center text-xs text-muted">New accounts start with no services. Your owner must assign service access.</p>
        <p className="mt-4 text-center text-sm text-muted">Already registered? <Link className="text-current underline" href="/login">Sign in</Link></p>
      </div>
    </main>
  );
}
