package main

import (
	"archive/tar"
	"os"
	"path/filepath"
	"testing"
)

func writeTestTar(t *testing.T, archivePath string, header *tar.Header, body string) {
	t.Helper()
	file, err := os.Create(archivePath)
	if err != nil { t.Fatal(err) }
	writer := tar.NewWriter(file)
	if err := writer.WriteHeader(header); err != nil { t.Fatal(err) }
	if body != "" {
		if _, err := writer.Write([]byte(body)); err != nil { t.Fatal(err) }
	}
	if err := writer.Close(); err != nil { t.Fatal(err) }
	if err := file.Close(); err != nil { t.Fatal(err) }
}

func TestExtractTarSafelyExtractsRegularFile(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "backup.tar")
	destination := filepath.Join(root, "restore")
	if err := os.Mkdir(destination, 0o750); err != nil { t.Fatal(err) }
	writeTestTar(t, archivePath, &tar.Header{Name: "./nested/config.txt", Mode: 0o640, Size: int64(len("safe")), Typeflag: tar.TypeReg}, "safe")

	if err := extractTarSafely(archivePath, destination); err != nil { t.Fatalf("extractTarSafely returned error: %v", err) }
	got, err := os.ReadFile(filepath.Join(destination, "nested", "config.txt"))
	if err != nil { t.Fatal(err) }
	if string(got) != "safe" { t.Fatalf("got %q, want %q", got, "safe") }
}

func TestExtractTarSafelyRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "malicious.tar")
	destination := filepath.Join(root, "restore")
	if err := os.Mkdir(destination, 0o750); err != nil { t.Fatal(err) }
	writeTestTar(t, archivePath, &tar.Header{Name: "../outside.txt", Mode: 0o600, Size: 4, Typeflag: tar.TypeReg}, "oops")

	if err := extractTarSafely(archivePath, destination); err == nil {
		t.Fatal("expected path traversal archive to be rejected")
	}
	if _, err := os.Stat(filepath.Join(root, "outside.txt")); !os.IsNotExist(err) {
		t.Fatal("archive wrote outside the restore directory")
	}
}

func TestExtractTarSafelyRejectsSymlinks(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "symlink.tar")
	destination := filepath.Join(root, "restore")
	if err := os.Mkdir(destination, 0o750); err != nil { t.Fatal(err) }
	writeTestTar(t, archivePath, &tar.Header{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../../outside"}, "")

	if err := extractTarSafely(archivePath, destination); err == nil {
		t.Fatal("expected symlink archive to be rejected")
	}
}
