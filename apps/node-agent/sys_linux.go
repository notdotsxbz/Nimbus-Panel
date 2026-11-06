package main

import (
	"os"
	"os/exec"
	"syscall"
)

// command is the single controlled execution point. Only fixed agent code
// paths may call it — there is no endpoint that forwards user input here.
func command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = sysProcNoShell()
	return cmd
}

func sysProcNoShell() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

type fsUsage struct{ total, used uint64 }

// statfsUsage reports disk usage for the given mount path (Linux statfs).
func statfsUsage(path string) *fsUsage {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	return &fsUsage{total: total, used: total - free}
}

var _ = os.Getenv // reserved for config overrides
