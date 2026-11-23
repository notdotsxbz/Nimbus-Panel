package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	s.mux.Handle("/backups/restore-upload/", s.auth(http.HandlerFunc(s.handleBackupRestoreUpload)))
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

func hasContainerEnvironment(entries []string, key, value string) bool {
	for _, entry := range entries {
		if entry == key+"="+value { return true }
	}
	return false
}

func minecraftLogHasVersion(logs, expected string) bool {
	if expected == "" || len(expected) > 100 { return false }
	for _, line := range strings.Split(logs, "\n") {
		lower := strings.ToLower(line)
		for _, prefix := range []string{"starting minecraft server version ", "loading minecraft "} {
			index := strings.Index(lower, prefix)
			if index < 0 { continue }
			rest := strings.TrimSpace(line[index+len(prefix):])
			fields := strings.Fields(rest)
			if len(fields) == 0 { continue }
			version := strings.Trim(fields[0], "\"'[](){}:,.")
			if version == expected { return true }
		}
	}
	return false
}

func versionOutputHasExpected(output, expected string) bool {
	expected = strings.TrimSpace(strings.TrimPrefix(expected, "v"))
	if expected == "" || len(expected) > 100 { return false }
	pattern := regexp.MustCompile(`(?i)(?:^|[^0-9])v?` + regexp.QuoteMeta(expected) + `(?:$|[^0-9])`)
	return pattern.MatchString(output)
}

func runContainerVersionProbe(container, probe string) (string, error) {
	var command []string
	switch probe {
	case "nodejs-version": command = []string{"node", "--version"}
	case "python-version":
		output, err := docker("exec", container, "python", "--version")
		if err == nil { return output, nil }
		return docker("exec", container, "python3", "--version")
	case "php-version": command = []string{"php", "--version"}
	case "go-version": command = []string{"go", "version"}
	case "java-version": command = []string{"java", "-version"}
	case "dotnet-version": command = []string{"dotnet", "--version"}
	case "mongodb-version": command = []string{"mongod", "--version"}
	default: return "", fmt.Errorf("unsupported application version probe")
	}
	args := append([]string{"exec", container}, command...)
	return docker(args...)
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
		VersionProbe string `json:"versionProbe"`
		ExpectedVersion string `json:"expectedVersion"`
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
	environmentVerified := true
	for key, value := range req.Env { if !hasContainerEnvironment(inspected[0].Config.Env, key, value) { environmentVerified = false; break } }
	if !environmentVerified {
		_, _ = docker("rm", "-f", "nimbus-"+serviceID)
		http.Error(w, "new container environment verification failed", http.StatusBadGateway)
		return
	}
	versionVerified := req.VersionProbe == ""
	if req.VersionProbe == "minecraft-log" {
		for attempt := 0; attempt < 30; attempt++ {
			logs, logErr := docker("logs", "--tail", "500", "nimbus-"+serviceID)
			if logErr == nil && minecraftLogHasVersion(logs, req.ExpectedVersion) { versionVerified = true; break }
			time.Sleep(2 * time.Second)
		}
	} else if req.VersionProbe != "" {
		for attempt := 0; attempt < 5; attempt++ {
			output, probeErr := runContainerVersionProbe("nimbus-"+serviceID, req.VersionProbe)
			if probeErr == nil && versionOutputHasExpected(output, req.ExpectedVersion) { versionVerified = true; break }
			time.Sleep(2 * time.Second)
		}
	}
	if !versionVerified {
		_, _ = docker("rm", "-f", "nimbus-"+serviceID)
		http.Error(w, "new container failed application version verification", http.StatusBadGateway)
		return
	}
	healthStatus := "not-configured"
	if inspected[0].State.Health != nil { healthStatus = inspected[0].State.Health.Status }
	writeJSON(w, map[string]any{"status": "online", "containerId": strings.TrimSpace(containerID), "installedImage": inspected[0].Config.Image, "running": inspected[0].State.Running, "healthStatus": healthStatus, "environmentVerified": environmentVerified, "versionVerified": versionVerified})
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
		environmentVerified := true
		for key, value := range req.Env { if !hasContainerEnvironment(inspected[0].Config.Env, key, value) { environmentVerified = false; break } }
		if !environmentVerified {
			if rollbackErr := rollback(); rollbackErr != nil { http.Error(w, "environment verification failed and rollback needs administrator attention: "+rollbackErr.Error(), http.StatusInternalServerError); return }
			http.Error(w, "new container environment did not match requested version settings; previous container restored", http.StatusBadGateway)
			return
		}
		versionVerified := req.VersionProbe == ""
		if req.VersionProbe == "minecraft-log" {
			for attempt := 0; attempt < 30; attempt++ {
				logs, logErr := docker("logs", "--tail", "500", oldName)
				if logErr == nil && minecraftLogHasVersion(logs, req.ExpectedVersion) { versionVerified = true; break }
				time.Sleep(2 * time.Second)
			}
		} else if req.VersionProbe != "" {
			for attempt := 0; attempt < 5; attempt++ {
				output, probeErr := runContainerVersionProbe(oldName, req.VersionProbe)
				if probeErr == nil && versionOutputHasExpected(output, req.ExpectedVersion) { versionVerified = true; break }
				time.Sleep(2 * time.Second)
			}
		}
		if !versionVerified {
			if rollbackErr := rollback(); rollbackErr != nil { http.Error(w, "application version verification failed and rollback needs administrator attention: "+rollbackErr.Error(), http.StatusInternalServerError); return }
			http.Error(w, "requested application version was not confirmed by the configured runtime probe; previous container restored", http.StatusBadGateway)
			return
		}
		// Keep the previous stopped container until the API commits its database update.
		writeJSON(w, map[string]any{"status": "online", "containerId": strings.TrimSpace(containerID), "installedImage": inspected[0].Config.Image, "running": inspected[0].State.Running, "environmentVerified": environmentVerified, "versionVerified": versionVerified, "previousContainerName": previousName, "healthStatus": func() string { if inspected[0].State.Health == nil { return "not-configured" }; return inspected[0].State.Health.Status }()})
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

// handleBackupRestoreUpload receives a checksum-verified archive as a raw stream.
func (s *AgentServer) handleBackupRestoreUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "backups" || parts[1] != "restore-upload" { http.Error(w, "bad request", http.StatusBadRequest); return }
	serviceID, backupID := parts[2], parts[3]
	if !regexp.MustCompile("^[a-fA-F0-9]{24}$").MatchString(serviceID) || !regexp.MustCompile("^[a-fA-F0-9]{24}$").MatchString(backupID) {
		http.Error(w, "invalid service or backup id", http.StatusBadRequest); return
	}
	if _, err := s.servicePath(serviceID); err != nil { http.Error(w, err.Error(), http.StatusBadRequest); return }
	expected := strings.TrimSpace(r.Header.Get("X-Nimbus-SHA256"))
	if expected == "" { http.Error(w, "missing archive checksum", http.StatusBadRequest); return }
	backupDir := filepath.Join(s.cfg.DataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil { http.Error(w, "could not prepare backup storage", http.StatusInternalServerError); return }
	target := filepath.Join(backupDir, backupID+".tar.zst")
	temp := target + ".restore-uploading"
	out, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil { http.Error(w, "restore upload is already running or temporary storage is unavailable", http.StatusConflict); return }
	keep := false
	defer func() { _ = out.Close(); if !keep { _ = os.Remove(temp) } }()
	hash := sha256.New()
	limited := http.MaxBytesReader(w, r.Body, int64(100)<<30)
	if _, err := io.Copy(io.MultiWriter(out, hash), limited); err != nil { http.Error(w, "restore archive upload failed or exceeded the 100 GiB limit", http.StatusBadRequest); return }
	if err := out.Sync(); err != nil { http.Error(w, "could not sync restore archive", http.StatusInternalServerError); return }
	if err := out.Close(); err != nil { http.Error(w, "could not close restore archive", http.StatusInternalServerError); return }
	sum := hash.Sum(nil)
	if expected != hex.EncodeToString(sum) && expected != base64.StdEncoding.EncodeToString(sum) { http.Error(w, "restore archive checksum mismatch", http.StatusBadRequest); return }
	if err := os.Rename(temp, target); err != nil { http.Error(w, "could not store verified restore archive", http.StatusInternalServerError); return }
	keep = true
	writeJSON(w, map[string]any{"uploaded": true, "backupId": backupID})
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
		if !regexp.MustCompile("^[a-fA-F0-9]{24}$").MatchString(req.BackupID) { http.Error(w, "invalid backup id", http.StatusBadRequest); return }
		staging := dir + ".restore-staging"
		if err := os.RemoveAll(staging); err != nil { http.Error(w, err.Error(), http.StatusInternalServerError); return }
		if err := os.MkdirAll(staging, 0o750); err != nil { http.Error(w, err.Error(), http.StatusInternalServerError); return }
		if err := safeExtractArchive(target, staging); err != nil {
			_ = os.RemoveAll(staging)
			http.Error(w, "restore archive rejected: "+err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]any{"staged": true, "backupId": req.BackupID})
	case "restore-commit":
		if !regexp.MustCompile("^[a-fA-F0-9]{24}$").MatchString(req.BackupID) { http.Error(w, "invalid backup id", http.StatusBadRequest); return }
		staging := dir + ".restore-staging"
		if info, err := os.Stat(staging); err != nil || !info.IsDir() { http.Error(w, "no verified restore staging directory exists", http.StatusConflict); return }
		containerName := "nimbus-" + req.ServiceID
		running := false
		if state, inspectErr := docker("inspect", "--format", "{{.State.Running}}", containerName); inspectErr == nil { running = strings.TrimSpace(state) == "true" }
		if running {
			if _, err := docker("stop", "--time", "30", containerName); err != nil { http.Error(w, "could not safely stop service before restore", http.StatusBadGateway); return }
		}
		safety := dir + ".pre-restore-" + req.BackupID
		if _, err := os.Lstat(safety); err == nil {
			if running { _, _ = docker("start", containerName) }
			http.Error(w, "a safety copy already exists for this restore; review it before retrying", http.StatusConflict); return
		}
		if err := os.Rename(dir, safety); err != nil {
			if running { _, _ = docker("start", containerName) }
			http.Error(w, "could not preserve current service data before restore", http.StatusInternalServerError); return
		}
		if err := os.Rename(staging, dir); err != nil {
			_ = os.Rename(safety, dir)
			if running { _, _ = docker("start", containerName) }
			http.Error(w, "could not activate restored data; previous data was restored", http.StatusInternalServerError); return
		}
		if running {
			if _, err := docker("start", containerName); err != nil {
				failed := dir + ".failed-restore-" + req.BackupID
				_ = os.Rename(dir, failed); _ = os.Rename(safety, dir); _, _ = docker("start", containerName)
				http.Error(w, "restored service failed to start; previous data was restored", http.StatusBadGateway); return
			}
			state, err := docker("inspect", "--format", "{{.State.Running}}", containerName)
			if err != nil || strings.TrimSpace(state) != "true" {
				_, _ = docker("stop", "--time", "10", containerName)
				failed := dir + ".failed-restore-" + req.BackupID
				_ = os.Rename(dir, failed); _ = os.Rename(safety, dir); _, _ = docker("start", containerName)
				http.Error(w, "restored service health check failed; previous data was restored", http.StatusBadGateway); return
			}
		}
		writeJSON(w, map[string]any{"restored": true, "safetyCopyPreserved": true})
	default:
		http.Error(w, "unknown operation", http.StatusNotFound)
	}
}

// safeExtractArchive extracts tar or gzip-compressed tar without unsafe paths.
func safeExtractArchive(archivePath, destination string) error {
	file, err := os.Open(archivePath); if err != nil { return err }; defer file.Close()
	buffered := bufio.NewReader(file)
	var reader io.Reader = buffered
	if header, peekErr := buffered.Peek(2); peekErr == nil && header[0] == 0x1f && header[1] == 0x8b {
		gz, gzipErr := gzip.NewReader(buffered); if gzipErr != nil { return gzipErr }; defer gz.Close(); reader = gz
	}
	root, err := filepath.Abs(destination); if err != nil { return err }
	tr := tar.NewReader(reader)
	var expanded int64
	const maxExpanded = int64(100) << 30
	for {
		header, nextErr := tr.Next(); if nextErr == io.EOF { break }; if nextErr != nil { return nextErr }
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if name == "." { continue }
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) { return fmt.Errorf("archive contains an unsafe path") }
		target := filepath.Join(root, name)
		relative, relErr := filepath.Rel(root, target)
		if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) { return fmt.Errorf("archive path escapes restore directory") }
		if err := rejectSymlinkParents(root, target); err != nil { return err }
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o750); err != nil { return err }
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || expanded > maxExpanded-header.Size { return fmt.Errorf("archive exceeds expanded-size limit") }
			expanded += header.Size
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil { return err }
			mode := os.FileMode(header.Mode) & 0o770; if mode == 0 { mode = 0o600 }
			out, openErr := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode); if openErr != nil { return openErr }
			_, copyErr := io.CopyN(out, tr, header.Size); closeErr := out.Close()
			if copyErr != nil { return copyErr }; if closeErr != nil { return closeErr }
		case tar.TypeSymlink:
			link := filepath.Clean(filepath.FromSlash(header.Linkname))
			if filepath.IsAbs(link) || link == ".." || strings.HasPrefix(link, ".."+string(os.PathSeparator)) { return fmt.Errorf("archive contains an unsafe symbolic link") }
			resolved := filepath.Clean(filepath.Join(filepath.Dir(target), link))
			rel, relErr := filepath.Rel(root, resolved)
			if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) { return fmt.Errorf("symbolic link escapes restore directory") }
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil { return err }
			if err := os.Symlink(header.Linkname, target); err != nil { return err }
		default:
			return fmt.Errorf("archive contains an unsupported special file")
		}
	}
	return nil
}

func rejectSymlinkParents(root, target string) error {
	relative, err := filepath.Rel(root, target); if err != nil { return err }
	parts := strings.Split(relative, string(os.PathSeparator))
	current := root
	for _, part := range parts[:max(0, len(parts)-1)] {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		if statErr == nil && info.Mode()&os.ModeSymlink != 0 { return fmt.Errorf("archive attempts to write through a symbolic link") }
		if statErr != nil && !os.IsNotExist(statErr) { return statErr }
	}
	return nil
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
