#!/usr/bin/env python3
"""Blender-side Molecular Nodes export boundary.

This script intentionally fails before touching the scene when the required addon or
Blender version is unavailable. The actual Molecule.fetch/add_style/apply/export path
is kept here so a compatible Blender installation can be enabled without changing the
game runtime or silently producing a fallback asset.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy


def version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    return tuple(int(part) for part in (parts + ["0", "0"])[:3])


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    config = json.loads(Path(args.config).read_text())
    mn_config = config["molecularNodes"]
    required_blender = version_tuple(mn_config["minimumBlenderVersion"])
    actual_blender = tuple(bpy.app.version)
    errors = []
    if actual_blender < required_blender:
        errors.append(
            f"Blender {'.'.join(map(str, actual_blender))} is below the required "
            f"{mn_config['minimumBlenderVersion']} for Molecular Nodes {mn_config['requiredVersion']}"
        )
    try:
        import molecularnodes as mn  # type: ignore
    except Exception as exc:
        errors.append(
            f"Molecular Nodes {mn_config['requiredVersion']} is not installed in this Blender "
            f"(import error: {type(exc).__name__}: {exc})"
        )
    if errors:
        raise RuntimeError("; ".join(errors) + ". Install a compatible Molecular Nodes extension; no fallback was generated.")

    # This is the only Blender/Molecular Nodes production path. It is intentionally
    # unreachable in the current Blender 5.0.1 environment until the addon is installed.
    output = Path(config["glbOutput"])
    source = Path(config.get("sourceStructure", ""))
    if source.exists():
        mol = mn.Molecule.load(source, name=config["assetId"], remove_solvent=True)
    else:
        mol = mn.Molecule.fetch(config["pdbId"], format=".pdb", centre="centroid", remove_solvent=True)
    mol.add_style(config.get("representation", "cartoon"), color="chain", name="protein-style")
    for obj in list(bpy.context.scene.objects):
        if not obj.modifiers:
            continue
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for modifier in list(obj.modifiers):
            if modifier.type == "NODES":
                bpy.ops.object.modifier_apply(modifier=modifier.name)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_apply=True)
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError(f"Blender reported success but GLB was not written: {output}")
    print(f"MN_EXPORT_OK exported {output} using Molecular Nodes {mn_config['requiredVersion']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
