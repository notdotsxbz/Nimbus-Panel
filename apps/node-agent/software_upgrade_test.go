package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installFakeDocker(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "docker.log")
	script := `#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  pull)
    [ "${FAIL_PULL:-0}" = "1" ] && exit 1
    exit 0
    ;;
  inspect)
    if [ "${UNHEALTHY:-0}" = "1" ]; then
      echo '[{"Config":{"Image":"new:1","Env":["TOKEN=existing-secret","MODE=production"]},"State":{"Running":true,"Health":{"Status":"unhealthy"}}}]'
    else
      echo '[{"Config":{"Image":"new:1","Env":["TOKEN=existing-secret","MODE=production"]},"State":{"Running":true}}]'
    fi
    exit 0
    ;;
  run)
    [ "${FAIL_RUN:-0}" = "1" ] && exit 1
    echo "new-container-id"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`
	dockerPath := filepath.Join(dir, "docker")
	if err := os.WriteFile(dockerPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("DOCKER_LOG", logPath)
	return logPath
}

func runUpgradeRequest(t *testing.T, server *AgentServer) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"dockerImage": "new:1", "cpuPercent": 50, "ramMb": 512,
		"diskGb": 5, "startupCommand": []string{}, "env": map[string]string{},
	})
	if err != nil { t.Fatal(err) }
	req := httptest.NewRequest(http.MethodPost, "/services/svc-test/upgrade", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleService(rec, req)
	return rec
}

func TestSoftwareUpgradePullsAndVerifiesReplacement(t *testing.T) {
	logPath := installFakeDocker(t)
	dataDir := t.TempDir()
	server := NewAgentServer(&Config{DataDir: dataDir, AgentToken: "test-token", NodeID: "node-test"})
	rec := runUpgradeRequest(t, server)
	if rec.Code != http.StatusOK { t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String()) }
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil { t.Fatal(err) }
	if result["status"] != "online" || result["installedImage"] != "new:1" || result["running"] != true {
		t.Fatalf("unexpected upgrade response: %#v", result)
	}
	log, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	commands := string(log)
	if !strings.Contains(commands, "pull new:1") || !strings.Contains(commands, "stop --time 30 nimbus-svc-test") || !strings.Contains(commands, "rename nimbus-svc-test nimbus-prev-") {
		t.Fatalf("expected pull, stop, and rename sequence; commands: %s", commands)
	}
	if !strings.Contains(commands, "-e TOKEN=existing-secret") || !strings.Contains(commands, "-e MODE=production") {
		t.Fatalf("upgrade must preserve existing container environment variables; commands: %s", commands)
	}
	previousName, ok := result["previousContainerName"].(string)
	if !ok || !strings.HasPrefix(previousName, "nimbus-prev-svc-test-") { t.Fatalf("expected previous container reference in response: %#v", result) }
	if strings.Contains(commands, "rm "+previousName) { t.Fatalf("previous container must remain until API commit; commands: %s", commands) }
	expectedMount := "-v " + filepath.Join(dataDir, "services", "svc-test") + ":/data"
	if !strings.Contains(commands, expectedMount) {
		t.Fatalf("expected existing service data directory to be reused; commands: %s", commands)
	}
}

func TestSoftwareUpgradeCommitRemovesPreviousContainer(t *testing.T) {
	logPath := installFakeDocker(t)
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	body := []byte(`{"dockerImage":"new:1","previousContainerName":"nimbus-prev-svc-test-123"}`)
	req := httptest.NewRequest(http.MethodPost, "/services/svc-test/upgrade-commit", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleService(rec, req)
	if rec.Code != http.StatusOK { t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String()) }
	log, err := os.ReadFile(logPath); if err != nil { t.Fatal(err) }
	if !strings.Contains(string(log), "rm nimbus-prev-svc-test-123") { t.Fatalf("expected old container removal on commit: %s", string(log)) }
}

func TestSoftwareUpgradeRollbackRestoresPreviousContainer(t *testing.T) {
	logPath := installFakeDocker(t)
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	body := []byte(`{"previousContainerName":"nimbus-prev-svc-test-123"}`)
	req := httptest.NewRequest(http.MethodPost, "/services/svc-test/upgrade-rollback", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleService(rec, req)
	if rec.Code != http.StatusOK { t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String()) }
	log, err := os.ReadFile(logPath); if err != nil { t.Fatal(err) }
	commands := string(log)
	if !strings.Contains(commands, "rm -f nimbus-svc-test") || !strings.Contains(commands, "rename nimbus-prev-svc-test-123 nimbus-svc-test") || !strings.Contains(commands, "start nimbus-svc-test") { t.Fatalf("expected previous container restore sequence: %s", commands) }
}
func TestSoftwareUpgradeRestoresPreviousContainerWhenRunFails(t *testing.T) {
	logPath := installFakeDocker(t)
	t.Setenv("FAIL_RUN", "1")
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	rec := runUpgradeRequest(t, server)
	if rec.Code != http.StatusBadGateway { t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String()) }
	if !strings.Contains(rec.Body.String(), "previous container restored") { t.Fatalf("rollback response missing: %s", rec.Body.String()) }
	log, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	commands := string(log)
	if !strings.Contains(commands, "rename nimbus-prev-") || !strings.Contains(commands, "start nimbus-svc-test") {
		t.Fatalf("expected previous container rename and restart; commands: %s", commands)
	}
}

func TestSoftwareUpgradeDoesNotStopServiceWhenPullFails(t *testing.T) {
	logPath := installFakeDocker(t)
	t.Setenv("FAIL_PULL", "1")
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	rec := runUpgradeRequest(t, server)
	if rec.Code != http.StatusBadGateway { t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String()) }
	log, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	commands := string(log)
	if strings.Contains(commands, "stop --time") || strings.Contains(commands, "rename ") {
		t.Fatalf("service must not be stopped before target image is pulled; commands: %s", commands)
	}
}

func TestSoftwareUpgradeRollsBackUnhealthyReplacement(t *testing.T) {
	logPath := installFakeDocker(t)
	t.Setenv("UNHEALTHY", "1")
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	rec := runUpgradeRequest(t, server)
	if rec.Code != http.StatusBadGateway { t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String()) }
	log, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	if !strings.Contains(string(log), "start nimbus-svc-test") { t.Fatalf("expected rollback restart, commands: %s", string(log)) }
}

func TestServiceInstallCreatesAndVerifiesContainer(t *testing.T) {
	logPath := installFakeDocker(t)
	server := NewAgentServer(&Config{DataDir: t.TempDir(), AgentToken: "test-token", NodeID: "node-test"})
	body := []byte(`{"dockerImage":"new:1","cpuPercent":50,"ramMb":512,"diskGb":5,"startupCommand":[],"env":{"APP_ENV":"production"}}`)
	req := httptest.NewRequest(http.MethodPost, "/services/svc-test/install", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleService(rec, req)
	if rec.Code != http.StatusOK { t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String()) }
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil { t.Fatal(err) }
	if result["status"] != "online" || result["running"] != true || result["installedImage"] != "new:1" || result["containerId"] != "new-container-id" {
		t.Fatalf("unexpected install verification response: %#v", result)
	}
	log, err := os.ReadFile(logPath); if err != nil { t.Fatal(err) }
	if !strings.Contains(string(log), "run -d --name nimbus-svc-test") || !strings.Contains(string(log), "-e APP_ENV=production") || !strings.Contains(string(log), "inspect nimbus-svc-test") {
		t.Fatalf("expected create, environment and inspect verification commands: %s", string(log))
	}
}
