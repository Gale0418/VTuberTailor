#!/usr/bin/env python3
"""Create and verify a conservative, local ZIP64 workspace archive.

The command line accepts explicit source, archive, manifest, and receipt paths.
The functions are also reusable by the adjacent tests with temporary roots.
Reparse points are stored as symlink-style ZIP entries and are never traversed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable


MANIFEST_NAME = "archive-manifest.json"
CHUNK_SIZE = 1024 * 1024
PROGRESS_SECONDS = 5.0
PROGRESS_FILES = 1000
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

TEXT_SUFFIXES = {
    ".c", ".cc", ".cfg", ".cmd", ".cpp", ".css", ".csv", ".cxx",
    ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".json5",
    ".jsonl", ".jsx", ".kt", ".log", ".md", ".mjs", ".mts", ".ps1",
    ".psm1", ".py", ".rst", ".rs", ".scss", ".sh", ".sql", ".svg",
    ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}


class ArchiveError(RuntimeError):
    """Raised when safe archival or complete verification cannot be assured."""


@dataclass(frozen=True)
class SourceEntry:
    relative: str
    kind: str  # regular, link, directory
    signature: tuple[int, ...]
    size: int = 0
    target: str | None = None
    link_type: str | None = None
    reparse_tag: int | None = None
    file_attributes: int = 0


def _signature(info: os.stat_result) -> tuple[int, ...]:
    return (
        int(info.st_dev), int(info.st_ino), int(info.st_mode), int(info.st_size),
        int(info.st_mtime_ns), int(info.st_ctime_ns),
        int(getattr(info, "st_file_attributes", 0)),
        int(getattr(info, "st_reparse_tag", 0)),
    )


def _zip_path(relative: str) -> str:
    pure = PurePosixPath(relative.replace("\\", "/"))
    if pure.is_absolute() or not pure.parts or any(p in {"", ".", ".."} for p in pure.parts):
        raise ArchiveError(f"unsafe relative archive path: {relative!r}")
    return pure.as_posix()


def _is_reparse(info: os.stat_result) -> bool:
    return bool(int(getattr(info, "st_file_attributes", 0)) & REPARSE_POINT)


def _read_link(path: Path, root: Path) -> tuple[str, str, str | None, int]:
    try:
        target = os.readlink(path)
    except OSError as exc:
        raise ArchiveError(f"cannot record reparse target without following it: {path}") from exc
    info = path.lstat()
    junction = bool(getattr(os.path, "isjunction", lambda _p: False)(path))
    is_symlink = stat.S_ISLNK(info.st_mode)
    link_type = "symlink" if is_symlink else ("junction" if junction else "reparse-point")
    lexical_target = Path(target)
    if not lexical_target.is_absolute():
        lexical_target = path.parent / lexical_target
    try:
        relative_target = lexical_target.relative_to(root).as_posix()
    except ValueError:
        relative_target = None
    return (
        target,
        link_type,
        relative_target,
        int(getattr(info, "st_reparse_tag", 0)),
    )


def scan_source(source: Path) -> list[SourceEntry]:
    """Walk without following links/junctions; include dirs for mutation checks."""
    root = source.absolute()
    try:
        root_info = root.lstat()
    except OSError as exc:
        raise ArchiveError(f"source is unavailable: {root}") from exc
    if not stat.S_ISDIR(root_info.st_mode) or _is_reparse(root_info):
        raise ArchiveError("source root must be a real, non-reparse directory")

    entries: list[SourceEntry] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                children = sorted(iterator, key=lambda item: item.name.casefold(), reverse=True)
        except OSError as exc:
            raise ArchiveError(f"cannot enumerate source directory: {directory}") from exc
        for child in children:
            path = Path(child.path)
            rel = path.relative_to(root).as_posix()
            _zip_path(rel)
            try:
                # Path.lstat preserves Windows file identity fields; DirEntry.stat
                # may return zero device/inode values on that platform.
                info = path.lstat()
            except OSError as exc:
                raise ArchiveError(f"cannot stat source entry: {rel}") from exc
            attrs = int(getattr(info, "st_file_attributes", 0))
            if child.is_symlink() or _is_reparse(info):
                target, link_type, relative_target, reparse_tag = _read_link(path, root)
                entries.append(SourceEntry(
                    rel, "link", _signature(info), target=target,
                    link_type=link_type, reparse_tag=reparse_tag,
                    file_attributes=attrs,
                ))
            elif stat.S_ISDIR(info.st_mode):
                entries.append(SourceEntry(rel, "directory", _signature(info)))
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                entries.append(SourceEntry(rel, "regular", _signature(info), size=info.st_size))
            else:
                raise ArchiveError(f"unsupported non-regular source entry: {rel}")
    return sorted(entries, key=lambda item: item.relative.casefold())


def _git_summary(source: Path) -> dict[str, object]:
    try:
        head = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(source), "status", "--porcelain=v1", "-uno"],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.splitlines()
        full_status = subprocess.run(
            ["git", "-C", str(source), "status", "--porcelain=v1"],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.splitlines()
        modified = sum(1 for line in status if line[:2].strip())
        untracked = sum(1 for line in full_status if line.startswith("??"))
        return {
            "head": head,
            "tracked_changed_count": modified,
            "untracked_count": untracked,
            "porcelain_status_line_count": len(full_status),
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "error_type": type(exc).__name__}


def _source_snapshot(entries: Iterable[SourceEntry]) -> dict[str, tuple[int, ...]]:
    return {entry.relative: entry.signature for entry in entries}


def _assert_no_reparse_ancestors(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    for ancestor in reversed((absolute, *absolute.parents)):
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            continue
        if _is_reparse(info):
            raise ArchiveError(f"path crosses a reparse point: {ancestor}")


def _compression_for(relative: str) -> int:
    return zipfile.ZIP_DEFLATED if Path(relative).suffix.lower() in TEXT_SUFFIXES else zipfile.ZIP_STORED


def _file_stat_matches(path: Path, expected: SourceEntry, opened_info: os.stat_result | None = None) -> bool:
    try:
        current = path.lstat()
    except OSError:
        return False
    if _signature(current) != expected.signature or not stat.S_ISREG(current.st_mode) or _is_reparse(current):
        return False
    if opened_info is None:
        return True
    opened = _signature(opened_info)
    # Windows can report st_ctime with a slightly different resolution for an
    # open handle than for lstat. Compare stable identity/content fields here;
    # full lstat signatures are still compared before and after the read.
    comparable_opened = (
        opened[0], opened[1], stat.S_IFMT(opened[2]), opened[3], opened[4],
        opened[6], opened[7],
    )
    comparable_expected = (
        expected.signature[0], expected.signature[1], stat.S_IFMT(expected.signature[2]),
        expected.signature[3], expected.signature[4], expected.signature[6],
        expected.signature[7],
    )
    return comparable_opened == comparable_expected


def _progress(now: float, previous: float, files: int, byte_count: int, started: float) -> float:
    if files % PROGRESS_FILES == 0 or now - previous >= PROGRESS_SECONDS:
        elapsed = max(now - started, 0.001)
        print(f"archive progress: {files:,} files, {byte_count:,} source bytes, {byte_count / elapsed / 1048576:.1f} MiB/s", flush=True)
        return now
    return previous


def _archive_records(entries: list[SourceEntry]) -> list[SourceEntry]:
    return [entry for entry in entries if entry.kind in {"regular", "link"}]


def _record_for_link(entry: SourceEntry, source: Path) -> dict[str, object]:
    link_path = source.joinpath(*PurePosixPath(entry.relative).parts)
    target, link_type, relative_target, reparse_tag = _read_link(link_path, source)
    if target != entry.target or entry.signature != _signature(link_path.lstat()):
        raise ArchiveError(f"source link changed during archive: {entry.relative}")
    return {
        "path": entry.relative,
        "type": "link",
        "target": target,
        "relative_target": relative_target,
        "link_type": link_type,
        "reparse_tag": reparse_tag,
        "file_attributes": entry.file_attributes,
        "zip_representation": "Unix symlink entry; payload is target text; Windows junction is not auto-restored by ZIP extraction",
        "size": len(target.encode("utf-8", errors="surrogatepass")),
        "sha256": hashlib.sha256(target.encode("utf-8", errors="surrogatepass")).hexdigest(),
    }


def _manifest(
    source: Path,
    archive_path: Path,
    entries: list[SourceEntry],
    files: list[dict[str, object]],
    links: list[dict[str, object]],
    prior_incomplete_archives: list[str],
) -> dict[str, object]:
    regular = [entry for entry in entries if entry.kind == "regular"]
    return {
        "format": "puppetloom-full-archive-v1",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source_root": str(source),
        "archive_path": str(archive_path),
        "source_file_count": len(regular),
        "source_file_bytes": sum(entry.size for entry in regular),
        "link_count": len(links),
        "links": links,
        "files": files,
        "git": _git_summary(source),
        "prior_incomplete_archives": [
            {"path": path, "verified": False} for path in prior_incomplete_archives
        ],
        "reparse_policy": "Never followed. Links are stored as Unix symlink ZIP entries and listed with original targets and Windows reparse metadata.",
    }


def _write_json_exclusive(path: Path, data: dict[str, object]) -> None:
    payload = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def archive_workspace(
    source: Path,
    archive_path: Path,
    manifest_path: Path,
    receipt_path: Path,
    progress: Callable[[str], None] = print,
    prior_incomplete_archives: list[str] | None = None,
) -> dict[str, object]:
    source = source.absolute()
    archive_path = archive_path.absolute()
    manifest_path = manifest_path.absolute()
    receipt_path = receipt_path.absolute()
    _assert_no_reparse_ancestors(archive_path.parent)
    _assert_no_reparse_ancestors(manifest_path.parent)
    _assert_no_reparse_ancestors(receipt_path.parent)
    source_real = source.resolve(strict=True)
    archive_parent_real = archive_path.parent.resolve(strict=False)
    if archive_path == source_real or source_real in archive_path.parents or archive_parent_real == source_real or source_real in archive_parent_real.parents:
        raise ArchiveError("archive destination must be outside the source tree")
    if any(p.exists() for p in (archive_path, manifest_path, receipt_path)):
        raise ArchiveError("refusing to overwrite an existing archive, manifest, or receipt")
    if archive_parent_real.exists() and _is_reparse(archive_parent_real.lstat()):
        raise ArchiveError("archive parent must not be a reparse point")

    root_signature = _signature(source.lstat())
    initial = scan_source(source)
    source_snapshot = _source_snapshot(initial)
    regular = [entry for entry in initial if entry.kind == "regular"]
    links_src = [entry for entry in initial if entry.kind == "link"]
    total_bytes = sum(entry.size for entry in regular)
    file_records: list[dict[str, object]] = []
    link_records: list[dict[str, object]] = []
    hashed_bytes = 0
    started = time.monotonic()
    last_progress = started
    archived_files = 0
    archive_parent_real.mkdir(parents=True, exist_ok=True)
    if _is_reparse(archive_parent_real.lstat()):
        raise ArchiveError("archive parent must not be a reparse point")

    progress(f"archive start: {len(regular):,} regular files, {len(links_src):,} reparse links, {total_bytes:,} bytes")
    try:
        with zipfile.ZipFile(archive_path, mode="x", allowZip64=True, compresslevel=1) as archive:
            for entry in [e for e in initial if e.kind in {"regular", "link"}]:
                rel = _zip_path(entry.relative)
                if entry.kind == "link":
                    record = _record_for_link(entry, source)
                    info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    info.compress_type = zipfile.ZIP_STORED
                    archive.writestr(info, entry.target.encode("utf-8", errors="surrogatepass"))
                    link_records.append(record)
                    archived_files += 1
                    continue

                path = source.joinpath(*PurePosixPath(entry.relative).parts)
                if not _file_stat_matches(path, entry):
                    raise ArchiveError(f"source changed before read: {entry.relative}")
                flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(path, flags)
                try:
                    with os.fdopen(fd, "rb", closefd=False) as source_stream:
                        before = os.fstat(fd)
                        if not _file_stat_matches(path, entry, before):
                            raise ArchiveError(
                                f"source changed while opening: {entry.relative}; "
                                f"expected={entry.signature!r}; fd={_signature(before)!r}; "
                                f"path={_signature(path.lstat())!r}"
                            )
                        info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
                        info.compress_type = _compression_for(rel)
                        info._compresslevel = 1 if info.compress_type == zipfile.ZIP_DEFLATED else None
                        info.external_attr = ((stat.S_IFREG | (before.st_mode & 0o777)) << 16)
                        info.create_system = 3
                        hasher = hashlib.sha256()
                        file_bytes = 0
                        with archive.open(info, mode="w", force_zip64=True) as dest:
                            while True:
                                chunk = source_stream.read(CHUNK_SIZE)
                                if not chunk:
                                    break
                                dest.write(chunk)
                                hasher.update(chunk)
                                hashed_bytes += len(chunk)
                                file_bytes += len(chunk)
                                now = time.monotonic()
                                if now - last_progress >= PROGRESS_SECONDS:
                                    last_progress = _progress(now, last_progress, archived_files, hashed_bytes, started)
                        after_fd = os.fstat(fd)
                        if not _file_stat_matches(path, entry, after_fd):
                            raise ArchiveError(f"source changed during read: {entry.relative}")
                        if file_bytes != entry.size:
                            raise ArchiveError(f"source file truncated during read: {entry.relative}")
                        file_records.append({
                            "path": entry.relative,
                            "size": entry.size,
                            "sha256": hasher.hexdigest(),
                            "compression": "deflate-level-1" if info.compress_type == zipfile.ZIP_DEFLATED else "stored",
                        })
                finally:
                    os.close(fd)
                archived_files += 1
                now = time.monotonic()
                last_progress = _progress(now, last_progress, archived_files, hashed_bytes, started)

            after_scan = scan_source(source)
            if _source_snapshot(after_scan) != source_snapshot or _signature(source.lstat()) != root_signature:
                raise ArchiveError("source inventory or stat metadata changed during archive creation")
            manifest = _manifest(
                source, archive_path, initial, file_records, link_records,
                prior_incomplete_archives or [],
            )
            archive.writestr(
                MANIFEST_NAME,
                (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=1,
            )
    except Exception:
        progress("archive incomplete: no verified receipt written; any partial archive was left in place")
        raise

    progress("archive write complete; verifying every ZIP file entry and manifest...")
    archive_stat_before = _signature(archive_path.stat())
    with zipfile.ZipFile(archive_path, mode="r") as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ArchiveError("ZIP contains duplicate entry names")
        if names.count(MANIFEST_NAME) != 1:
            raise ArchiveError("embedded manifest is missing or duplicated")
        embedded = json.loads(archive.read(MANIFEST_NAME))
        expected_regular = {record["path"]: record for record in embedded["files"]}
        expected_links = {record["path"]: record for record in embedded["links"]}
        if len(expected_regular) != embedded["source_file_count"]:
            raise ArchiveError("manifest regular-file count mismatch")
        if len(expected_links) != embedded["link_count"]:
            raise ArchiveError("manifest link count mismatch")
        expected_names = set(expected_regular) | set(expected_links) | {MANIFEST_NAME}
        if set(names) != expected_names:
            raise ArchiveError("ZIP entry set does not match the embedded manifest")
        verified_bytes = 0
        verified_files = 0
        for name, record in expected_regular.items():
            digest = hashlib.sha256()
            size = 0
            with archive.open(name, "r") as entry_stream:
                while True:
                    chunk = entry_stream.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    digest.update(chunk)
                    size += len(chunk)
            if size != record["size"] or digest.hexdigest() != record["sha256"]:
                raise ArchiveError(f"ZIP content hash/size mismatch: {name}")
            verified_bytes += size
            verified_files += 1
            now = time.monotonic()
            if now - last_progress >= PROGRESS_SECONDS:
                progress(f"verify progress: {verified_files:,}/{len(expected_regular):,} files, {verified_bytes:,} bytes")
                last_progress = now
        for name, record in expected_links.items():
            payload = archive.read(name)
            digest = hashlib.sha256(payload).hexdigest()
            if payload.decode("utf-8", errors="surrogatepass") != record["target"] or digest != record["sha256"]:
                raise ArchiveError(f"ZIP link representation mismatch: {name}")
        if verified_files != embedded["source_file_count"] or verified_bytes != embedded["source_file_bytes"]:
            raise ArchiveError("verified file count or byte total differs from manifest")

    archive_sha = hashlib.sha256()
    hash_started = time.monotonic()
    hash_progress = hash_started
    archive_hash_bytes = 0
    with archive_path.open("rb") as archive_stream:
        while True:
            block = archive_stream.read(CHUNK_SIZE)
            if not block:
                break
            archive_sha.update(block)
            archive_hash_bytes += len(block)
            now = time.monotonic()
            if now - hash_progress >= PROGRESS_SECONDS:
                progress(
                    f"archive hash progress: {archive_hash_bytes:,} bytes, "
                    f"{archive_hash_bytes / max(now - hash_started, 0.001) / 1048576:.1f} MiB/s"
                )
                hash_progress = now
    if _signature(archive_path.stat()) != archive_stat_before:
        raise ArchiveError("archive changed during final verification")

    _write_json_exclusive(manifest_path, embedded)
    receipt = {
        "verified": True,
        "verified_utc": datetime.now(timezone.utc).isoformat(),
        "archive_path": str(archive_path),
        "archive_size_bytes": archive_path.stat().st_size,
        "archive_sha256": archive_sha.hexdigest(),
        "manifest_path": str(manifest_path),
        "embedded_manifest": MANIFEST_NAME,
        "prior_incomplete_archives": [
            {"path": path, "verified": False}
            for path in (prior_incomplete_archives or [])
        ],
        "regular_file_count": embedded["source_file_count"],
        "regular_file_bytes": embedded["source_file_bytes"],
        "link_count": embedded["link_count"],
        "zip_entry_count_including_manifest": len(names),
    }
    _write_json_exclusive(receipt_path, receipt)
    progress(f"verified archive: {receipt['regular_file_count']:,} files, {receipt['regular_file_bytes']:,} bytes, sha256 {receipt['archive_sha256']}")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="source directory to archive")
    parser.add_argument("--archive", type=Path, required=True, help="new ZIP64 output path; existing files are refused")
    parser.add_argument("--manifest", type=Path, required=True, help="external manifest path")
    parser.add_argument("--receipt", type=Path, required=True, help="external verified receipt path")
    parser.add_argument(
        "--prior-incomplete-archive", action="append", default=[],
        help="previous failed archive path to mark unverified in manifest and receipt",
    )
    args = parser.parse_args()
    result = archive_workspace(
        args.source, args.archive, args.manifest, args.receipt,
        prior_incomplete_archives=args.prior_incomplete_archive,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ArchiveError as exc:
        print(f"archive error: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(2)
