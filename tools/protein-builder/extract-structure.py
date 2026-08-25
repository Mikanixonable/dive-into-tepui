#!/usr/bin/env python3
"""全原子・共有結合・分子表面を寄託構造から取り出し、--output へ書く。

分子表面は半径 1.4 Å の溶媒分子が入り込めない領域の境界を、三角形メッシュで表したもの。
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import tempfile

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pymol_source

ELEMENTS = ["H", "C", "N", "O", "F", "P", "S", "CL", "SE", "MG", "ZN", "NA", "CA", "FE", "K"]
VDW_RADII = {
    "H": 1.20, "C": 1.70, "N": 1.55, "O": 1.52, "F": 1.47, "P": 1.80, "S": 1.80, "CL": 1.75,
    "SE": 1.90, "MG": 1.73, "ZN": 1.39, "NA": 2.27, "CA": 2.31, "FE": 1.56, "K": 2.75,
}
# Kyte-Doolittle 疎水性指標 [-4.5, 4.5]。
HYDROPHOBICITY = {
    "ALA": 1.8, "ARG": -4.5, "ASN": -3.5, "ASP": -3.5, "CYS": 2.5, "GLN": -3.5, "GLU": -3.5,
    "GLY": -0.4, "HIS": -3.2, "ILE": 4.5, "LEU": 3.8, "LYS": -3.9, "MET": 1.9, "PHE": 2.8,
    "PRO": -1.6, "SER": -0.8, "THR": -0.7, "TRP": -0.9, "TYR": -1.3, "VAL": 4.2,
}
RESIDUE_CHARGE = {"ASP": -1.0, "GLU": -1.0, "LYS": 1.0, "ARG": 1.0, "HIS": 0.1}
SOLVENT_RADIUS = 1.4
# 表面の頂点は 4 桁で丸め、同じ格子点に落ちたものを同一頂点として溶接する。
SURFACE_DIGITS = 4
# 回転も平行移動もしない視点。この視点でだけ、書き出される頂点がモデル座標と一致する。
IDENTITY_VIEW = (1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -100, 0, 0, 0, 40, 160, -20)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def encode_atoms(source: pymol_source.Source) -> dict:
    """原子の属性を、表を引く形の並びへ符号化する。"""
    chain_table = sorted({atom.chain for atom in source.atoms})
    residue_table = sorted({atom.residue_name for atom in source.atoms})
    chain_code = {value: index for index, value in enumerate(chain_table)}
    residue_code = {value: index for index, value in enumerate(residue_table)}
    element_code = {value: index for index, value in enumerate(ELEMENTS)}

    unknown = sorted({atom.element for atom in source.atoms if atom.element not in element_code})
    if unknown:
        raise RuntimeError(f"unsupported elements in structure: {', '.join(unknown)}")

    coordinates: list[float] = []
    for atom in source.atoms:
        position = np.asarray(atom.coord, dtype=np.float64) - source.center
        coordinates.extend(round(float(value), 3) for value in position)
    return {
        "count": len(source.atoms),
        "elementTable": ELEMENTS,
        "elements": [element_code[atom.element] for atom in source.atoms],
        "coordinates": coordinates,
        "radiusTable": [VDW_RADII[element] for element in ELEMENTS],
        "radiusCodes": [element_code[atom.element] for atom in source.atoms],
        "chainTable": chain_table,
        "chains": [chain_code[atom.chain] for atom in source.atoms],
        "entities": [atom.entity for atom in source.atoms],
        "bFactors": [round(atom.b_factor, 2) for atom in source.atoms],
        "residueTable": residue_table,
        "residues": [residue_code[atom.residue_name] for atom in source.atoms],
        "residueNumbers": [atom.residue_number for atom in source.atoms],
    }


def encode_bonds(object_name: str) -> dict:
    """PyMOL が保持する共有結合表を、原子の添字の対へ符号化する。"""
    from pymol import cmd

    model = cmd.get_model(object_name)
    pairs: list[tuple[int, int, int]] = []
    for bond in model.bond:
        first, second = int(bond.index[0]), int(bond.index[1])
        if first == second:
            continue
        pairs.append((min(first, second), max(first, second), int(bond.order)))
    pairs = sorted(set(pairs))
    return {
        "count": len(pairs),
        "pairs": [index for pair in pairs for index in pair[:2]],
        "orders": [pair[2] for pair in pairs],
        "inference": "covalent bonds as resolved by the molecular viewer from the deposited model",
    }


def read_obj_triangles(path: pathlib.Path) -> tuple[np.ndarray, np.ndarray]:
    """書き出された OBJ から、三角形ごとの頂点座標と面の並びを読む。"""
    positions: list[tuple[float, float, float]] = []
    corners: list[int] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("v "):
                parts = line.split()
                positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif line.startswith("f "):
                for token in line.split()[1:4]:
                    corners.append(int(token.split("/")[0]) - 1)
    if not positions or not corners:
        raise RuntimeError("molecular surface produced no triangles")
    return np.asarray(positions, dtype=np.float64), np.asarray(corners, dtype=np.int64)


def encode_surface(config: dict, source: pymol_source.Source) -> dict:
    """分子表面を求め、頂点を溶接した閉じたメッシュへ符号化する。"""
    from pymol import cmd

    cmd.set("surface_quality", int(config.get("surfaceQuality", 0)))
    cmd.set("solvent_radius", SOLVENT_RADIUS)
    # 溶媒分子が入り込めない境界を採る。1 にすると溶媒中心が描く外側の面になる。
    cmd.set("surface_solvent", 0)
    cmd.show_as("surface", source.object_name)
    cmd.set_view(IDENTITY_VIEW)
    cmd.refresh()

    exported = pathlib.Path(tempfile.mkdtemp()) / "surface.obj"
    cmd.save(str(exported), source.object_name)
    raw_positions, corners = read_obj_triangles(exported)
    exported.unlink()
    exported.parent.rmdir()

    # 三角形ごとに複製された頂点を束ねる。座標を丸めてから束ねると、隣り合う別々の頂点が
    # 同一視されて辺が3枚以上の三角形に共有され、閉じた面でなくなる。
    vertices, inverse = np.unique(raw_positions, axis=0, return_inverse=True)
    triangles = inverse[corners].reshape((-1, 3))
    degenerate = (triangles[:, 0] == triangles[:, 1]) | (triangles[:, 1] == triangles[:, 2]) | (triangles[:, 2] == triangles[:, 0])
    triangles = triangles[~degenerate]
    # 同じ頂点集合の三角形が二重に張られた箇所を落とす。残すと同一面が重なって描かれる。
    _, first_occurrence = np.unique(np.sort(triangles, axis=1), axis=0, return_index=True)
    triangles = triangles[np.sort(first_occurrence)]

    # 頂点の電荷・疎水性・構成要素は、最も近い原子の残基から決まる。
    atom_positions = np.asarray([atom.coord for atom in source.atoms], dtype=np.float64)
    nearest = cKDTree(atom_positions).query(vertices, k=1)[1]
    residue_names = [source.atoms[index].residue_name for index in nearest]
    # 頂点は原構造の座標のまま置く。原子側と違って重心を引かないのは、読み手が
    # coordinateFrame.centeredAt を引いて位置を合わせる約束になっているため。
    return {
        "mesh": {
            "position": [round(float(value), SURFACE_DIGITS) for value in vertices.reshape(-1)],
            "index": [int(value) for value in triangles.reshape(-1)],
            "charge": [round(RESIDUE_CHARGE.get(name, 0.0) * 127) for name in residue_names],
            "hydrophobicity": [round(max(-1.0, min(1.0, HYDROPHOBICITY.get(name, 0.0) / 4.5)) * 127) for name in residue_names],
            "component": [source.atoms[index].chain for index in nearest],
        },
        "metadata": {
            "method": f"solvent-excluded molecular surface with a {SOLVENT_RADIUS} angstrom probe, with residue Kyte-Doolittle hydrophobicity and formal-charge approximation",
            "hydrophobicityRange": [-127, 127],
            "surfaceChargeRange": [-127, 127],
        },
    }


def encode_ribbon(source: pymol_source.Source) -> dict:
    """カートゥーン表現を焼き込み、頂点ごとに最も近い原子の鎖を添えたメッシュへ符号化する。

    リガンドは分子模型表示が別途描くため、主鎖(polymer)だけをカートゥーンへ含める。
    """
    from pymol import cmd

    cmd.show_as("cartoon", f"{source.object_name} and polymer")
    cmd.hide("everything", f"{source.object_name} and not polymer")
    cmd.set_view(IDENTITY_VIEW)
    cmd.refresh()

    exported = pathlib.Path(tempfile.mkdtemp()) / "ribbon.obj"
    cmd.save(str(exported), source.object_name)
    raw_positions, corners = read_obj_triangles(exported)
    exported.unlink()
    exported.parent.rmdir()

    vertices, inverse = np.unique(raw_positions, axis=0, return_inverse=True)
    triangles = inverse[corners].reshape((-1, 3))
    degenerate = (triangles[:, 0] == triangles[:, 1]) | (triangles[:, 1] == triangles[:, 2]) | (triangles[:, 2] == triangles[:, 0])
    triangles = triangles[~degenerate]
    _, first_occurrence = np.unique(np.sort(triangles, axis=1), axis=0, return_index=True)
    triangles = triangles[np.sort(first_occurrence)]

    atom_positions = np.asarray([atom.coord for atom in source.atoms], dtype=np.float64)
    nearest = cKDTree(atom_positions).query(vertices, k=1)[1]
    return {
        "mesh": {
            "position": [round(float(value), SURFACE_DIGITS) for value in vertices.reshape(-1)],
            "index": [int(value) for value in triangles.reshape(-1)],
            "chain": [source.atoms[index].chain for index in nearest],
        },
    }


def main() -> int:
    arguments = parse_args()
    config = pymol_source.read_config(arguments.config)
    source = pymol_source.load(config)
    atoms = encode_atoms(source)
    bonds = encode_bonds(source.object_name)
    surface = encode_surface(config, source)
    ribbon = encode_ribbon(source)
    output = {
        "schemaVersion": 1,
        "id": f"{config['assetId']}-structure",
        "pdbId": config["pdbId"],
        "source": pymol_source.source_metadata(config),
        "coordinateFrame": {"units": "angstrom", "centeredAt": [round(float(value), 3) for value in source.center]},
        "coverage": "all-atom",
        "atoms": atoms,
        "bonds": bonds,
        "surface": surface,
        "ribbon": ribbon,
        "generator": {"name": "extract-structure.py", "version": 5},
    }
    pymol_source.write_json(pathlib.Path(arguments.output), output)
    print(f"extracted {atoms['count']} atoms, {bonds['count']} bonds, {len(surface['mesh']['index']) // 3} surface triangles, {len(ribbon['mesh']['index']) // 3} ribbon triangles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
