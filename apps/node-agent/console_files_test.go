package main

import (
	"strings"
	"testing"
)

// Path-traversal protection for the universal file manager.
// resolveBelow may either reject a path OR sanitize it to a path inside the
// service base — both are safe. The invariant under test: the resolved path
// NEVER escapes the base directory.
func TestResolveBelow(t *testing.T) {
	base := "/var/lib/nimbus/services/abc123"

	// Normal paths resolve to their expected locations.
	ok, err := resolveBelow(base, "plugins/Foo.jar")
	if err != nil || ok != base+"/plugins/Foo.jar" {
		t.Fatalf("normal path failed: %v -> %q", err, ok)
	}

	ok, err = resolveBelow(base, "world/region/r.0.0.mca")
	if err != nil || ok != base+"/world/region/r.0.0.mca" {
		t.Fatalf("nested path failed: %v -> %q", err, ok)
	}

	// Traversal attempts must never escape the base — rejected or sanitized.
	for _, evil := range []string{
		"../../etc/passwd",
		"..\\..\\windows",
		"/../../etc/shadow",
		"plugins/../../other-service",
		"plugins/../../../outside",
		"..",
	} {
		p, err := resolveBelow(base, evil)
		if err == nil && !strings.HasPrefix(p, base) {
			t.Fatalf("traversal escaped base for %q -> %q", evil, p)
		}
		// Rejection (err != nil) is equally acceptable.
	}

	// Root of the service dir resolves to the dir itself.
	ok, err = resolveBelow(base, "/")
	if err != nil || ok != base {
		t.Fatalf("service root failed: %v -> %q", err, ok)
	}

	ok, err = resolveBelow(base, "")
	if err != nil || ok != base {
		t.Fatalf("empty path failed: %v -> %q", err, ok)
	}
}

func TestNonEmptyLines(t *testing.T) {
	got := nonEmptyLines("a\n\nb\n")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("unexpected lines: %v", got)
	}
}
