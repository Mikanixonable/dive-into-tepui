#!/usr/bin/env python3
"""並列プロセスで全球の実データタイルbundleを生成する。

``bake.py`` の逐次writerと同じwire形式・manifestを使い、重い実データの
タイル再標本化だけをプロセス並列化する。出力は最後に一度だけstagingから
切り替えるので、途中で停止しても既存bundleを壊さない。
"""

from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import sys

import bake
from real_renderer import create_real_renderer


_WORKER_RENDERER = None


def _init_worker(manifest, raw_root):
    """各workerでGDAL/NetCDFのsource adapterを一度だけ構築する。"""
    global _WORKER_RENDERER
    _WORKER_RENDERER = create_real_renderer(manifest, raw_root)


def _render_tile(key):
    if _WORKER_RENDERER is None:
        raise RuntimeError("タイルworkerが初期化されていません")
    color, terrain = _WORKER_RENDERER.render_tile(key)
    return tuple(key), bytes(color), bytes(terrain)


def _write_parallel(manifest, manifest_path, raw_root, output_root, workers, max_zoom):
    bake.require_global_inputs(manifest, raw_root)
    output = Path(output_root)
    staging = output.with_name(f"{output.name}.staging-parallel-{os.getpid()}")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    source_file = Path(manifest_path)
    if not source_file.is_file():
        raise RuntimeError(f"source manifestがありません: {manifest_path}")
    source_hash = bake._fetch.contract_hash(manifest)
    climate_paths = [f"climate/{month:02d}.png" for month in range(1, 13)]
    coverage_kind = "complete" if max_zoom == 7 else "sparse"
    result_manifest = bake.global_manifest(manifest, "sources.json", source_hash,
                                           climate_paths, coverage_kind, 7, "source")
    try:
        renderer = create_real_renderer(manifest, raw_root)
        climate_values = renderer.climate_maps()
        if len(climate_values) != 12:
            raise ValueError("気候mapは12個必要です")
        for path, data in zip(climate_paths, climate_values):
            destination = staging / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (staging / "sources.json").write_bytes(source_file.read_bytes())

        base_color_tiles = []
        for key in bake.base_color_tile_keys():
            color, _ = renderer.render_tile(key)
            if (not isinstance(color, (bytes, bytearray)) or len(color) < 4
                    or bytes(color[:2]) != b"\xff\xd8" or bytes(color[-2:]) != b"\xff\xd9"):
                raise ValueError(f"base color rendererがJPEGを返しませんでした: {key}")
            base_color_tiles.append(bytes(color))
        keys = bake.global_tile_keys(max_zoom)
        context = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=workers, mp_context=context,
                                  initializer=_init_worker,
                                  initargs=(manifest, raw_root)) as pool:
            for count, (key, color, terrain) in enumerate(pool.map(_render_tile, keys, chunksize=1), 1):
                if (not isinstance(color, (bytes, bytearray)) or len(color) < 4
                        or bytes(color[:2]) != b"\xff\xd8" or bytes(color[-2:]) != b"\xff\xd9"):
                    raise ValueError(f"color rendererがJPEGを返しませんでした: {key}")
                bake.validate_terrain_tile(terrain, key, hashlib.sha256(terrain).hexdigest())
                color_url, terrain_url = bake.tile_urls(key)
                color_path = staging / color_url
                terrain_path = staging / terrain_url
                color_path.parent.mkdir(parents=True, exist_ok=True)
                color_path.write_bytes(color)
                encoded = gzip.compress(terrain, mtime=0)
                terrain_path.write_bytes(encoded)
                if count == 1 or count % 100 == 0:
                    print(f"earth-surface: {count}/{len(keys)} tiles", file=sys.stderr, flush=True)
        if len(base_color_tiles) != bake.BASE_COLOR_ROOT_COUNT:
            raise ValueError("base colorにはz4の512枚が必要です")
        base = staging / "base"
        base.mkdir(parents=True, exist_ok=True)
        (base / "earth.jpg").write_bytes(bake.encode_base_color(base_color_tiles))
        base_roots = [renderer.render_tile((0, x, 0))[1] for x in (0, 1)]
        for x, terrain in enumerate(base_roots):
            bake.validate_terrain_tile(terrain, (0, x, 0), hashlib.sha256(terrain).hexdigest())
        base_payload = bake.encode_base_terrain(base_roots)
        (base / "earth.bin.gz").write_bytes(gzip.compress(base_payload, mtime=0))
        (staging / "earth-surface.json").write_text(
            json.dumps(result_manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        (staging / "attribution.json").write_text(
            json.dumps({"datasetId": manifest["datasetId"], "attribution": result_manifest["attribution"]},
                       ensure_ascii=False, indent=2) + "\n")
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-root", default="../../.earth-surface/raw-v3")
    parser.add_argument("--manifest", default="../../assets-src/earth-surface/sources.json")
    parser.add_argument("--output", default="../../.earth-surface/bundle")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max-zoom", type=int, default=7)
    args = parser.parse_args()
    if type(args.workers) is not int or args.workers < 1:
        parser.error("--workersは1以上の整数が必要です")
    if type(args.max_zoom) is not int or not bake.EARTH_BASE_COLOR_Z <= args.max_zoom <= bake.EARTH_TILE_MAX_Z:
        parser.error("--max-zoomは4..7の整数が必要です")
    manifest = bake._fetch.load_manifest(args.manifest)
    _write_parallel(manifest, args.manifest, args.raw_root, args.output, args.workers,
                    args.max_zoom)
    print(f"全球bundle生成完了: {args.output}")


if __name__ == "__main__":
    main()
