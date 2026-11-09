"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, Toast, useToast } from "@/components/glass";

interface UserRow {
  _id: string;
  email: string;
  username: string;
  role: string;
  suspended: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [roleTarget, setRoleTarget] = useState<UserRow | null>(null);
  const [roleValue, setRoleValue] = useState<string>("customer");
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const { show, node } = useToast();

  const load = async (q = "") => {
    try {
      const res = await api.get<{ items: UserRow[] }>(`/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      setUsers(res.items);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to load users", "err");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/users", {
        email: f.get("email"),
        username: f.get("username"),
        password: f.get("password"),
        role: f.get("role"),
      });
      setOpen(false);
      show("Customer created", "ok");
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Create failed", "err");
    }
  };

  const toggleSuspend = async (u: UserRow) => {
    await api.patch(`/users/${u._id}/suspended`, { suspended: !u.suspended });
    void load();
  };

  const changeRole = async () => {
    if (!roleTarget) return;
    try {
      await api.patch(`/users/${roleTarget._id}/role`, { role: roleValue });
      show(`Role updated to ${roleValue}`, "ok");
      setRoleTarget(null);
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Role change failed", "err");
    }
  };

  const deleteUser = async () => {
    if (!deleteTarget) return;
    try {
      await api.del(`/users/${deleteTarget._id}`);
      show("User deleted (archived — audit records preserved)", "ok");
      setDeleteTarget(null);
      void load();
    } catch (err) {
      show(err instanceof Error ? err.message : "Delete failed", "err");
    }
  };

  const resetAuth = async () => {
    if (!resetTarget) return;
    const res = await api.post<{ temporaryPassword: string }>(`/users/${resetTarget._id}/password`, {});
    show(`Temporary password: ${res.temporaryPassword}`, "ok");
    setResetTarget(null);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-1 text-sm text-muted">Only the owner can create panel accounts. Passwords are managed by Firebase Authentication.</p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          Add Customer
        </button>
      </header>

      <div className="flex gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search by username or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load(query)}
          aria-label="Search users"
        />
        <button className="btn-ghost" onClick={() => void load(query)}>
          Search
        </button>
      </div>

      <GlassCard className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Joined</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                <td className="px-5 py-3">
                  <p className="font-medium">{u.username}</p>
                  <p className="text-xs text-muted">{u.email}</p>
                </td>
                <td className="px-5 py-3 uppercase text-xs tracking-wider text-muted">{u.role}</td>
                <td className="px-5 py-3">
                  <span className="inline-flex items-center gap-2 text-xs">
                    <span className={`status-dot ${u.suspended ? "status-suspended" : "status-online"}`} />
                    {u.suspended ? "Suspended" : "Active"}
                  </span>
                </td>
                <td className="px-5 py-3 tnum text-xs text-muted">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => { setRoleTarget(u); setRoleValue(u.role); }}>
                      Edit role
                    </button>
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setResetTarget(u)}>
                      Reset auth
                    </button>
                    <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => void toggleSuspend(u)}>
                      {u.suspended ? "Unban" : "Ban"}
                    </button>
                    <button className="btn-danger !px-2.5 !py-1 text-xs" onClick={() => setDeleteTarget(u)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-muted">
                  No users found
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </GlassCard>

      <Modal open={open} title="Create panel user" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <div>
            <label className="label" htmlFor="u-email">Email</label>
            <input id="u-email" name="email" type="email" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="u-username">Username</label>
            <input id="u-username" name="username" required className="input" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" />
          </div>
          <div>
            <label className="label" htmlFor="u-password">Initial password</label>
            <input id="u-password" name="password" type="password" required minLength={8} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="u-role">Role</label>
            <select id="u-role" name="role" className="input" defaultValue="customer">
              <option value="customer">Customer</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button className="btn-primary w-full">Create user</button>
        </form>
      </Modal>

      <Modal open={resetTarget !== null} title="Reset authentication" onClose={() => setResetTarget(null)}>
        <p className="text-sm text-muted">
          Generate a temporary password for <strong>{resetTarget?.username}</strong>? They must change it
          on next login. Share it through a secure channel.
        </p>
        <div className="mt-5 flex gap-2">
          <button className="btn-danger flex-1" onClick={() => void resetAuth()}>Generate</button>
          <button className="btn-ghost flex-1" onClick={() => setResetTarget(null)}>Cancel</button>
        </div>
      </Modal>

      <Modal open={roleTarget !== null} title="Edit role" onClose={() => setRoleTarget(null)}>
        <p className="text-sm text-muted">
          Change the role for <strong>{roleTarget?.username}</strong>. Only the owner can grant or
          revoke the owner role; the last active owner can never be demoted. Role changes revoke the
          user's active sessions and are recorded in the audit log.
        </p>
        <div className="mt-4">
          <label className="label" htmlFor="role-select">Role</label>
          <select id="role-select" className="input" value={roleValue} onChange={(e) => setRoleValue(e.target.value)}>
            <option value="customer">Customer</option>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner (owner only)</option>
          </select>
        </div>
        <div className="mt-5 flex gap-2">
          <button className="btn-primary flex-1" onClick={() => void changeRole()}>Apply role</button>
          <button className="btn-ghost flex-1" onClick={() => setRoleTarget(null)}>Cancel</button>
        </div>
      </Modal>

      <Modal open={deleteTarget !== null} title="Delete user" onClose={() => setDeleteTarget(null)}>
        <p className="text-sm text-muted">
          Archive <strong>{deleteTarget?.username}</strong>? Their sessions are revoked immediately and
          the account is soft-deleted — audit records are preserved and the username/email are released.
          Owner accounts cannot be deleted.
        </p>
        <div className="mt-5 flex gap-2">
          <button className="btn-danger flex-1" onClick={() => void deleteUser()}>Delete user</button>
          <button className="btn-ghost flex-1" onClick={() => setDeleteTarget(null)}>Cancel</button>
        </div>
      </Modal>

      {node}
    </div>
  );
}
