// NIMBUS Node Agent (Go)
//
// Runs on every Ubuntu/Debian compute node. Responsibilities:
//   - enroll with the Control Plane (single-use, short-lived token)
//   - report heartbeats (CPU/RAM/disk/containers)
//   - manage customer containers via the local Docker CLI (never exposes Docker API)
//   - prepare backups and perform staged restores
//   - stream container console output over authenticated WebSocket
//
// The agent NEVER grants host shell access to customer workloads and only
// accepts commands signed by the Control Plane shared secret.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// storedNodeID reads the persisted node id written next to the agent token.
func storedNodeID() (string, error) {
	raw, err := os.ReadFile("/etc/nimbus/node-id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

type Config struct {
	APIURL          string
	EnrollmentToken string
	ListenAddr      string
	NodeID          string
	AgentToken      string
	DataDir         string
}

func main() {
	cfg := &Config{}
	flag.StringVar(&cfg.APIURL, "api", os.Getenv("NIMBUS_API_URL"), "Control Plane base URL")
	flag.StringVar(&cfg.EnrollmentToken, "token", os.Getenv("NIMBUS_ENROLLMENT_TOKEN"), "single-use enrollment token")
	flag.StringVar(&cfg.ListenAddr, "listen", ":7443", "agent HTTPS listen address")
	flag.StringVar(&cfg.DataDir, "data", "/var/lib/nimbus", "service data root")
	flag.Parse()

	if cfg.APIURL == "" {
		log.Fatal("--api or NIMBUS_API_URL is required")
	}

	client := &http.Client{
		Timeout: 30 * time.Second,
		// Control Plane serves a real certificate; agents may be behind
		// self-signed setups during enrollment only.
		Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
	}

	if cfg.AgentToken == "" {
		// Survive restarts: load the credential issued at first enrollment.
		if stored, err := os.ReadFile("/etc/nimbus/agent-token"); err == nil && len(stored) > 0 {
			cfg.AgentToken = strings.TrimSpace(string(stored))
			if claims, err := storedNodeID(); err == nil {
				cfg.NodeID = claims
			}
			log.Printf("loaded existing agent credentials from /etc/nimbus/agent-token")
		} else if err := enroll(cfg, client); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		} else {
			log.Printf("enrolled successfully; credentials stored")
		}
	}

	srv := NewAgentServer(cfg)
	go heartbeatLoop(cfg, client)

	log.Printf("NIMBUS agent listening on %s", cfg.ListenAddr)
	if err := http.ListenAndServeTLS(cfg.ListenAddr, "/etc/nimbus/agent.crt", "/etc/nimbus/agent.key", srv.mux); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

// enroll exchanges the single-use enrollment token for a permanent node credential.
func enroll(cfg *Config, client *http.Client) error {
	// The control plane issued the enrollment token signed with the shared
	// secret; it contains the node id and a jti.
	claims, err := decodeEnrollmentToken(cfg.EnrollmentToken)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"nodeId": claims.NodeID, "jti": claims.JTI})
	resp, err := client.Post(cfg.APIURL+"/api/v1/nodes/agent/enroll", "application/json", bytesReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		AgentToken string `json:"agentToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.AgentToken == "" {
		return fmt.Errorf("enroll rejected (status %d)", resp.StatusCode)
	}
	cfg.NodeID = claims.NodeID
	cfg.AgentToken = out.AgentToken
	_ = os.MkdirAll("/etc/nimbus", 0o700)
	if err := os.WriteFile("/etc/nimbus/agent-token", []byte(out.AgentToken), 0o600); err != nil {
		return err
	}
	return os.WriteFile("/etc/nimbus/node-id", []byte(claims.NodeID), 0o600)
}

// heartbeatLoop reports live telemetry every 15 seconds.
func heartbeatLoop(cfg *Config, client *http.Client) {
	for {
		hb, err := collectHeartbeat()
		if err == nil {
			payload, _ := json.Marshal(hb)
			req, _ := http.NewRequest(http.MethodPut, cfg.APIURL+"/api/v1/nodes/agent/heartbeat", bytesReader(payload))
			req.Header.Set("x-nimbus-node", cfg.NodeID)
			req.Header.Set("authorization", "Bearer "+cfg.AgentToken)
			if resp, err := client.Do(req); err == nil {
				resp.Body.Close()
			}
		} else {
			log.Printf("heartbeat collection: %v", err)
		}
		time.Sleep(15 * time.Second)
	}
}
