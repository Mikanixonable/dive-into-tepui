#!/usr/bin/env python3
"""Blender/Molecular Nodes boundary for offline protein asset authoring.

Blender being present is not enough to claim a Molecular Nodes export. If Blender is
found, the external exporter is invoked and its non-zero result is propagated. The
reproducible JSON backend is only used when Blender is absent (or explicitly bypassed
by the caller); it is never silently substituted for a failed Blender export.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="assets-src/proteins/5i4r/protein.config.json")
    parser.add_argument("--blender", default="blender")
    parser.add_argument("--require-blender", action="store_true")
    args = parser.parse_args()
    config_path = Path(args.config)
    config = json.loads(config_path.read_text())
    blender = Path(args.blender) if Path(args.blender).exists() else None
    if blender is None:
        located = shutil.which(args.blender)
        blender = Path(located) if located else None
    if blender is None and args.blender == "blender":
        for candidate in (Path("/Applications/Blender.app/Contents/MacOS/Blender"),):
            if candidate.exists():
                blender = candidate
                break
    if blender is None:
        if args.require_blender:
            raise SystemExit("Blender was not found; use npm run protein:generate for the fallback backend")
        print("Blender/Molecular Nodes unavailable; using reproducible existing-backbone backend")
        subprocess.run(["node", "tools/protein-builder/generate-protein-asset.mjs", str(config_path)], check=True)
        return 0
    exporter = Path(__file__).with_name("blender-export-protein.py")
    command = [str(blender), "--background", "--factory-startup", "--python", str(exporter), "--", "--config", str(config_path)]
    print(f"Blender found at {blender}; invoking Molecular Nodes exporter for {config['assetId']}")
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="")
    if result.returncode != 0 or "MN_EXPORT_OK" not in f"{result.stdout}\n{result.stderr}":
        raise SystemExit(f"Blender/Molecular Nodes export failed; fallback was not used")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
