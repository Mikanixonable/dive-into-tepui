"""寄託された mmCIF を PyMOL へ読み込み、アセット生成が使う原子の並びを与える。

鎖は label_asym_id、entity は label_entity_id、残基番号は著者番号を採る。座標の原点は
溶媒を除く全原子の重心とし、backbone と structure の双方がこの重心を共有する。
"""
from __future__ import annotations

import json
import pathlib
from typing import Any, NamedTuple

import numpy as np

# アセットへ載せる原子の範囲。代替配座は既定のものだけを採る。
MODELLED_ATOMS = "not solvent and alt ''+A"


class Atom(NamedTuple):
    """PyMOL から取り出した1原子。coord は重心を引く前の生の座標 [Å]。"""

    name: str
    residue_name: str
    residue_number: int
    chain: str
    entity: int
    b_factor: float
    element: str
    coord: tuple[float, float, float]
    polymer: bool


def bind_ligands_to_nearest_chain(atoms: list[Atom]) -> list[Atom]:
    """非ポリマーの原子を、最も近いポリマー原子と同じ鎖へ移す。

    リガンドは主鎖と別の鎖 ID を持つため、そのままでは Cα を1つも含まない鎖ができる。
    著者が与えた鎖 ID は結合先と対応しないことがあるので、位置から決める。
    """
    polymer = [atom for atom in atoms if atom.polymer]
    if not polymer or len(polymer) == len(atoms):
        return atoms
    from scipy.spatial import cKDTree

    tree = cKDTree(np.asarray([atom.coord for atom in polymer], dtype=np.float64))
    bound = []
    for atom in atoms:
        if atom.polymer:
            bound.append(atom)
            continue
        nearest = int(tree.query(np.asarray(atom.coord, dtype=np.float64), k=1)[1])
        bound.append(atom._replace(chain=polymer[nearest].chain))
    return bound


class Source(NamedTuple):
    """読み込んだ構造と、そこから決まる座標原点。"""

    object_name: str
    atoms: list[Atom]
    center: np.ndarray


def read_config(path: str) -> dict[str, Any]:
    """protein.config.json を読む。"""
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def source_file(config: dict[str, Any]) -> pathlib.Path:
    """config が指す原構造ファイルの位置を返す。未設定なら例外を投げる。"""
    value = config.get("sourceStructureFile")
    if not value:
        raise RuntimeError("sourceStructureFile is required")
    path = pathlib.Path(value)
    if not path.exists():
        raise RuntimeError(f"source structure not found: {path}; run npm run protein:fetch-source")
    return path


def load(config: dict[str, Any], object_name: str = "structure") -> Source:
    """原構造を PyMOL へ読み込み、原子の並びと座標原点を確定させる。"""
    from pymol import cmd

    cmd.feedback("disable", "all", "everything")
    cmd.delete("all")
    # 著者番号を resi へ、label_asym_id を segi へ、label_entity_id を custom へ載せる読み方。
    cmd.set("cif_use_auth", 1)
    cmd.set("retain_order", 1)
    path = source_file(config)
    cmd.load(str(path), object_name)
    cmd.remove(f"{object_name} and not ({MODELLED_ATOMS})")

    model = cmd.get_model(object_name)
    if not model.atom:
        raise RuntimeError(f"{path}: structure contains no atoms")

    polymer_indices: set[int] = set()
    cmd.iterate(f"{object_name} and polymer", "collect.add(index)", space={"collect": polymer_indices})

    atoms = [
        Atom(
            name=atom.name,
            residue_name=atom.resn.upper(),
            residue_number=int(atom.resi),
            chain=atom.segi or atom.chain or "-",
            entity=int(atom.custom) if atom.custom else 0,
            b_factor=float(atom.b),
            element=atom.symbol.upper(),
            coord=(float(atom.coord[0]), float(atom.coord[1]), float(atom.coord[2])),
            polymer=int(atom.index) in polymer_indices,
        )
        for atom in model.atom
    ]
    atoms = bind_ligands_to_nearest_chain(atoms)
    center = np.asarray([atom.coord for atom in atoms], dtype=np.float64).mean(axis=0)
    return Source(object_name=object_name, atoms=atoms, center=center)


def source_metadata(config: dict[str, Any]) -> dict[str, Any]:
    """生成物へ埋める、どの原本から作ったかの記録。"""
    return {
        "kind": "rcsb-mmcif",
        "file": str(source_file(config)),
        "format": "mmCIF",
        "model": 1,
    }


def write_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    """抽出結果を1つの JSON として書き出す。"""
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
