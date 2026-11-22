package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
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
		PreviousContainerName string `json:"previousContainerName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	type inspectResult struct { ID string `json:"Id"`; Config struct { Image string `json:"Image"`; Env []string `json:"Env"` } `json:"Config"`; State struct { Running bool `json:"Running"`; Health *struct { Status string `json:"Status"` } `json:"Health"` } `json:"State"` }

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
	containerID, runErr := docker(args...)
	if runErr != nil {
		http.Error(w, "container installation failed: "+runErr.Error(), http.StatusBadGateway)
		return
	}
	inspectJSON, inspectErr := docker("inspect", "nimbus-"+serviceID)
	var inspected []inspectResult
	if inspectErr == nil { inspectErr = json.Unmarshal([]byte(inspectJSON), &inspected) }
	for attempt := 0; inspectErr == nil && len(inspected) > 0 && inspected[0].State.Running && inspected[0].State.Health != nil && inspected[0].State.Health.Status == "starting" && attempt < 30; attempt++ {
		time.Sleep(2 * time.Second)
		inspectJSON, inspectErr = docker("inspect", "nimbus-"+serviceID)
		inspected = nil
		if inspectErr == nil { inspectErr = json.Unmarshal([]byte(inspectJSON), &inspected) }
	}
	if inspectErr != nil || len(inspected) == 0 || !inspected[0].State.Running || inspected[0].Config.Image != req.DockerImage || (inspected[0].State.Health != nil && inspected[0].State.Health.Status != "healthy") {
		_, _ = docker("rm", "-f", "nimbus-"+serviceID)
		http.Error(w, "new container failed image/running/health verification", http.StatusBadGateway)
		return
	}
	healthStatus := "not-configured"
	if inspected[0].State.Health != nil { healthStatus = inspected[0].State.Health.Status }
	writeJSON(w, map[string]any{"status": "online", "containerId": strings.TrimSpace(containerID), "installedImage": inspected[0].Config.Image, "running": inspected[0].State.Running, "healthStatus": healthStatus})
	case "start":
		_, err := docker("start", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "online"})
	case "stop":
		_, err := docker("stop", "--time", "30", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "offline"})
	case "restart":
		_, err := docker("restart", "nimbus-"+serviceID)
		reply(w, err, map[string]string{"status": "online"})
	case "upgrade":
		if req.DockerImage == "" { http.Error(w, "missing target Docker image", http.StatusBadRequest); return }
		// Pull before touching the running container so registry failures are harmless.
		if _, err := docker("pull", req.DockerImage); err != nil { http.Error(w, "could not pull target image: "+err.Error(), http.StatusBadGateway); return }
		oldName := "nimbus-" + serviceID
		previousName := fmt.Sprintf("nimbus-prev-%s-%d", serviceID, time.Now().UnixNano())
		existingJSON, existingErr := docker("inspect", oldName)
		var existing []inspectResult
		if existingErr == nil { existingErr = json.Unmarshal([]byte(existingJSON), &existing) }
		if existingErr != nil || len(existing) == 0 {
			http.Error(w, "existing service container could not be inspected; refusing an in-place upgrade", http.StatusNotFound)
			return
		}
		// Preserve the currently running container's environment by default.
		// Explicitly supplied values override existing values without dropping
		// unrelated secrets or runtime configuration.
		environment := make(map[string]string, len(existing[0].Config.Env)+len(req.Env))
		for _, entry := range existing[0].Config.Env {
			key, value, ok := strings.Cut(entry, "=")
			if ok && key != "" { environment[key] = value }
		}
		for key, value := range req.Env {
			if strings.TrimSpace(key) != "" { environment[key] = value }
		}
		if _, err := docker("stop", "--time", "30", oldName); err != nil { http.Error(w, "could not stop existing container: "+err.Error(), http.StatusBadGateway); return }
		if _, err := docker("rename", oldName, previousName); err != nil { _, _ = docker("start", oldName); http.Error(w, "could not stage existing container: "+err.Error(), http.StatusBadGateway); return }
		rollback := func() error {
			_, _ = docker("rm", "-f", oldName)
			if _, err := docker("rename", previousName, oldName); err != nil { return err }
			if _, err := docker("start", oldName); err != nil { return err }
			return nil
		}
		args := []string{"run", "-d", "--name", oldName, "--memory", fmt.Sprintf("%dm", req.RAMMb), "--cpus", fmt.Sprintf("%.2f", float64(req.CPUPercent)/100.0), "--restart", "unless-stopped", "--security-opt", "no-new-privileges", "-v", dir + ":/data", "-w", "/data"}
		for k, v := range environment { args = append(args, "-e", k+"="+v) }
		args = append(args, req.DockerImage)
		args = append(args, req.StartupCommand...)
		containerID, runErr := docker(args...)
		if runErr != nil { if rollbackErr := rollback(); rollbackErr != nil { http.Error(w, "upgrade failed and automatic rollback needs administrator attention: "+rollbackErr.Error(), http.StatusInternalServerError); return }; http.Error(w, "new container failed to start; previous container restored: "+runErr.Error(), http.StatusBadGateway); return }
		inspectJSON, inspectErr := docker("inspect", oldName)
		var inspected []inspectResult
		if inspectErr == nil { inspectErr = json.Unmarshal([]byte(inspectJSON), &inspected) }
		// If the image defines a Docker health check, wait up to 60 seconds for it.
		for attempt := 0; inspectErr == nil && len(inspected) > 0 && inspected[0].State.Running && inspected[0].State.Health != nil && inspected[0].State.Health.Status == "starting" && attempt < 30; attempt++ {
			time.Sleep(2 * time.Second)
			inspectJSON, inspectErr = docker("inspect", oldName)
			inspected = nil
			if inspectErr == nil { inspectErr = json.Unmarshal([]byte(inspectJSON), &inspected) }
		}
		if inspectErr != nil || len(inspected) == 0 || !inspected[0].State.Running || inspected[0].Config.Image != req.DockerImage || (inspected[0].State.Health != nil && inspected[0].State.Health.Status != "healthy") {
			if rollbackErr := rollback(); rollbackErr != nil { http.Error(w, "verification failed and automatic rollback needs administrator attention: "+rollbackErr.Error(), http.StatusInternalServerError); return }
			http.Error(w, "new container did not pass image/running verification; previous container restored", http.StatusBadGateway)
			return
		}
		// Keep the previous stopped container until the API commits its database update.
		writeJSON(w, map[string]any{"status": "online", "containerId": strings.TrimSpace(containerID), "installedImage": inspected[0].Config.Image, "running": inspected[0].State.Running, "previousContainerName": previousName, "healthStatus": func() string { if inspected[0].State.Health == nil { return "not-configured" }; return inspected[0].State.Health.Status }()})
	case "upgrade-commit":
		if !strings.HasPrefix(req.PreviousContainerName, "nimbus-prev-"+serviceID+"-") { http.Error(w, "invalid previous container reference", http.StatusBadRequest); return }
		currentJSON, currentErr := docker("inspect", "nimbus-"+serviceID)
		var current []inspectResult
		if currentErr == nil { currentErr = json.Unmarshal([]byte(currentJSON), &current) }
		if currentErr != nil || len(current) == 0 || !current[0].State.Running || (req.DockerImage != "" && current[0].Config.Image != req.DockerImage) { http.Error(w, "replacement container is not verified; previous container retained", http.StatusBadGateway); return }
		if _, previousErr := docker("inspect", req.PreviousContainerName); previousErr == nil {
			if _, removeErr := docker("rm", req.PreviousContainerName); removeErr != nil { http.Error(w, "replacement is active but previous container cleanup failed: "+removeErr.Error(), http.StatusBadGateway); return }
		}
		writeJSON(w, map[string]any{"status": "committed", "previousContainerRemoved": true})
	case "upgrade-rollback":
		if !strings.HasPrefix(req.PreviousContainerName, "nimbus-prev-"+serviceID+"-") { http.Error(w, "invalid previous container reference", http.StatusBadRequest); return }
		oldName := "nimbus-" + serviceID
		_, _ = docker("rm", "-f", oldName)
		if _, renameErr := docker("rename", req.PreviousContainerName, oldName); renameErr != nil { http.Error(w, "could not restore previous container: "+renameErr.Error(), http.StatusInternalServerError); return }
		if _, startErr := docker("start", oldName); startErr != nil { http.Error(w, "previous container was restored but could not be started: "+startErr.Error(), http.StatusInternalServerError); return }
		restoredJSON, restoredErr := docker("inspect", oldName)
		var restored []inspectResult
		if restoredErr == nil { restoredErr = json.Unmarshal([]byte(restoredJSON), &restored) }
		if restoredErr != nil || len(restored) == 0 || !restored[0].State.Running { http.Error(w, "previous container did not pass running verification", http.StatusInternalServerError); return }
		writeJSON(w, map[string]any{"status": "rolled-back", "containerId": strings.TrimSpace(restored[0].ID), "running": true})
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
	case "download":
		if req.BackupID == "" || strings.ContainsAny(req.BackupID, "/\\\\") || strings.Contains(req.BackupID, "..") {
			http.Error(w, "invalid backup id", http.StatusBadRequest)
			return
		}
		in, err := os.Open(target)
		if err != nil {
			http.Error(w, "backup archive not found", http.StatusNotFound)
			return
		}
		defer in.Close()
		info, err := in.Stat()
		if err != nil {
			http.Error(w, "could not read backup metadata", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		w.Header().Set("Content-Disposition", "attachment; filename="+req.BackupID+".tar.zst")
		_, _ = io.Copy(w, in)
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
