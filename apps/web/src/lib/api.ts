/** Minimal typed API client. Session token lives in localStorage and is sent
 *  as a Bearer header; the API also sets an httpOnly cookie for same-site use.
 *
 *  Base URL resolution — the fix for production "Failed to fetch":
 *   1. NEXT_PUBLIC_API_URL when provided (baked in at build time by the installer)
 *   2. Same-origin ("/api/v1") otherwise — nginx proxies /api/ to the backend,
 *      so the panel works on any domain without a rebuild. Never localhost. */

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "") + "/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function normalizeNetworkError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  // fetch() rejects with TypeError "Failed to fetch" on DNS/TLS/mixed-content
  // failures — surface a readable, actionable message instead.
  return new ApiError(0, "Cannot reach the NIMBUS API server. Check your connection or try again shortly.");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("nimbus.token") : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-request-id": crypto.randomUUID(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, (body as { message?: string }).message ?? res.statusText, (body as { code?: string }).code);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw normalizeNetworkError(err);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  /** Raw fetch for non-JSON operations (file upload/download) with auth. */
  raw: (path: string, init: RequestInit = {}) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("nimbus.token") : null;
    return fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  },
};

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: "owner" | "admin" | "staff" | "customer";
  mustChangePassword?: boolean;
}

export async function login(identifier: string, password: string): Promise<{ token: string; user: SessionUser; redirect: string }> {
  const res = await api.post<{ token: string; user: SessionUser; redirect: string }>("/auth/login", {
    identifier,
    password,
  });
  localStorage.setItem("nimbus.token", res.token);
  localStorage.setItem("nimbus.user", JSON.stringify(res.user));
  return res;
}

export async function firebaseLogin(email: string, password: string): Promise<{ token: string; user: SessionUser; redirect: string }> {
  const localOwnerLogin = async () => {
    const session = await api.post<{ token: string; user: SessionUser; redirect: string }>(
      "/auth/owner-local-bootstrap-login",
      { email, password },
    );
    localStorage.setItem("nimbus.token", session.token);
    localStorage.setItem("nimbus.user", JSON.stringify(session.user));
    return session;
  };

  let config: { apiKey: string };
  try {
    config = await api.get<{ apiKey: string }>("/auth/firebase-config");
  } catch (err) {
    // A fresh installation has no Firebase Web config yet. Let only the
    // existing owner use the installer credentials to enter Settings once.
    if (err instanceof ApiError && err.status === 400 && err.message === "Firebase web configuration is not connected") {
      return localOwnerLogin();
    }
    throw err;
  }
  const signIn = async () => {
    const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(config.apiKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const result = await response.json() as { idToken?: string; error?: { message?: string } };
    return { response, result };
  };
  let attempt = await signIn();
  if (!attempt.response.ok || !attempt.result.idToken) {
    // The installer seeds one local owner. This guarded, rate-limited endpoint
    // migrates only that owner once, using the same existing credentials.
    try {
      await api.post("/auth/owner-bootstrap", { email, password });
      attempt = await signIn();
    } catch {
      // Keep the original Firebase error for ordinary users.
    }
  }
  if (!attempt.response.ok || !attempt.result.idToken) {
    const reason = attempt.result.error?.message ?? "Firebase sign-in failed";
    throw new ApiError(attempt.response.status, reason.replaceAll("_", " ").toLowerCase());
  }
  const session = await api.post<{ token: string; user: SessionUser; redirect: string }>("/auth/firebase", { idToken: attempt.result.idToken });
  localStorage.setItem("nimbus.token", session.token);
  localStorage.setItem("nimbus.user", JSON.stringify(session.user));
  return session;
}

export async function firebaseRegister(email: string, password: string): Promise<{ token: string; user: SessionUser; redirect: string }> {
  const config = await api.get<{ apiKey: string }>("/auth/firebase-config");
  const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + encodeURIComponent(config.apiKey), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
  });
  const result = await response.json() as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !result.idToken) throw new ApiError(response.status, (result.error?.message ?? "Registration failed").replaceAll("_", " ").toLowerCase());
  const session = await api.post<{ token: string; user: SessionUser; redirect: string }>("/auth/register", { idToken: result.idToken });
  localStorage.setItem("nimbus.token", session.token);
  localStorage.setItem("nimbus.user", JSON.stringify(session.user));
  return session;
}

export async function firebaseGoogleRegister(googleIdToken: string): Promise<{ token: string; user: SessionUser; redirect: string }> {
  const config = await api.get<{ apiKey: string }>("/auth/firebase-config");
  const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=" + encodeURIComponent(config.apiKey), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ postBody: "id_token=" + encodeURIComponent(googleIdToken) + "&providerId=google.com", requestUri: window.location.origin, returnSecureToken: true, returnIdpCredential: true }),
  });
  const result = await response.json() as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !result.idToken) throw new ApiError(response.status, (result.error?.message ?? "Google sign-in failed").replaceAll("_", " ").toLowerCase());
  const session = await api.post<{ token: string; user: SessionUser; redirect: string }>("/auth/register", { idToken: result.idToken });
  localStorage.setItem("nimbus.token", session.token);
  localStorage.setItem("nimbus.user", JSON.stringify(session.user));
  return session;
}

export function logout() {
  localStorage.removeItem("nimbus.token");
  localStorage.removeItem("nimbus.user");
}

export function currentUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("nimbus.user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}
