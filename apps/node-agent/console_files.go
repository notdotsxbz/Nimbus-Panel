package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ── Universal file manager ────────────────────────────────────────────
// Every operation is confined to the service's own data directory.
// Routes: /files/<serviceId>/<op>  (op: list|read|write|mkdir|delete|rename)
// Path traversal is blocked by resolveBelow().

// resolveBelow joins base+rel and guarantees the result stays inside base.
func resolveBelow(base, rel string) (string, error) {
	clean := filepath.Clean("/" + rel)         // forces absolute, removes ..
	full := filepath.Join(base, clean)
	if full != base && !strings.HasPrefix(full, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("path traversal rejected")
	}
	return full, nil
}

type fileEntry struct {
	Name    string    `json:"name"`
	Type    string    `json:"type"` // file | dir
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"modTime"`
}

func handleFiles(s *AgentServer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // files/<id>/<op>
		if len(parts) != 3 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		dir, err := s.servicePath(parts[1])
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		op := parts[2]
		rel := r.URL.Query().Get("path")
		target, rerr := resolveBelow(dir, rel)
		if rerr != nil {
			http.Error(w, rerr.Error(), http.StatusBadRequest)
			return
		}

		switch op {
		case "list":
			entries := []fileEntry{}
			items, err := os.ReadDir(target)
			if err != nil {
				if os.IsNotExist(err) {
					writeJSON(w, map[string]any{"entries": entries})
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, e := range items {
				info, err := e.Info()
				if err != nil {
					continue
				}
				typ := "file"
				if e.IsDir() {
					typ = "dir"
				}
				entries = append(entries, fileEntry{Name: e.Name(), Type: typ, Size: info.Size(), Mode: info.Mode().Perm().String(), ModTime: info.ModTime()})
			}
			sort.Slice(entries, func(i, j int) bool {
				if entries[i].Type != entries[j].Type {
					return entries[i].Type == "dir"
				}
				return entries[i].Name < entries[j].Name
			})
			writeJSON(w, map[string]any{"entries": entries})

		case "read":
			data, err := os.ReadFile(target)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			// Text files only for the editor — refuse huge/binary payloads.
			const maxRead = 512 * 1024
			if len(data) > maxRead {
				http.Error(w, "file too large for the editor (max 512 KB) — download instead", http.StatusBadRequest)
				return
			}
			writeJSON(w, map[string]any{"content": string(data)})

		case "write":
			var req struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if err := os.WriteFile(target, []byte(req.Content), 0o640); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true})

		case "mkdir":
			if err := os.MkdirAll(target, 0o750); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true})

		case "delete":
			// Refuse to delete the service root itself.
			if target == dir {
				http.Error(w, "cannot delete the service root", http.StatusBadRequest)
				return
			}
			if err := os.RemoveAll(target); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true})

		case "rename":
			var req struct {
				To string `json:"to"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			dest, derr := resolveBelow(dir, req.To)
			if derr != nil {
				http.Error(w, derr.Error(), http.StatusBadRequest)
				return
			}
			if err := os.Rename(target, dest); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true})

		default:
			http.Error(w, "unknown file operation", http.StatusNotFound)
		}
	}
}

// ── Console: logs + command execution ────────────────────────────────
// GET /logs/<serviceId>?tail=300 → recent container output (polled).
// POST /exec/<serviceId> {"command":"…"} → non-interactive execution inside
// the customer's own container. Minecraft services pipe the command into the
// server process console (works with containers that keep stdin open on PID1);
// everything else runs a plain sh -c. Neither exposes the host shell.

func handleLogs(s *AgentServer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serviceID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/logs/"), "/")
		if strings.ContainsAny(serviceID, "/\\") || strings.Contains(serviceID, "..") {
			http.Error(w, "invalid service id", http.StatusBadRequest)
			return
		}
		if _, err := s.servicePath(serviceID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		tail := r.URL.Query().Get("tail")
		if tail == "" {
			tail = "300"
		}
		out, err := docker("logs", "--tail", tail, "--timestamps", "nimbus-"+serviceID)
		if err != nil && out == "" {
			writeJSON(w, map[string]any{"lines": []string{"(no container output yet — is the service started?)"}})
			return
		}
		writeJSON(w, map[string]any{"lines": nonEmptyLines(out)})
	}
}

func handleExec(s *AgentServer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serviceID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/exec/"), "/")
		if strings.ContainsAny(serviceID, "/\\") || strings.Contains(serviceID, "..") {
			http.Error(w, "invalid service id", http.StatusBadRequest)
			return
		}
		if _, err := s.servicePath(serviceID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var req struct {
			Command   string `json:"command"`
			Minecraft bool   `json:"minecraft"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil || strings.TrimSpace(req.Command) == "" {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		// Length guard — one console command, not a script dump.
		if len(req.Command) > 500 {
			http.Error(w, "command too long (max 500 chars)", http.StatusBadRequest)
			return
		}

		container := "nimbus-" + serviceID
		var out string
		var err error
		if req.Minecraft {
			// Pipe the command into the server process console (PID1 stdin) —
			// works with containers that keep stdin open; command travels via
			// env var so no host-side quoting/interpretation happens.
			out, err = dockerExecEnv(container, req.Command)
		} else {
			out, err = docker("exec", container, "sh", "-c", req.Command)
		}
		if err != nil && out == "" {
			writeJSON(w, map[string]any{"lines": []string{"execution failed: " + err.Error()}, "error": true})
			return
		}
		writeJSON(w, map[string]any{"lines": nonEmptyLines(out)})
	}
}

// dockerExecEnv runs a shell inside the container with the command passed via
// an environment variable (no host shell interpretation, no quote escaping).
func dockerExecEnv(container, command string) (string, error) {
	return docker("exec", "-e", "NIMBUS_CMD="+command, container, "sh", "-c", "printf '%s\\n' \"$NIMBUS_CMD\" > /proc/1/fd/0")
}
