#!/usr/bin/env python3
"""Cα 主鎖の座標・二次構造・B-factor を寄託構造から取り出し、--output へ書く。

二次構造は座標から判定する。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pymol_source

# PyMOL の二次構造記号を、リボンが扱う3種へ対応付ける。
SECONDARY_KINDS = {"H": "helix", "S": "sheet"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    config = pymol_source.read_config(arguments.config)
    source = pymol_source.load(config)

    from pymol import cmd

    cmd.dss(source.object_name)

    # 残基ごとに Cα と、断面の幅方向を決めるカルボニル酸素を集める。
    labelled: list[tuple[str, str, str, str]] = []
    cmd.iterate(
        f"{source.object_name} and polymer and name CA",
        "collect.append((segi, chain, resi, ss))",
        space={"collect": labelled},
    )
    secondary = {(segi or chain or "-", int(resi)): kind for segi, chain, resi, kind in labelled}
    oxygen: dict[tuple[str, int], tuple[float, float, float]] = {}
    for atom in source.atoms:
        if atom.name == "O":
            oxygen.setdefault((atom.chain, atom.residue_number), atom.coord)

    backbone = [atom for atom in source.atoms if atom.name == "CA"]
    seen: set[tuple[str, int]] = set()
    ordered = []
    for atom in backbone:
        key = (atom.chain, atom.residue_number)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(atom)
    if not ordered:
        raise RuntimeError("structure contains no C-alpha atoms")

    coordinates: list[float] = []
    oxygen_coordinates: list[float] = []
    kinds: list[str] = []
    chains: list[str] = []
    residue_numbers: list[int] = []
    entities: list[int] = []
    b_factors: list[float] = []
    for atom in ordered:
        key = (atom.chain, atom.residue_number)
        position = np.asarray(atom.coord, dtype=np.float64) - source.center
        # 酸素が欠けた残基では Cα を代わりに置き、幅方向の決定を呼び出し先へ委ねる。
        carbonyl = np.asarray(oxygen.get(key, atom.coord), dtype=np.float64) - source.center
        coordinates.extend(round(float(value), 3) for value in position)
        oxygen_coordinates.extend(round(float(value), 3) for value in carbonyl)
        kinds.append(SECONDARY_KINDS.get(secondary.get(key, ""), "coil"))
        chains.append(atom.chain)
        residue_numbers.append(atom.residue_number)
        entities.append(atom.entity)
        b_factors.append(round(atom.b_factor, 2))

    output = {
        "pdbId": config["pdbId"],
        "source": pymol_source.source_metadata(config),
        "model": "C-alpha backbone coordinates with coordinate-derived secondary structure, centered at the all-atom centroid",
        "atomCount": len(source.atoms),
        "backboneCount": len(ordered),
        "backboneCoordinates": coordinates,
        "backboneSecondary": kinds,
        "backboneChains": chains,
        "backboneResidueNumbers": residue_numbers,
        "backboneEntities": entities,
        "backboneBFactors": b_factors,
        "backboneOCoordinates": oxygen_coordinates,
    }
    pymol_source.write_json(pathlib.Path(arguments.output), output)
    print(f"extracted {len(ordered)} backbone residues from {pymol_source.source_file(config)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
