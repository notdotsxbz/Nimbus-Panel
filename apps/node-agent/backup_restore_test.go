package main

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type restoreTestEntry struct {
	header tar.Header
	body   string
}

func writeRestoreTestArchive(t *testing.T, path string, entries []restoreTestEntry) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	for _, entry := range entries {
		header := entry.header
		if header.Size == 0 && entry.body != "" {
			header.Size = int64(len(entry.body))
		}
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if entry.body != "" {
			if _, err := writer.Write([]byte(entry.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSafeExtractArchiveRestoresRegularFiles(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "valid.tar")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, archive, []restoreTestEntry{
		{header: tar.Header{Name: "config", Typeflag: tar.TypeDir, Mode: 0o750}},
		{header: tar.Header{Name: "config/settings.txt", Typeflag: tar.TypeReg, Mode: 0o600}, body: "safe"},
	})
	if err := safeExtractArchive(archive, destination); err != nil {
		t.Fatalf("valid archive rejected: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(destination, "config", "settings.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "safe" {
		t.Fatalf("unexpected restored contents %q", string(got))
	}
}

func TestSafeExtractArchiveSupportsGzip(t *testing.T) {
	root := t.TempDir()
	plain := filepath.Join(root, "plain.tar")
	compressed := filepath.Join(root, "compressed.tar.gz")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, plain, []restoreTestEntry{
		{header: tar.Header{Name: "compressed.txt", Typeflag: tar.TypeReg, Mode: 0o600}, body: "gzip archive"},
	})
	in, err := os.Open(plain)
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.Create(compressed)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(out)
	if _, err := io.Copy(gz, in); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	_ = in.Close()
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	if err := safeExtractArchive(compressed, destination); err != nil {
		t.Fatalf("gzip archive rejected: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(destination, "compressed.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "gzip archive" {
		t.Fatalf("unexpected restored contents %q", string(got))
	}
}

func TestSafeExtractArchiveRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "traversal.tar")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, archive, []restoreTestEntry{
		{header: tar.Header{Name: "../escape.txt", Typeflag: tar.TypeReg, Mode: 0o600}, body: "no"},
	})
	if err := safeExtractArchive(archive, destination); err == nil {
		t.Fatal("expected path traversal archive to be rejected")
	}
	if _, err := os.Stat(filepath.Join(root, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("archive wrote outside the restore directory")
	}
}

func TestSafeExtractArchiveRejectsEscapingSymlinks(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "symlink.tar")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, archive, []restoreTestEntry{
		{header: tar.Header{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../outside"}},
	})
	if err := safeExtractArchive(archive, destination); err == nil {
		t.Fatal("expected escaping symbolic link to be rejected")
	}
}

func TestSafeExtractArchiveRejectsDirectoryThroughSymlink(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "symlink-directory.tar")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, archive, []restoreTestEntry{
		{header: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "inside"}},
		{header: tar.Header{Name: "link", Typeflag: tar.TypeDir, Mode: 0o750}},
	})
	if err := safeExtractArchive(archive, destination); err == nil {
		t.Fatal("expected directory entry over symbolic link to be rejected")
	}
}

func TestSafeExtractArchiveRejectsWritesThroughSymlinks(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "symlink-parent.tar")
	destination := filepath.Join(root, "restore")
	if err := os.MkdirAll(destination, 0o750); err != nil {
		t.Fatal(err)
	}
	writeRestoreTestArchive(t, archive, []restoreTestEntry{
		{header: tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "inside"}},
		{header: tar.Header{Name: "link/payload.txt", Typeflag: tar.TypeReg, Mode: 0o600}, body: "no"},
	})
	if err := safeExtractArchive(archive, destination); err == nil {
		t.Fatal("expected write through symbolic link to be rejected")
	}
}
