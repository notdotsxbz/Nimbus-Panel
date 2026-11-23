package main

import (
	"archive/tar"
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
	"regexp"
	"strings"
	"strconv"
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
	s.mux.Handle("/backups/upload", s.auth(http.HandlerFunc(s.handleBackupUpload)))
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
	pattern := regexp.MustCompile(`(?i)(^|[^0-9])v?` + regexp.QuoteMeta(expected) + `($|[^0-9])`)
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

// handleBackup creates verified service archives and performs staged, rollback-safe restores.
func (s *AgentServer) handleBackup(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, "/backups/")
	var req struct {
		ServiceID string `json:"serviceId"`
		BackupID  string `json:"backupId"`
		Checksum  string `json:"checksum"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid backup request", http.StatusBadRequest)
		return
	}
	validServiceID := regexp.MustCompile(`^[a-f0-9]{24}package main

import (
	"archive/tar"
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
	"regexp"
	"strings"
	"strconv"
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
	s.mux.Handle("/backups/upload", s.auth(http.HandlerFunc(s.handleBackupUpload)))
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
	pattern := regexp.MustCompile(`(?i)(^|[^0-9])v?` + regexp.QuoteMeta(expected) + `($|[^0-9])`)
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

// handleBackup creates verified service archives and performs staged, rollback-safe restores.
func (s *AgentServer) handleBackup(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, "/backups/")
	var req struct {
		ServiceID string `json:"serviceId"`
		BackupID  string `json:"backupId"`
		Checksum  string `json:"checksum"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid backup request", http.StatusBadRequest)
		return
	}
).MatchString(req.ServiceID)
	validBackupID := regexp.MustCompile(`^[a-f0-9]{24}package main

import (
	"archive/tar"
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
	"regexp"
	"strings"
	"strconv"
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
	s.mux.Handle("/backups/upload", s.auth(http.HandlerFunc(s.handleBackupUpload)))
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
	pattern := regexp.MustCompile(`(?i)(^|[^0-9])v?` + regexp.QuoteMeta(expected) + `($|[^0-9])`)
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

// handleBackup creates verified service archives and performs staged, rollback-safe restores.
func (s *AgentServer) handleBackup(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, "/backups/")
	var req struct {
		ServiceID string `json:"serviceId"`
		BackupID  string `json:"backupId"`
		Checksum  string `json:"checksum"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid backup request", http.StatusBadRequest)
		return
	}
).MatchString(req.BackupID)
	safetyBackupID := regexp.MustCompile(`^pre-restore-[a-f0-9]{24}-[0-9]+package main

import (
	"archive/tar"
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
	"regexp"
	"strings"
	"strconv"
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
	s.mux.Handle("/backups/upload", s.auth(http.HandlerFunc(s.handleBackupUpload)))
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
	pattern := regexp.MustCompile(`(?i)(^|[^0-9])v?` + regexp.QuoteMeta(expected) + `($|[^0-9])`)
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

// handleBackup creates verified service archives and performs staged, rollback-safe restores.
func (s *AgentServer) handleBackup(w http.ResponseWriter, r *http.Request) {
	op := strings.TrimPrefix(r.URL.Path, "/backups/")
	var req struct {
		ServiceID string `json:"serviceId"`
		BackupID  string `json:"backupId"`
		Checksum  string `json:"checksum"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid backup request", http.StatusBadRequest)
		return
	}
).MatchString(req.BackupID)
	if !validServiceID || (!validBackupID && !safetyBackupID) ||
		(safetyBackupID && op != "download" && op != "delete") {
		http.Error(w, "invalid service or backup id", http.StatusBadRequest)
		return
	}
	dir, err := s.servicePath(req.ServiceID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	backupDir := filepath.Join(s.cfg.DataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		http.Error(w, "could not prepare backup directory", http.StatusInternalServerError)
		return
	}
	target := filepath.Join(backupDir, req.BackupID+".tar")

	switch op {
	case "create":
		if _, err := os.Stat(target); err == nil {
			http.Error(w, "backup id already exists", http.StatusConflict)
			return
		}
		if err := createTarArchive(dir, target); err != nil {
			_ = os.Remove(target)
			http.Error(w, "could not create service archive: "+err.Error(), http.StatusInternalServerError)
			return
		}
		sum, size, err := checksumFile(target)
		if err != nil {
			_ = os.Remove(target)
			http.Error(w, "could not verify service archive", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"checksum": sum, "sizeBytes": size})
	case "download":
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
		w.Header().Set("Content-Disposition", "attachment; filename="+req.BackupID+".tar")
		_, _ = io.Copy(w, in)
	case "delete":
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			http.Error(w, "could not delete local backup archive", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"deleted": true})
	case "restore":
		if req.Checksum == "" {
			http.Error(w, "expected archive checksum is required", http.StatusBadRequest)
			return
		}
		actualChecksum, _, err := checksumFile(target)
		if err != nil || actualChecksum != req.Checksum {
			http.Error(w, "backup archive checksum verification failed", http.StatusBadRequest)
			return
		}

		// Determine whether the service container was running so its state can
		// be preserved across the data-directory replacement.
		containerName := "nimbus-" + req.ServiceID
		containerJSON, inspectErr := docker("inspect", containerName)
		hadContainer := inspectErr == nil
		wasRunning := false
		if hadContainer {
			var inspected []struct {
				State struct { Running bool `json:"Running"` } `json:"State"`
			}
			if json.Unmarshal([]byte(containerJSON), &inspected) != nil || len(inspected) == 0 {
				http.Error(w, "could not inspect service container safely", http.StatusBadGateway)
				return
			}
			wasRunning = inspected[0].State.Running
			if wasRunning {
				if _, err := docker("stop", "--time", "30", containerName); err != nil {
					http.Error(w, "could not stop service before restore: "+err.Error(), http.StatusBadGateway)
					return
				}
			}
		}

		restartOriginal := func() {
			if hadContainer && wasRunning { _, _ = docker("start", containerName) }
		}
		safetyID := "pre-restore-" + req.BackupID + "-" + fmt.Sprint(time.Now().Unix())
		safetyArchive := filepath.Join(backupDir, safetyID+".tar")
		if err := createTarArchive(dir, safetyArchive); err != nil {
			restartOriginal()
			http.Error(w, "could not create safety backup; restore cancelled: "+err.Error(), http.StatusInternalServerError)
			return
		}
		safetyChecksum, safetySize, err := checksumFile(safetyArchive)
		if err != nil {
			restartOriginal()
			http.Error(w, "could not verify safety backup; restore cancelled", http.StatusInternalServerError)
			return
		}

		staging := dir + ".restore-staging-" + req.BackupID
		if err := os.RemoveAll(staging); err != nil {
			restartOriginal()
			http.Error(w, "could not prepare restore staging directory", http.StatusInternalServerError)
			return
		}
		if err := os.MkdirAll(staging, 0o750); err != nil {
			restartOriginal()
			http.Error(w, "could not create restore staging directory", http.StatusInternalServerError)
			return
		}
		if err := extractTarSafely(target, staging); err != nil {
			_ = os.RemoveAll(staging)
			restartOriginal()
			http.Error(w, "backup archive was rejected: "+err.Error(), http.StatusBadRequest)
			return
		}

		previous := dir + ".restore-previous-" + req.BackupID
		if _, err := os.Stat(previous); err == nil {
			_ = os.RemoveAll(staging)
			restartOriginal()
			http.Error(w, "restore safety path already exists; refusing to overwrite it", http.StatusConflict)
			return
		}
		if err := os.Rename(dir, previous); err != nil {
			_ = os.RemoveAll(staging)
			restartOriginal()
			http.Error(w, "could not stage current service data: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(staging, dir); err != nil {
			rollbackErr := os.Rename(previous, dir)
			restartOriginal()
			if rollbackErr != nil {
				http.Error(w, "could not activate restored data and automatic rollback failed: "+rollbackErr.Error(), http.StatusInternalServerError)
				return
			}
			http.Error(w, "could not activate restored data: "+err.Error(), http.StatusInternalServerError)
			return
		}

		if hadContainer && wasRunning {
			if _, err := docker("start", containerName); err != nil {
				failedDir := dir + ".restore-failed-" + req.BackupID
				_ = os.Rename(dir, failedDir)
				rollbackErr := os.Rename(previous, dir)
				_, restartErr := docker("start", containerName)
				if rollbackErr != nil || restartErr != nil {
					http.Error(w, "restore failed and automatic rollback needs administrator attention; safety archive: "+safetyID, http.StatusInternalServerError)
					return
				}
				http.Error(w, "restored service failed to start; previous data was restored; safety archive: "+safetyID, http.StatusBadGateway)
				return
			}
			verifyJSON, verifyErr := docker("inspect", containerName)
			var verify []struct { State struct { Running bool `json:"Running"` } `json:"State"` }
			if verifyErr != nil || json.Unmarshal([]byte(verifyJSON), &verify) != nil || len(verify) == 0 || !verify[0].State.Running {
				if verifyErr != nil || len(verify) == 0 {
					http.Error(w, "restored service state could not be inspected; data was left in place and safety archive is "+safetyID, http.StatusInternalServerError)
					return
				}
				if verify[0].State.Running {
					if _, stopErr := docker("stop", "--time", "10", containerName); stopErr != nil {
						http.Error(w, "restored service failed verification and could not be stopped for rollback; safety archive: "+safetyID, http.StatusInternalServerError)
						return
					}
				}
				failedDir := dir + ".restore-failed-" + req.BackupID
				if renameErr := os.Rename(dir, failedDir); renameErr != nil {
					http.Error(w, "restored service failed verification and rollback could not stage the failed data; safety archive: "+safetyID, http.StatusInternalServerError)
					return
				}
				rollbackErr := os.Rename(previous, dir)
				_, restartErr := docker("start", containerName)
				if rollbackErr != nil || restartErr != nil {
					http.Error(w, "restored service health check failed and rollback needs administrator attention; safety archive: "+safetyID, http.StatusInternalServerError)
					return
				}
				http.Error(w, "restored service failed health verification; previous data was restored; safety archive: "+safetyID, http.StatusBadGateway)
				return
			}
		}
		_ = os.RemoveAll(previous)
		writeJSON(w, map[string]any{
			"status": "restored",
			"checksumVerified": true,
			"serviceRunning": wasRunning,
			"safetyBackupId": safetyID,
			"safetyBackupChecksum": safetyChecksum,
			"safetyBackupSizeBytes": safetySize,
			"safetyBackupSizeBytes": safetySize,
		})
	default:
		http.Error(w, "unknown operation", http.StatusNotFound)
	}
}

// handleBackupUpload streams a verified Drive archive onto the node for a restore.
func (s *AgentServer) handleBackupUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	serviceID := query.Get("serviceId")
	backupID := query.Get("backupId")
	expectedChecksum := query.Get("checksum")
	expectedSize, sizeErr := strconv.ParseInt(query.Get("sizeBytes"), 10, 64)
	if !regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(serviceID) ||
		!regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(backupID) ||
		expectedChecksum == "" || sizeErr != nil || expectedSize <= 0 {
		http.Error(w, "invalid backup upload metadata", http.StatusBadRequest)
		return
	}
	if _, err := s.servicePath(serviceID); err != nil {
		http.Error(w, "invalid service id", http.StatusBadRequest)
		return
	}
	backupDir := filepath.Join(s.cfg.DataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		http.Error(w, "could not prepare backup directory", http.StatusInternalServerError)
		return
	}
	target := filepath.Join(backupDir, backupID+".tar")
	if existingChecksum, existingSize, err := checksumFile(target); err == nil {
		if existingChecksum == expectedChecksum && existingSize == expectedSize {
			writeJSON(w, map[string]any{"uploaded": true, "alreadyPresent": true, "sizeBytes": existingSize, "checksum": existingChecksum})
			return
		}
		http.Error(w, "a different archive already exists for this backup id", http.StatusConflict)
		return
	}
	temp, err := os.CreateTemp(backupDir, backupID+".upload-*.tmp")
	if err != nil {
		http.Error(w, "could not create temporary backup file", http.StatusInternalServerError)
		return
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(temp, hash), http.MaxBytesReader(w, r.Body, expectedSize+1))
	syncErr := temp.Sync()
	closeErr := temp.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		http.Error(w, "backup stream could not be written safely", http.StatusInternalServerError)
		return
	}
	digest := hash.Sum(nil)
	base64Checksum := base64.StdEncoding.EncodeToString(digest)
	hexChecksum := fmt.Sprintf("%x", digest)
	if size != expectedSize || (base64Checksum != expectedChecksum && hexChecksum != expectedChecksum) {
		http.Error(w, "uploaded archive size or checksum did not match the backup manifest", http.StatusBadRequest)
		return
	}
	if err := os.Link(tempPath, target); err != nil {
		http.Error(w, "could not finalize uploaded backup archive without overwriting an existing file", http.StatusConflict)
		return
	}
	writeJSON(w, map[string]any{"uploaded": true, "sizeBytes": size, "checksum": base64Checksum})
}

// createTarArchive writes a plain tar archive without buffering the archive in memory.
func createTarArchive(sourceDir, target string) error {
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil { return err }
	cmd := exec.Command("tar", "-cf", "-", "-C", sourceDir, ".")
	cmd.Stdout = out
	runErr := cmd.Run()
	closeErr := out.Close()
	if runErr != nil { return runErr }
	return closeErr
}

// extractTarSafely rejects absolute paths, traversal, links and special files.
// Rejecting links prevents an archive entry from redirecting later writes outside staging.
func extractTarSafely(archivePath, destination string) error {
	in, err := os.Open(archivePath)
	if err != nil { return err }
	defer in.Close()
	reader := tar.NewReader(in)
	for {
		header, err := reader.Next()
		if err == io.EOF { break }
		if err != nil { return err }
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if name == "." { continue }
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("archive contains an unsafe path")
		}
		target := filepath.Join(destination, name)
		relative, err := filepath.Rel(destination, target)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("archive path escapes the restore directory")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o750); err != nil { return err }
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil { return err }
			mode := os.FileMode(header.Mode) & 0o750
			if mode == 0 { mode = 0o600 }
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil { return err }
			_, copyErr := io.Copy(out, reader)
			closeErr := out.Close()
			if copyErr != nil { return copyErr }
			if closeErr != nil { return closeErr }
		default:
			return fmt.Errorf("archive contains unsupported links or special files")
		}
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
	file, err := os.Open(path)
	if err != nil { return "", 0, err }
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil { return "", 0, err }
	return base64.StdEncoding.EncodeToString(hash.Sum(nil)), size, nil
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
