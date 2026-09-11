#!/usr/bin/env python3
"""Export a hash inventory for already downloaded Earth-surface inputs."""

import argparse
import datetime as dt
import json
from pathlib import Path
import sys

import importlib.util

_spec = importlib.util.spec_from_file_location("earth_surface_validate", Path(__file__).with_name("validate-source.py"))
_validate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_validate)


def export_manifest(manifest_path, raw_root, output_path, require_pinned=False):
    """Hash and export local files; no URL or response body is opened."""
    manifest = _validate.load_manifest(manifest_path)
    sources = _validate.validate_source_files(manifest, raw_root, require_pinned)
    result = {
        "schemaVersion": 1,
        "kind": "earth-surface-source-export-manifest",
        "datasetId": manifest["datasetId"],
        "sourceManifestSha256": sources["sourceManifestSha256"],
        "hashAlgorithm": "sha256",
        "createdAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "rawRoot": str(Path(raw_root)),
        "files": sources["files"],
        "unpinned": sources["unpinned"],
    }
    _validate._write_json(output_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--raw-root", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--require-pinned", action="store_true")
    args = parser.parse_args()
    result = export_manifest(args.manifest, args.raw_root, args.output, args.require_pinned)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (_validate.ValidationError, OSError) as error:
        print(f"earth-surface:export-manifest: {error}", file=sys.stderr)
        sys.exit(1)
