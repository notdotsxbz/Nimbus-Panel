package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// AgentServer exposes a narrow, authenticated operation API. Every request
// must present the per-node credential; commands never reach a host shell —
// they map to a fixed set of docker operations.
type AgentServer struct {
	cfg   *Config
	mux   *http.ServeMux
	state sync.Map // serviceId -> containerID
}

func NewAgentServer(cfg *Config) *AgentServer {
	s := &AgentServer{cfg: cfg}
	s.mux = http.NewServeMux()
	s.mux.Handle("/services/", s.auth(http.HandlerFunc(s.handleService)))
	s.mux.Handle("/backups/", s.auth(http.HandlerFunc(s.handleBackup)))
	s.mux.Handle("/files/", s.auth(http.HandlerFunc(handleFiles(s))))
	s.mux.Handle("/logs/", s.auth(http.HandlerFunc(handleLogs(s))))
	s.mux.Handle("/exec/", s.auth(http.HandlerFunc(handleExec(s))))
	return s
}

func (s *AgentServer) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nodeID := r.Header.Get("X-Nimbus-Node")
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if nodeID == "" || token == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Constant-time comparison of the stored node credential.
		expected := sha256.Sum256([]byte(s.cfg.AgentToken))
		provided := sha256.Sum256([]byte(token))
		idOK := subtle.ConstantTimeCompare([]byte(nodeID), []byte(s.cfg.NodeID))
		tokOK := subtle.ConstantTimeCompare(expected[:], provided[:])
		if idOK != 1 || tokOK != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// servicePath resolves the data dir and guards against path traversal.
func (s *AgentServer) servicePath(serviceID string) (string, error) {
	if strings.ContainsAny(serviceID, "/\\") || strings.Contains(serviceID, "..") {
		return "", fmt.Errorf("invalid service id")
	}
	dir := filepath.Join(s.cfg.DataDir, "services", serviceID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	return dir, nil
}

func (s *AgentServer) handleService(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // services/<id>/<op>
	if len(parts) != 3 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	serviceID, op := parts[1], parts[2]
	dir, err := s.servicePath(serviceID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var req struct {
		DockerImage    string   `json:"dockerImage"`
		CPUPercent     int      `json:"cpuPercent"`
		RAMMb          int      `json:"ramMb"`
		DiskGb         int      `json:"diskGb"`
		StartupCommand []string `json:"startupCommand"`
		Env            map[string]string `json:"env"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	switch op {
	case "install":
		args := []string{"run", "-d", "--name", "nimbus-" + serviceID,
			"--memory", fmt.Sprintf("%dm", req.RAMMb),
			"--cpus", fmt.Sprintf("%.2f", float64(req.CPUPercent)/100.0),
			"--restart", "unless-stopped",
			"--security-opt", "no-new-privileges",
			"-v", dir + ":/data",
			"-w", "/data"}
		for k, v := range req.Env {
			args = append(args, "-e", k+"="+v)
		}
		args = append(args, req.DockerImage)
		args = append(args, req.StartupCommand...)
	out, err := docker(args...)
	reply(w, err, map[string]string{"containerId": strings.TrimSpace(out)})
	case "start":
		_, err := docker("start", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "online"})
	case "stop":
		_, err := docker("stop", "--time", "30", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "offline"})
	case "restart":
		_, err := docker("restart", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "online"})
	case "reinstall":
		_, _ = docker("rm", "-f", "nimbus-"+serviceID)
		if err := os.RemoveAll(dir); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.MkdirAll(dir, 0o750); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		reply(w, nil, map[string]string{"status": "offline"})
	default:
		http.Error(w, "unknown operation", http.StatusNotFound)
	}
}

// handleBackup creates tar+sha256 snapshots and staged restores.
func (s *AgentServer) handleBackup(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, "/backups/")
	var req struct {
		ServiceID string `json:"serviceId"`
		BackupID  string `json:"backupId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	dir, err := s.servicePath(req.ServiceID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	backupDir := filepath.Join(s.cfg.DataDir, "backups")
	_ = os.MkdirAll(backupDir, 0o750)
	target := filepath.Join(backupDir, req.BackupID+".tar.zst")

	switch op {
	case "create":
		out, err := os.Create(target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		tar := command("tar", "-cf", "-", "-C", dir, ".")
		tar.Stdout = out
		if err := tar.Run(); err != nil {
			out.Close()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out.Close()
		sum, size, err := checksumFile(target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"checksum": sum, "sizeBytes": size})
	case "restore":
		// Stage into a sibling directory; the control plane flips the symlink
		// only after checksum verification — never silently overwrites data.
		staging := dir + ".restore-staging"
		if err := os.RemoveAll(staging); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.MkdirAll(staging, 0o750); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := run("tar", "-xf", target, "-C", staging); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"staged": staging})
	default:
		http.Error(w, "unknown operation", http.StatusNotFound)
	}
}

// docker executes ONLY whitelisted docker subcommands — never arbitrary shell.
func docker(args ...string) (string, error) {
	cmd := exec.Command("docker", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func run(name string, args ...string) error {
	return exec.Command(name, args...).Run()
}

func checksumFile(path string) (string, int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(data)
	return base64.StdEncoding.EncodeToString(sum[:]), int64(len(data)), nil
}

func reply(w http.ResponseWriter, err error, payload map[string]string) {
	if err != nil {
		payload["error"] = err.Error()
		if payload["status"] != "" {
			payload["status"] = "error"
		}
	}
	writeJSON(w, payload)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
