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

type AuthMethod = "email" | "google";

function emailFromGoogleToken(token: string): string {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return "";
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { email?: string };
    return payload.email ?? "";
  } catch {
    return "";
  }
}

const steps = ["Choose email", "Choose username", "Create password", "Confirm password"];

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState<AuthMethod>("email");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [googleIdToken, setGoogleIdToken] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleLoading, setGoogleLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [redirect, setRedirect] = useState("/dashboard");

  useEffect(() => {
    let active = true;
    let script: HTMLScriptElement | null = null;

    const setupGoogle = (clientId: string) => {
      const google = (window as Window & { google?: GoogleIdentity }).google;
      const target = document.getElementById("nimbus-google-register");
      if (!active || !google || !target) return;

      target.replaceChildren();
      google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (!response.credential) return;
          const detectedEmail = emailFromGoogleToken(response.credential);
          if (!detectedEmail) {
            setError("Google did not provide an email address. Please try again or use email registration.");
            return;
          }
          setMethod("google");
          setGoogleIdToken(response.credential);
          setEmail(detectedEmail);
          setError(null);
          setStep(2);
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
          setGoogleLoading(false);
          return;
        }
        script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = () => {
          if (active) {
            setupGoogle(config.googleClientId!);
            setGoogleLoading(false);
          }
        };
        script.onerror = () => {
          if (active) {
            setGoogleLoading(false);
            setError("Google sign-up could not be loaded. You can still register with your email.");
          }
        };
        document.head.appendChild(script);
      })
      .catch(() => {
        if (active) setGoogleLoading(false);
      });

    return () => {
      active = false;
      if (script?.parentNode) script.parentNode.removeChild(script);
    };
  }, []);

  const goBack = () => {
    setError(null);
    setStep((current) => Math.max(1, current - 1));
  };

  const continueFromEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setMethod("email");
    setGoogleIdToken("");
    setError(null);
    setStep(2);
  };

  const continueFromUsername = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(clean)) {
      setError("Username must be 3–32 characters and use letters, numbers, dots, underscores or hyphens.");
      return;
    }
    setUsername(clean);
    setError(null);
    setStep(3);
  };

  const continueFromPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < 8) {
      setError("Your password must contain at least 8 characters.");
      return;
    }
    setError(null);
    setStep(4);
  };

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("The passwords do not match. Please check them and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = method === "google"
        ? await firebaseGoogleRegister(googleIdToken, username, password)
        : await firebaseRegister(email.trim(), password, username);
      setRedirect(session.redirect);
      setSuccessOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't create your account. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[-20%] h-[60vh] w-[80vw] -translate-x-1/2 rounded-full bg-white/[0.04] blur-3xl" />
      <div className="glass-raised animate-rise relative z-10 w-full max-w-md p-7 sm:p-8">
        <h1 className="text-center text-xl font-semibold tracking-[0.35em]">NIMBUS</h1>
        <p className="mt-2 text-center text-sm text-muted">A better home for every service you run.</p>

        <div className="mt-7 flex items-center justify-between gap-2">
          <span className="text-xs text-muted">Step {step} of 4</span>
          <span className="text-xs text-muted">{steps[step - 1]}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-sky-500 transition-all duration-300" style={{ width: (step * 25) + "%" }} />
        </div>

        {step === 1 ? (
          <section className="mt-7 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Start your Nimbus account</h2>
              <p className="mt-1 text-sm text-muted">Use your email address or continue securely with Google.</p>
            </div>
            <form onSubmit={continueFromEmail} className="space-y-4">
              <div>
                <label className="label" htmlFor="reg-email">Gmail or email address</label>
                <input id="reg-email" className="input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
              </div>
              <button type="submit" className="btn-primary w-full">Continue with email</button>
            </form>
            {googleClientId ? (
              <>
                <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-white/10" />or<span className="h-px flex-1 bg-white/10" /></div>
                <div id="nimbus-google-register" className="flex min-h-10 justify-center" />
              </>
            ) : googleLoading ? (
              <p className="text-center text-xs text-muted">Loading Google sign-up…</p>
            ) : null}
          </section>
        ) : null}

        {step === 2 ? (
          <form onSubmit={continueFromUsername} className="mt-7 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Choose your username</h2>
              <p className="mt-1 break-all text-sm text-muted">Account email: <span className="text-current">{email}</span></p>
            </div>
            <div>
              <label className="label" htmlFor="reg-username">Username</label>
              <input id="reg-username" className="input" type="text" autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="yourname" />
              <p className="mt-1 text-[11px] text-muted">3–32 characters: letters, numbers, dots, underscores or hyphens.</p>
            </div>
            {error ? <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
            <div className="flex gap-3">
              <button type="button" className="btn-ghost flex-1" onClick={goBack}>Back</button>
              <button type="submit" className="btn-primary flex-1">Continue</button>
            </div>
          </form>
        ) : null}

        {step === 3 ? (
          <form onSubmit={continueFromPassword} className="mt-7 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Create a password</h2>
              <p className="mt-1 text-sm text-muted">Use at least 8 characters. Your password is stored and managed by Firebase Authentication.</p>
            </div>
            <div>
              <label className="label" htmlFor="reg-password">Password</label>
              <input id="reg-password" className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {error ? <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
            <div className="flex gap-3">
              <button type="button" className="btn-ghost flex-1" onClick={goBack}>Back</button>
              <button type="submit" className="btn-primary flex-1">Continue</button>
            </div>
          </form>
        ) : null}

        {step === 4 ? (
          <form onSubmit={createAccount} className="mt-7 space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Confirm your password</h2>
              <p className="mt-1 text-sm text-muted">One last check before your Nimbus account is created.</p>
            </div>
            <div>
              <label className="label" htmlFor="reg-confirm-password">Confirm password</label>
              <input id="reg-confirm-password" className="input" type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </div>
            {error ? <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
            <div className="flex gap-3">
              <button type="button" className="btn-ghost flex-1" disabled={busy} onClick={goBack}>Back</button>
              <button type="submit" className="btn-primary flex-1" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
            </div>
          </form>
        ) : null}

        {step === 1 && error ? <p role="alert" className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}

        <p className="mt-6 text-center text-xs text-muted">New accounts start without service access. Your Nimbus owner can assign services after registration.</p>
        <p className="mt-4 text-center text-sm text-muted">Already registered? <Link className="text-current underline underline-offset-4" href="/login">Sign in</Link></p>
      </div>

      {successOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 px-4 py-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
          <div className="glass-raised my-auto w-full max-w-xl p-7 sm:p-8">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-2xl text-emerald-300">✓</div>
            <p className="mt-4 text-center text-xs font-semibold uppercase tracking-[0.25em] text-emerald-300">Account ready</p>
            <h2 id="welcome-title" className="mt-2 text-center text-2xl font-semibold">Welcome to NIMBUS</h2>
            <p className="mt-2 text-center text-sm text-muted">Your account has been created and you are now signed in.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                ["Game server hosting", "Run and manage Minecraft and other game servers."],
                ["Bot and app hosting", "Host Discord bots, websites, backends and Docker apps."],
                ["Databases and backups", "Manage supported databases and keep service backups organised."],
                ["Domains and support", "Manage your domains and reach the support team from one panel."],
              ].map(([title, description]) => (
                <div key={title} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <h3 className="text-sm font-semibold">{title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
              <p className="text-sm font-medium">Built with care by Icefire &amp; Broz</p>
              <p className="mt-1 text-xs text-muted">Nimbus owner: Icefire</p>
            </div>
            <button className="btn-primary mt-6 w-full" onClick={() => router.replace(redirect)}>Go to my dashboard</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
