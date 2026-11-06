package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// enrollmentClaims mirrors the JWT the Control Plane signs with the shared secret.
type enrollmentClaims struct {
	NodeID string `json:"nid"`
	JTI    string `json:"jti"`
	Exp    int64  `json:"exp"`
}

func decodeEnrollmentToken(token string) (*enrollmentClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("malformed enrollment token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	claims := &enrollmentClaims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, err
	}
	if claims.Exp != 0 && time.Now().Unix() > claims.Exp {
		return nil, fmt.Errorf("enrollment token expired")
	}
	return claims, nil
}

type heartbeat struct {
	CPUPercent        float64 `json:"cpuPercent"`
	RAMUsedBytes      uint64  `json:"ramUsedBytes"`
	RAMTotalBytes     uint64  `json:"ramTotalBytes"`
	DiskUsedBytes     uint64  `json:"diskUsedBytes"`
	DiskTotalBytes    uint64  `json:"diskTotalBytes"`
	ContainersRunning int     `json:"containersRunning"`
	UptimeSeconds     uint64  `json:"uptimeSeconds"`
	AgentVersion      string  `json:"agentVersion"`
}

const agentVersion = "1.0.0"

func collectHeartbeat() (*heartbeat, error) {
	hb := &heartbeat{AgentVersion: agentVersion, UptimeSeconds: uptimeSeconds()}

	// Memory
	if mem, err := os.ReadFile("/proc/meminfo"); err == nil {
		var total, avail uint64
		for _, line := range strings.Split(string(mem), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			switch f[0] {
			case "MemTotal:":
				fmt.Sscanf(f[1], "%d", &total)
			case "MemAvailable:":
				fmt.Sscanf(f[1], "%d", &avail)
			}
		}
		hb.RAMTotalBytes = total * 1024
		hb.RAMUsedBytes = (total - avail) * 1024
	}

	// Disk
	if st, err := os.Stat("/var/lib/nimbus"); err == nil {
		_ = st
		if usage := statfsUsage("/var/lib/nimbus"); usage != nil {
			hb.DiskUsedBytes = usage.used
			hb.DiskTotalBytes = usage.total
		}
	}

	// CPU
	if load, err := os.ReadFile("/proc/loadavg"); err == nil {
		var l1 float64
		fmt.Sscanf(string(load), "%f", &l1)
		hb.CPUPercent = l1 / float64(runtime.NumCPU()) * 100
	}

	// Containers
	if out, err := execCommand("docker", "ps", "-q", "--filter", "name=nimbus-"); err == nil {
		hb.ContainersRunning = len(nonEmptyLines(out))
	}
	return hb, nil
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

var bootTime = time.Now()

func uptimeSeconds() uint64 { return uint64(time.Since(bootTime).Seconds()) }

func execCommand(name string, args ...string) (string, error) {
	// lightweight wrapper; exec.Command is imported here to keep server.go focused
	cmd := command(name, args...)
	out, err := cmd.Output()
	return string(out), err
}

var _ io.Writer = io.Discard // keep io import for potential streaming use
