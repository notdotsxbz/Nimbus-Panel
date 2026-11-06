/** Minimal typed API client. Session token lives in localStorage and is sent
 *  as a Bearer header; the API also sets an httpOnly cookie for same-site use. */

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("nimbus.token") : null;
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { message?: string }).message ?? res.statusText);
  return body as T;
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
