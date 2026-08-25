#!/usr/bin/env python3
"""Generate deterministic C-alpha ANM motion assets for protein enemies."""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys
from typing import Any

import numpy as np
import scipy.linalg
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree
from scipy.sparse.linalg import eigsh


MODE_COUNT = 24
CUTOFF_ANGSTROM = 13.0
ZERO_MODE_COUNT = 6
ZERO_TOLERANCE = 1.0e-7
# 密行列として解く自由度の上限。3辺分の作業領域を確保しても数百 MB に収まる大きさ。
DENSE_SOLVER_SIZE = 4000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", nargs="?", default="assets-src/proteins/5i4r/protein.config.json")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--mode-count", type=int, default=MODE_COUNT)
    parser.add_argument("--cutoff", type=float, default=CUTOFF_ANGSTROM)
    return parser.parse_args()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: pathlib.Path, value: dict[str, Any], check: bool) -> None:
    serialized = json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if check:
        existing = path.read_text(encoding="utf-8")
        if existing != serialized:
            raise RuntimeError(f"generated output differs from {path}")
    else:
        path.write_text(serialized, encoding="utf-8")


def nearest_indices(points: np.ndarray, centers: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    tree = cKDTree(centers)
    distances, indices = tree.query(points, k=1)
    return np.asarray(indices, dtype=np.int32), np.asarray(distances, dtype=np.float64)


def nearest_indices_by_chain(points: np.ndarray, point_chains: list[str], centers: np.ndarray, center_chains: list[str]) -> tuple[np.ndarray, np.ndarray]:
    if len(points) != len(point_chains):
        raise RuntimeError("point chain count mismatch")
    result = np.empty(len(points), dtype=np.int32)
    distances = np.empty(len(points), dtype=np.float64)
    for chain in sorted(set(point_chains)):
        point_indexes = np.asarray([i for i, value in enumerate(point_chains) if value == chain], dtype=np.int32)
        center_indexes = np.asarray([i for i, value in enumerate(center_chains) if value == chain], dtype=np.int32)
        if len(center_indexes) == 0:
            raise RuntimeError(f"no motion residues for chain {chain}")
        local, local_distances = nearest_indices(points[point_indexes], centers[center_indexes])
        result[point_indexes] = center_indexes[local]
        distances[point_indexes] = local_distances
    return result, distances


def residue_data(backbone: dict[str, Any], structure: dict[str, Any]) -> tuple[np.ndarray, list[str], list[int], np.ndarray]:
    count = int(backbone["backboneCount"])
    centers = np.asarray(backbone["backboneCoordinates"], dtype=np.float64).reshape((count, 3))
    chains = list(backbone.get("backboneChains", []))
    if len(chains) != count:
        raise RuntimeError("backboneChains length does not match backboneCount")
    residue_numbers = backbone.get("backboneResidueNumbers")
    if residue_numbers is None:
        atom_centers = np.asarray(structure["atoms"]["coordinates"], dtype=np.float64).reshape((-1, 3))
        atom_chains = [structure["atoms"]["chainTable"][index] for index in structure["atoms"]["chains"]]
        nearest, distances = nearest_indices_by_chain(centers, chains, atom_centers, atom_chains)
        if float(np.max(distances)) > 0.25:
            raise RuntimeError(f"could not recover C-alpha residue numbers (max distance {float(np.max(distances)):.3f} Å)")
        residue_numbers = [int(structure["atoms"]["residueNumbers"][index]) for index in nearest]
    if len(residue_numbers) != count:
        raise RuntimeError("backboneResidueNumbers length does not match backboneCount")
    b_factors = np.asarray(backbone.get("backboneBFactors", [0.0] * count), dtype=np.float64)
    if len(b_factors) != count:
        raise RuntimeError("backboneBFactors length does not match backboneCount")
    return centers, chains, [int(value) for value in residue_numbers], b_factors


def add_hessian_block(rows: list[int], cols: list[int], values: list[float], row: int, col: int, block: np.ndarray, scale: float) -> None:
    for axis_row in range(3):
        for axis_col in range(3):
            rows.append(row * 3 + axis_row)
            cols.append(col * 3 + axis_col)
            values.append(float(block[axis_row, axis_col] * scale))


def build_hessian(centers: np.ndarray, cutoff: float) -> tuple[coo_matrix, np.ndarray]:
    pair_array = np.asarray(sorted(cKDTree(centers).query_pairs(cutoff)), dtype=np.int32)
    if pair_array.size == 0:
        raise RuntimeError("C-alpha contact graph has no edges")
    pair_array = pair_array.reshape((-1, 2))
    graph = coo_matrix(
        (np.ones(len(pair_array) * 2), (np.concatenate((pair_array[:, 0], pair_array[:, 1]), axis=0), np.concatenate((pair_array[:, 1], pair_array[:, 0]), axis=0))),
        shape=(len(centers), len(centers)),
    )
    component_count, labels = connected_components(graph, directed=False)
    if component_count != 1:
        raise RuntimeError(f"C-alpha contact graph is disconnected ({component_count} components)")

    rows: list[int] = []
    cols: list[int] = []
    values: list[float] = []
    for first, second in pair_array:
        delta = centers[second] - centers[first]
        length = float(np.linalg.norm(delta))
        if length <= 1.0e-12:
            continue
        block = np.outer(delta / length, delta / length)
        add_hessian_block(rows, cols, values, int(first), int(first), block, 1.0)
        add_hessian_block(rows, cols, values, int(second), int(second), block, 1.0)
        add_hessian_block(rows, cols, values, int(first), int(second), block, -1.0)
        add_hessian_block(rows, cols, values, int(second), int(first), block, -1.0)
    size = len(centers) * 3
    return coo_matrix((values, (rows, cols)), shape=(size, size)).tocsr(), labels


def rigid_body_basis(centers: np.ndarray) -> np.ndarray:
    centered = centers - np.mean(centers, axis=0)
    columns = [
        np.column_stack((np.ones(len(centers)), np.zeros(len(centers)), np.zeros(len(centers)))).reshape(-1),
        np.column_stack((np.zeros(len(centers)), np.ones(len(centers)), np.zeros(len(centers)))).reshape(-1),
        np.column_stack((np.zeros(len(centers)), np.zeros(len(centers)), np.ones(len(centers)))).reshape(-1),
        np.column_stack((np.zeros(len(centers)), -centered[:, 2], centered[:, 1])).reshape(-1),
        np.column_stack((centered[:, 2], np.zeros(len(centers)), -centered[:, 0])).reshape(-1),
        np.column_stack((-centered[:, 1], centered[:, 0], np.zeros(len(centers)))).reshape(-1),
    ]
    basis, _ = np.linalg.qr(np.column_stack(columns), mode="reduced")
    return basis


def canonicalize_degenerate_group(vectors: np.ndarray, tolerance: float = 1.0e-6) -> np.ndarray:
    """Choose a deterministic coordinate-projected basis for near-degenerate modes."""
    result = np.zeros_like(vectors)
    filled = 0
    for coordinate in range(vectors.shape[0]):
        projected = vectors @ vectors[coordinate, :]
        for previous in range(filled):
            projected -= result[:, previous] * float(np.dot(result[:, previous], projected))
        length = float(np.linalg.norm(projected))
        if length <= tolerance:
            continue
        result[:, filled] = projected / length
        filled += 1
        if filled == vectors.shape[1]:
            break
    if filled < vectors.shape[1]:
        for column in range(vectors.shape[1]):
            projected = vectors[:, column].copy()
            for previous in range(filled):
                projected -= result[:, previous] * float(np.dot(result[:, previous], projected))
            length = float(np.linalg.norm(projected))
            if length <= tolerance:
                continue
            result[:, filled] = projected / length
            filled += 1
            if filled == vectors.shape[1]:
                break
    if filled != vectors.shape[1]:
        raise RuntimeError("could not construct deterministic basis for degenerate eigenspace")
    for column in range(result.shape[1]):
        pivot = int(np.argmax(np.abs(result[:, column])))
        if result[pivot, column] < 0:
            result[:, column] *= -1
    return result


def canonicalize_modes(eigenvalues: np.ndarray, vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(eigenvalues, kind="stable")
    values = eigenvalues[order]
    ordered = vectors[:, order]
    result = np.zeros_like(ordered)
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and abs(values[end] - values[start]) <= max(1.0e-12, 1.0e-7 * max(abs(values[start]), abs(values[end]))):
            end += 1
        result[:, start:end] = canonicalize_degenerate_group(ordered[:, start:end])
        start = end
    return values, result


def lowest_eigenpairs(hessian: coo_matrix, requested: int) -> tuple[np.ndarray, np.ndarray]:
    """最も低い側の固有対を requested 個返す。

    小さい系では厳密に解く。反復解法のシフト反転はゼロモードの近傍で条件が悪く、
    最小の正固有値に対する残差が許容量を超えることがある。
    """
    size = hessian.shape[0]
    if size <= DENSE_SOLVER_SIZE:
        eigenvalues, eigenvectors = scipy.linalg.eigh(hessian.toarray())
        return eigenvalues[:requested], eigenvectors[:, :requested]
    return eigsh(hessian, k=requested, sigma=1.0e-9, which="LM", tol=1.0e-10, maxiter=1_000_000, v0=np.ones(size, dtype=np.float64))


def solve_modes(hessian: coo_matrix, centers: np.ndarray, mode_count: int) -> tuple[np.ndarray, np.ndarray]:
    size = hessian.shape[0]
    requested = min(size - 2, ZERO_MODE_COUNT + mode_count + 4)
    eigenvalues, eigenvectors = lowest_eigenpairs(hessian, requested)
    eigenvalues, eigenvectors = canonicalize_modes(np.asarray(eigenvalues), np.asarray(eigenvectors))
    scale = max(float(np.max(np.abs(eigenvalues))), 1.0)
    zero_count = int(np.count_nonzero(np.abs(eigenvalues) <= ZERO_TOLERANCE * scale))
    if zero_count < ZERO_MODE_COUNT or np.any(eigenvalues[ZERO_MODE_COUNT:] <= ZERO_TOLERANCE * scale):
        raise RuntimeError(f"expected six rigid-body zero modes before positive modes; eigenvalues={eigenvalues[:ZERO_MODE_COUNT + 2].tolist()}")
    positive_values = eigenvalues[ZERO_MODE_COUNT:ZERO_MODE_COUNT + mode_count]
    positive_vectors = eigenvectors[:, ZERO_MODE_COUNT:ZERO_MODE_COUNT + mode_count]
    positive_values, positive_vectors = canonicalize_modes(positive_values, positive_vectors)
    gram_error = float(np.max(np.abs(positive_vectors.T @ positive_vectors - np.eye(mode_count))))
    residuals = np.linalg.norm(hessian @ positive_vectors - positive_vectors * positive_values[None, :], axis=0)
    relative_residual = float(np.max(residuals / np.maximum(np.abs(positive_values), 1.0e-12)))
    if gram_error > 1.0e-6 or relative_residual > 1.0e-4:
        raise RuntimeError(f"invalid eigensystem: orthogonality={gram_error:.3g}, relative Hessian residual={relative_residual:.3g}")
    return positive_values, positive_vectors


def calibrated_amplitudes(values: np.ndarray, vectors: np.ndarray, chains: list[str], b_factors: np.ndarray, force_uncalibrated: bool) -> tuple[np.ndarray, str]:
    if not force_uncalibrated:
        raw_variance = 1.0 / values
        per_residue_vectors = vectors.T.reshape((len(values), -1, 3)).transpose(1, 0, 2)
        predicted_msf = np.sum((per_residue_vectors ** 2) * raw_variance[None, :, None], axis=(1, 2))
        valid = np.isfinite(b_factors) & (b_factors > 0.0)
        observed_b = np.zeros_like(b_factors)
        for chain in sorted(set(chains)):
            indexes = np.array([index for index, value in enumerate(chains) if value == chain and valid[index]], dtype=np.int32)
            if len(indexes) == 0:
                continue
            values_for_chain = b_factors[indexes]
            low, high = np.percentile(values_for_chain, [5.0, 95.0])
            observed_b[indexes] = np.clip(values_for_chain, low, high)
        observed_msf = 3.0 * observed_b / (8.0 * math.pi * math.pi)
        usable = np.isfinite(observed_msf) & (observed_msf > 0.0) & np.isfinite(predicted_msf) & (predicted_msf > 0.0)
        if np.any(usable):
            scale = float(np.median(observed_msf[usable]) / np.median(predicted_msf[usable]))
            return np.sqrt(scale / values), "b-factor-relative"
    scale = (0.25 * 0.25) * values[0]
    return np.sqrt(scale / values), "uncalibrated-display"


def display_rate(index: int, mode_count: int) -> float:
    if index < min(4, mode_count):
        denominator = max(1, min(4, mode_count) - 1)
        return 0.35 + 0.85 * index / denominator
    local_index = index - min(4, mode_count)
    local_count = max(1, mode_count - min(4, mode_count))
    return 2.0 + 10.0 * local_index / max(1, local_count - 1)


def binding_data(config: dict[str, Any], semantic: dict[str, Any], structure: dict[str, Any], centers: np.ndarray, center_chains: list[str]) -> dict[str, list[int]]:
    atom_coordinates = np.asarray(structure["atoms"]["coordinates"], dtype=np.float64).reshape((-1, 3))
    atom_chains = [structure["atoms"]["chainTable"][index] for index in structure["atoms"]["chains"]]
    atom_residues, atom_distances = nearest_indices_by_chain(atom_coordinates, atom_chains, centers, center_chains)
    if float(np.max(atom_distances)) > 20.0:
        raise RuntimeError("atom-to-residue binding exceeds 20 Å")
    surface_coordinates = np.asarray(structure["surface"]["mesh"]["position"], dtype=np.float64).reshape((-1, 3))
    surface_coordinates -= np.asarray(structure["coordinateFrame"]["centeredAt"], dtype=np.float64)
    component_chains = {component["id"]: component["chains"] for component in semantic["components"]}
    surface_components = structure["surface"]["mesh"]["component"]
    surface_chains = [str(value) for value in surface_components]
    surface_residues, surface_distances = nearest_indices_by_chain(surface_coordinates, surface_chains, centers, center_chains)
    if float(np.max(surface_distances)) > 20.0:
        raise RuntimeError("surface-to-residue binding exceeds 20 Å")

    def site_residues(items: list[dict[str, Any]]) -> list[int]:
        if len(items) == 0: return []
        positions = np.asarray([item["position"] for item in items], dtype=np.float64)
        indexes = np.empty(len(items), dtype=np.int32)
        distances = np.empty(len(items), dtype=np.float64)
        for index, item in enumerate(items):
            allowed = component_chains[item["componentId"]]
            candidates = np.asarray([i for i, chain in enumerate(center_chains) if chain in allowed], dtype=np.int32)
            local, distance = nearest_indices(positions[index:index + 1], centers[candidates])
            indexes[index], distances[index] = candidates[local[0]], distance[0]
        if float(np.max(distances)) > 50.0:
            raise RuntimeError("semantic anchor-to-residue binding exceeds 50 Å")
        return [int(value) for value in indexes]

    return {
        "atomResidues": [int(value) for value in atom_residues],
        "backboneResidues": list(range(len(centers))),
        "surfaceResidues": [int(value) for value in surface_residues],
        "siteResidues": site_residues(semantic.get("sites", [])),
        "modificationResidues": site_residues(semantic.get("modificationSlots", [])),
    }


def generate(config_path: pathlib.Path, output_path: pathlib.Path, check: bool, mode_count: int, cutoff: float) -> None:
    config = read_json(config_path)
    semantic_path = pathlib.Path(config["definitionAsset"])
    if not semantic_path.is_absolute():
        semantic_path = pathlib.Path.cwd() / semantic_path
    semantic = read_json(semantic_path)
    backbone_path = pathlib.Path(config["source"])
    structure_path = pathlib.Path(config["structureAsset"])
    if not backbone_path.is_absolute():
        backbone_path = pathlib.Path.cwd() / backbone_path
    if not structure_path.is_absolute():
        structure_path = pathlib.Path.cwd() / structure_path
    backbone = read_json(backbone_path)
    structure = read_json(structure_path)
    centers, chains, residue_numbers, b_factors = residue_data(backbone, structure)
    hessian, _ = build_hessian(centers, cutoff)
    eigenvalues, vectors = solve_modes(hessian, centers, mode_count)
    # RCSB B-factor は保持したうえで、config が明示すれば物理較正を使わず表示用振幅へ切り替える
    # (大型複合体では末端の低周波モードで較正振幅が非物理的に発散することがあるため)。
    force_uncalibrated = config.get("amplitudeCalibration") == "uncalibrated-display"
    physical_rms, calibration = calibrated_amplitudes(eigenvalues, vectors, chains, b_factors, force_uncalibrated)
    bindings = binding_data(config, semantic, structure, centers, chains)
    structure_hash = structure.get("generator", {}).get("contentHash")
    backbone_hash = backbone.get("contentHash")
    if not structure_hash or not backbone_hash:
        raise RuntimeError("structure and backbone contentHash metadata are required")
    modes = []
    for index in range(mode_count):
        mode = {
            "id": f"anm-{index + 1:02d}",
            "band": "collective" if index < 4 else "local",
            "eigenvalue": float(eigenvalues[index]),
            "displayRelaxationRate": display_rate(index, mode_count),
            "displacements": vectors[:, index].reshape((-1, 3)).astype(np.float32).reshape(-1).tolist(),
        }
        mode["physicalRmsAngstrom" if calibration == "b-factor-relative" else "displayRmsAngstrom"] = float(physical_rms[index])
        modes.append(mode)
    output = {
        "schemaVersion": 1,
        "model": "c-alpha-anm-overdamped",
        "source": {
            "pdbId": config["pdbId"],
            "structureHash": structure_hash,
            "backboneHash": backbone_hash,
            "generatorVersion": 2,
            "cutoffAngstrom": cutoff,
        },
        "residueCount": len(centers),
        "residues": {
            "chains": chains,
            "residueNumbers": residue_numbers,
            "centers": centers.astype(np.float32).reshape(-1).tolist(),
            "bFactors": b_factors.astype(np.float32).tolist(),
        },
        "bindings": bindings,
        "modes": modes,
        "display": {"sampleHz": 60, "collectiveGain": 0.55, "localGain": 0.20},
        "amplitudeCalibration": calibration,
    }
    write_json(output_path, output, check)
    print(f"{'checked' if check else 'generated'} {output_path}: {len(centers)} residues, {mode_count} modes, calibration={calibration}")


def main() -> int:
    args = parse_args()
    if args.mode_count != MODE_COUNT:
        raise SystemExit("schemaVersion 1 requires exactly 24 modes")
    config_path = pathlib.Path(args.config)
    output_path = pathlib.Path(args.output or read_json(config_path)["motionAsset"])
    if not output_path.is_absolute():
        output_path = pathlib.Path.cwd() / output_path
    try:
        generate(config_path, output_path, args.check, args.mode_count, args.cutoff)
    except Exception as error:  # pragma: no cover - CLI diagnostics
        print(f"motion generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
