from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.archive_workspace import (
    MANIFEST_NAME,
    ArchiveError,
    archive_workspace,
    scan_source,
    _file_stat_matches,
)


def make_link(link: Path, target: Path, directory: bool) -> None:
    try:
        link.symlink_to(target, target_is_directory=directory)
        return
    except (OSError, NotImplementedError):
        if os.name == "nt" and directory:
            result = subprocess.run(
                ["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                return
        raise


class ArchiveWorkspaceTests(unittest.TestCase):
    def test_archives_regular_and_dotfiles_without_following_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            (source / ".hidden-config").write_text("private local config\n", encoding="utf-8")
            (source / "nested").mkdir()
            regular_data = (b"archive fixture content\n" * 4096)
            (source / "nested" / "payload.json").write_bytes(regular_data)
            external = base / "external-target"
            external.mkdir()
            (external / "must-not-be-archived.txt").write_text("outside", encoding="utf-8")
            link = source / "external-link"
            try:
                make_link(link, external, directory=True)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation is unavailable: {exc}")

            archive = base / "result.zip"
            manifest_path = base / "manifest.json"
            receipt_path = base / "receipt.json"
            result = archive_workspace(source, archive, manifest_path, receipt_path, progress=lambda _line: None)

            self.assertTrue(result["verified"])
            self.assertEqual(result["regular_file_count"], 2)
            self.assertEqual(result["link_count"], 1)
            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
                self.assertIn(".hidden-config", names)
                self.assertIn("nested/payload.json", names)
                self.assertNotIn("external-link/must-not-be-archived.txt", names)
                link_info = zipped.getinfo("external-link")
                self.assertTrue(stat.S_ISLNK(link_info.external_attr >> 16))
                self.assertEqual(zipped.read("nested/payload.json"), regular_data)
                embedded = json.loads(zipped.read(MANIFEST_NAME))
            self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), embedded)
            self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8"))["verified"], True)
            link_record = embedded["links"][0]
            self.assertEqual(link_record["path"], "external-link")
            self.assertIn("external-target", link_record["target"])

    def test_rejects_archive_output_inside_source_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "data.txt").write_text("safe", encoding="utf-8")
            with self.assertRaisesRegex(ArchiveError, "outside the source"):
                archive_workspace(
                    source,
                    source / "nested.zip",
                    source / "manifest.json",
                    source / "receipt.json",
                    progress=lambda _line: None,
                )
            self.assertEqual(sorted(path.name for path in source.iterdir()), ["data.txt"])

    def test_scan_records_symlink_as_link_and_not_target_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            source.mkdir()
            outside = base / "outside.txt"
            outside.write_text("do not walk", encoding="utf-8")
            link = source / "outside-link"
            try:
                make_link(link, outside, directory=False)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation is unavailable: {exc}")
            entries = scan_source(source)
            self.assertEqual([(entry.relative, entry.kind) for entry in entries], [("outside-link", "link")])

    def test_open_handle_mode_differences_do_not_hide_content_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            item = source / "readonly.exe"
            item.write_bytes(b"fixture")
            item.chmod(0o444)
            entry = scan_source(source)[0]
            fd = os.open(item, os.O_RDONLY | getattr(os, "O_BINARY", 0))
            try:
                self.assertTrue(_file_stat_matches(item, entry, os.fstat(fd)))
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
