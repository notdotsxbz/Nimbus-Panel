"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { firebaseRegister } from "@/lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const res = await firebaseRegister(email.trim(), password); router.replace(res.redirect); }
    catch (err) { setError(err instanceof Error ? err.message : "Registration failed"); setBusy(false); }
  };
  return <main className="flex min-h-dvh items-center justify-center px-4"><div className="glass-raised w-full max-w-sm p-8">
    <h1 className="text-center text-xl font-semibold tracking-[0.35em]">NIMBUS</h1><p className="mt-2 text-center text-sm text-muted">Create your customer account</p>
    <form onSubmit={onSubmit} className="mt-7 space-y-4">
      <div><label className="label" htmlFor="reg-email">Email address</label><input id="reg-email" className="input" type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} /></div>
      <div><label className="label" htmlFor="reg-password">Password</label><input id="reg-password" className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} /></div>
      {error ? <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}
      <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
    </form>
    <p className="mt-5 text-center text-xs text-muted">New accounts start with no services. Your owner must assign service access.</p>
    <p className="mt-4 text-center text-sm text-muted">Already registered? <Link className="text-current underline" href="/login">Sign in</Link></p>
  </div></main>;
}
