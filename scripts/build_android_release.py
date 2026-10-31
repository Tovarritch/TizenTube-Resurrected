#!/usr/bin/env python3
"""Repack the 32-bit ARM Android TV shell with this repository's userscript.

The upstream Cobalt APK stores libchrobalt.so uncompressed and embeds the
userscript URL as a fixed-size string. This script replaces that string while
preserving each ZIP entry's compression method. Run zipalign and apksigner on
the resulting APK before distributing it.
"""

from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path


UPSTREAM_URL = b"https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v="
USERSCRIPT_URL = b"//cdn.jsdelivr.net/gh/Tovarritch/TizenTube@r37/dist/userScript.js?ve="


def is_signature_file(name: str) -> bool:
    upper = name.upper()
    if not upper.startswith("META-INF/"):
        return False
    return upper == "META-INF/MANIFEST.MF" or upper.endswith((".RSA", ".DSA", ".EC", ".SF"))


def copy_info(source: zipfile.ZipInfo) -> zipfile.ZipInfo:
    target = zipfile.ZipInfo(source.filename, source.date_time)
    target.compress_type = source.compress_type
    target.comment = source.comment
    target.extra = source.extra
    target.create_system = source.create_system
    target.create_version = source.create_version
    target.extract_version = source.extract_version
    target.flag_bits = source.flag_bits
    target.volume = source.volume
    target.internal_attr = source.internal_attr
    target.external_attr = source.external_attr
    return target


def debug_url(url: bytes) -> bytes:
    """The debug bundle (dbgs/userScript.js) at the same tag, same byte length."""
    return url.replace(b"/dist/userScript.js", b"/dbgs/userScript.js")


def patch_apk(source_path: Path, output_path: Path, debug: bool = False) -> None:
    url = debug_url(USERSCRIPT_URL) if debug else USERSCRIPT_URL
    if len(UPSTREAM_URL) != len(url):
        raise RuntimeError("Replacement URL must be the same byte length as the upstream URL")

    patched_libraries = 0
    with zipfile.ZipFile(source_path, "r") as source, zipfile.ZipFile(
        output_path, "w", allowZip64=True
    ) as output:
        abis = {
            entry.filename.split('/')[1]
            for entry in source.infolist()
            if entry.filename.startswith('lib/') and entry.filename.endswith('.so')
        }
        if abis != {'armeabi-v7a'}:
            raise RuntimeError('Only 32-bit ARM (armeabi-v7a) Android TV APKs are supported')
        dex = [source.read(entry) for entry in source.namelist() if entry.endswith('.dex')]
        if not any(b'returnyoutubedislikeapi.com' in data for data in dex):
            raise RuntimeError('Missing dislike bridge; run prepare_android_shell.py first')
        # A debug shell must never become a release, and the reverse.
        if any(b'Lapp/tizentube/DevConsole;' in data for data in dex) != debug:
            raise RuntimeError('Releases need a shell without the development console; --debug needs one with it')
        output.comment = source.comment
        for source_info in source.infolist():
            if is_signature_file(source_info.filename):
                continue

            data = source.read(source_info)
            if source_info.filename.endswith("/libchrobalt.so"):
                if source_info.compress_type != zipfile.ZIP_STORED:
                    raise RuntimeError(f"{source_info.filename} must remain uncompressed")
                occurrences = data.count(UPSTREAM_URL)
                if occurrences != 1:
                    raise RuntimeError(
                        f"Expected one userscript URL in {source_info.filename}, found {occurrences}"
                    )
                data = data.replace(UPSTREAM_URL, url)
                patched_libraries += 1

            output.writestr(copy_info(source_info), data)

    if patched_libraries != 1:
        output_path.unlink(missing_ok=True)
        raise RuntimeError(f"Expected one libchrobalt.so, patched {patched_libraries}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--debug", action="store_true",
                        help="debug APK that loads dbgs/userScript.js (needs a --debug-console shell); never release it")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    try:
        patch_apk(args.source, temporary, args.debug)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    shutil.move(temporary, args.output)


if __name__ == "__main__":
    main()
