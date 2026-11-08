package main

import (
	"testing"
)

// Path-traversal protection for the universal file manager.
func TestResolveBelow(t *testing.T) {
	base := "/var/lib/nimbus/services/abc123"

	ok, err := resolveBelow(base, "plugins/Foo.jar")
	if err != nil || ok != base+"/plugins/Foo.jar" {
		t.Fatalf("normal path failed: %v -> %q", err, ok)
	}

	ok, err = resolveBelow(base, "world/region/r.0.0.mca")
	if err != nil || ok != base+"/world/region/r.0.0.mca" {
		t.Fatalf("nested path failed: %v -> %q", err, ok)
	}

	// Classic traversal attempts must be rejected.
	for _, evil := range []string{"../../etc/passwd", "..\\..\\windows", "/../../etc/shadow", "plugins/../../other-service", ".."} {
		if _, err := resolveBelow(base, evil); err == nil {
			t.Fatalf("traversal accepted for %q", evil)
		}
	}

	// Root of the service dir resolves to the dir itself.
	ok, err = resolveBelow(base, "/")
	if err != nil || ok != base {
		t.Fatalf("service root failed: %v -> %q", err, ok)
	}

	// Empty path = service root.
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
