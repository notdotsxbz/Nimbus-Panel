"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { GlassCard, Modal, Toast, useToast } from "@/components/glass";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mode: string;
  modTime: string;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Universal file manager — browses and edits files inside the service's own
 *  directory on its node. All operations go through the authenticated panel
 *  API; path traversal is rejected server-side. */
export function FileManager({
  serviceId,
  initialPath,
  onPathConsumed,
}: {
  serviceId: string;
  initialPath?: string;
  onPathConsumed?: () => void;
}) {
  const [path, setPath] = useState(initialPath ?? "/");
  useEffect(() => {
    if (initialPath) onPathConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [editor, setEditor] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { show, node } = useToast();

  const load = useCallback(async (p: string) => {
    try {
      const out = await api.get<{ entries: FileEntry[] }>(`/services/${serviceId}/files?path=${encodeURIComponent(p)}`);
      setEntries(out.entries ?? []);
    } catch (err) {
      show(err instanceof Error ? err.message : "Failed to list files", "err");
      setEntries([]);
    }
  }, [serviceId, show]);

  useEffect(() => {
    void load(path);
  }, [load, path]);

  const join = (base: string, name: string) => (base === "/" ? `/${name}` : `${base}/${name}`);

  const openFile = async (name: string) => {
    const p = join(path, name);
    try {
      const out = await api.get<{ content: string }>(`/services/${serviceId}/files/content?path=${encodeURIComponent(p)}`);
      setEditor({ path: p, content: out.content, dirty: false });
    } catch (err) {
      show(err instanceof Error ? err.message : "Cannot open file", "err");
    }
  };

  const saveFile = async () => {
    if (!editor) return;
    try {
      await api.post(`/services/${serviceId}/files/write`, { path: editor.path, content: editor.content });
      setEditor({ ...editor, dirty: false });
      show("File saved", "ok");
    } catch (err) {
      show(err instanceof Error ? err.message : "Save failed", "err");
    }
  };

  const createEntry = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    if (!name || name.includes("/") || name.includes("..")) return show("Invalid name", "err");
    const p = join(path, name);
    try {
      if (f.get("kind") === "dir") await api.post(`/services/${serviceId}/files/mkdir`, { path: p });
      else await api.post(`/services/${serviceId}/files/write`, { path: p, content: "" });
      setCreateOpen(false);
      void load(path);
    } catch (err) {
      show(err instanceof Error ? err.message : "Create failed", "err");
    }
  };

  const deleteEntry = async (name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await api.post(`/services/${serviceId}/files/delete`, { path: join(path, name) });
      void load(path);
    } catch (err) {
      show(err instanceof Error ? err.message : "Delete failed", "err");
    }
  };

  const renameEntry = async (oldName: string) => {
    const to = prompt("New name:", oldName);
    if (!to || to === oldName || to.includes("/") || to.includes("..")) return;
    try {
      await api.post(`/services/${serviceId}/files/rename`, { path: join(path, oldName), to: join(path, to) });
      void load(path);
    } catch (err) {
      show(err instanceof Error ? err.message : "Rename failed", "err");
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > 1024 * 1024) {
        show(`"${file.name}" exceeds the 1 MB browser-upload limit — use SFTP for large files`, "err");
        continue;
      }
      try {
        const content = await file.text();
        await api.post(`/services/${serviceId}/files/write`, { path: join(path, file.name), content });
        show(`Uploaded ${file.name}`, "ok");
      } catch (err) {
        show(`Upload failed for ${file.name}: ${err instanceof Error ? err.message : "error"}`, "err");
      }
    }
    void load(path);
  };

  const crumbs = path.split("/").filter(Boolean);

  return (
    <GlassCard className="p-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="glass-soft flex flex-1 flex-wrap items-center gap-1 px-3 py-2 font-mono text-xs">
          <button className="hover:underline" onClick={() => setPath("/")}>root</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {" / "}
              <button className="hover:underline" onClick={() => setPath("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </div>
        <button className="btn-ghost !px-3 text-xs" onClick={() => setCreateOpen(true)}>+ New</button>
        <button className="btn-ghost !px-3 text-xs" onClick={() => fileInput.current?.click()}>Upload</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>

      {/* listing */}
      <div className="mt-3 overflow-x-auto">
        {entries === null ? (
          <p className="py-8 text-center text-sm text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Empty directory.</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Modified</th>
                <th className="px-3 py-2 font-medium">Perms</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {path !== "/" ? (
                <tr className="border-b border-white/5">
                  <td className="px-3 py-2" colSpan={5}>
                    <button className="text-muted hover:underline" onClick={() => setPath(path.split("/").slice(0, -1).join("/") || "/")}>← parent directory</button>
                  </td>
                </tr>
              ) : null}
              {entries.map((e) => {
                const p = join(path, e.name);
                return (
                  <tr key={e.name} className="border-b border-white/5 hover:bg-white/[0.03]">
                    <td className="px-3 py-2">
                      {e.type === "dir" ? (
                        <button className="font-medium hover:underline" onClick={() => setPath(p)}>📁 {e.name}</button>
                      ) : (
                        <button className="hover:underline" onClick={() => void openFile(e.name)}>📄 {e.name}</button>
                      )}
                    </td>
                    <td className="tnum px-3 py-2 text-xs text-muted">{e.type === "dir" ? "—" : fmtSize(e.size)}</td>
                    <td className="px-3 py-2 text-xs text-muted">{new Date(e.modTime).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{e.mode}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        <button className="btn-ghost !px-2 !py-0.5 text-[10px]" onClick={() => void renameEntry(e.name)}>Rename</button>
                        <button className="btn-danger !px-2 !py-0.5 text-[10px]" onClick={() => void deleteEntry(e.name)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* editor */}
      <Modal open={editor !== null} title={`Edit: ${editor?.path ?? ""}`} onClose={() => editor?.dirty && !confirm("Discard unsaved changes?") ? undefined : setEditor(null)}>
        {editor ? (
          <div className="space-y-3">
            <textarea
              className="input h-80 font-mono text-xs"
              value={editor.content}
              onChange={(e) => setEditor({ ...editor, content: e.target.value, dirty: true })}
              spellCheck={false}
              aria-label="File content"
            />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={() => void saveFile()} disabled={!editor.dirty}>
                {editor.dirty ? "Save changes" : "Saved"}
              </button>
              <button className="btn-ghost flex-1" onClick={() => (editor.dirty && !confirm("Discard unsaved changes?") ? undefined : setEditor(null))}>Close</button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* create */}
      <Modal open={createOpen} title="Create file or folder" onClose={() => setCreateOpen(false)}>
        <form onSubmit={createEntry} className="space-y-4">
          <div>
            <label className="label" htmlFor="f-name">Name</label>
            <input id="f-name" name="name" required className="input font-mono" />
          </div>
          <div>
            <label className="label" htmlFor="f-kind">Kind</label>
            <select id="f-kind" name="kind" className="input" defaultValue="file">
              <option value="file">File</option>
              <option value="dir">Folder</option>
            </select>
          </div>
          <button className="btn-primary w-full">Create</button>
        </form>
      </Modal>

      {node}
    </GlassCard>
  );
}
