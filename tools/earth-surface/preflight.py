#!/usr/bin/env python3
"""実データ取得・全球bundle生成の前提を、ダウンロードせず検査する。"""

import argparse
import concurrent.futures
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

_spec = importlib.util.spec_from_file_location("earth_surface_fetch", Path(__file__).with_name("fetch-source.py"))
_fetch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fetch)

MODULES = ("osgeo", "netCDF4", "shapefile", "PIL")
COMMANDS = ("gdalinfo", "ogrinfo", "ncdump")


def regions_for(source):
    """ソースのURLテンプレートへ渡せる全領域を列挙する。"""
    if source.get("regions"):
        return list(source["regions"])
    if source.get("regionGridDegrees"):
        return [
            f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
            for lat in range(90, -90, -15)
            for lon in range(-180, 180, 15)
        ]
    return ["global"]


def probe(url, timeout):
    """HEADのみを送り、巨大なレスポンス本文を取得しない。"""
    request = urllib.request.Request(url, method="HEAD", headers={
        "Accept-Encoding": "identity",
        "User-Agent": "dive-into-tepui/earth-surface-preflight",
    })
    last_error = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return {
                    "status": getattr(response, "status", None),
                    "contentLength": int(response.headers["Content-Length"])
                    if response.headers.get("Content-Length", "").isdigit() else None,
                    "contentType": response.headers.get("Content-Type", ""),
                    "contentEncoding": response.headers.get("Content-Encoding", "identity"),
                    "etag": response.headers.get("ETag"),
                    "url": response.geturl(),
                }
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
    return {"error": f"{type(last_error).__name__}: {last_error}", "url": url}


def source_probe(source, sample_per_source, timeout, workers):
    """各ソースを代表領域だけ、または全領域HEAD検査する。"""
    if source.get("acquisition") == "public_mirror":
        years = range(int(source["period"]["start"][:4]), int(source["period"]["end"][:4]) + 1)
        templates = source.get("mirrorUrlTemplates", [])
        requests = [(f"{year}:{index}", template.format(year=year))
                    for year in years for index, template in enumerate(templates)]
        if sample_per_source is not None:
            limit = len(templates) if sample_per_source == 0 else max(1, sample_per_source * len(templates))
            requests = requests[:limit]
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            results = pool.map(lambda item: (item[0], probe(item[1], timeout)), requests)
            probes = [{"region": region, **result} for region, result in results]
        return {
            "sourceId": source["id"],
            "regionsRequested": len(requests),
            "regionsAvailableInContract": len(years) * len(templates),
            "probes": probes,
            "contentLengthBytes": sum(item.get("contentLength") or 0 for item in probes),
            "failed": sum("error" in item for item in probes),
        }
    regions = regions_for(source)
    if sample_per_source:
        regions = regions[:sample_per_source]
    if source.get("acquisition") == "explicit_local_export":
        return {"sourceId": source["id"], "regions": [], "localExportRequired": True}
    requests = [(region, source["urlTemplate"].format(region=region)) for region in regions]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = pool.map(lambda item: (item[0], probe(item[1], timeout)), requests)
        probes = [{"region": region, **result} for region, result in results]
    return {
        "sourceId": source["id"],
        "regionsRequested": len(regions),
        "regionsAvailableInContract": len(regions_for(source)),
        "probes": probes,
        "contentLengthBytes": sum(item.get("contentLength") or 0 for item in probes),
        "failed": sum("error" in item for item in probes),
    }


def dependency_report():
    return {
        "pythonModules": {name: importlib.util.find_spec(name) is not None for name in MODULES},
        "commands": {name: shutil.which(name) for name in COMMANDS},
    }


def estimate(manifest, probes, raw_root):
    """入力実測値と、圧縮前に必ず必要な出力容量を分けて見積もる。"""
    tile_count = 43520
    terrain_payload = 32 + (256 + 2 * manifest["outputGrid"]["gutter"]) ** 2 * 4
    terrain_bytes = tile_count * terrain_payload + 2 * terrain_payload
    input_bytes = sum(item.get("contentLengthBytes", 0) for item in probes)
    raw_path = Path(raw_root)
    disk = shutil.disk_usage(raw_path if raw_path.exists() else Path.cwd())
    return {
        "tileCount": tile_count,
        "terrainPayloadBytesPerTile": terrain_payload,
        "terrainPayloadBytesIncludingBase": terrain_bytes,
        "inputBytesFromHEAD": input_bytes,
        "outputLowerBoundBytes": terrain_bytes,
        "availableDiskBytes": disk.free,
        "rawRoot": str(raw_path),
        "diskInsufficientForTerrainLowerBound": disk.free < terrain_bytes,
    }


def run(manifest_path, sample_per_source, timeout, workers, raw_root):
    manifest = _fetch.load_manifest(manifest_path)
    probes = [source_probe(source, sample_per_source, timeout, workers) for source in manifest["sources"]]
    dependencies = dependency_report()
    sizing = estimate(manifest, probes, raw_root)
    blockers = []
    missing_modules = [name for name, present in dependencies["pythonModules"].items() if not present]
    if missing_modules:
        blockers.append(f"Python依存が不足しています: {', '.join(missing_modules)}")
    if not dependencies["commands"]["gdalinfo"] or not dependencies["commands"]["ogrinfo"]:
        blockers.append("GDAL CLI (gdalinfo/ogrinfo) がありません")
    if sizing["diskInsufficientForTerrainLowerBound"]:
        blockers.append("空き容量が地形payloadの圧縮前下限を下回っています")
    if any(item.get("localExportRequired") for item in probes):
        blockers.append("ERA5はCDSから固定期間・変数のローカルNetCDF exportが必要です")
    for item in probes:
        if item.get("failed"):
            blockers.append(f"{item['sourceId']}のHEAD検査に失敗したURLがあります")
    return {
        "schemaVersion": 1,
        "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "manifest": str(manifest_path),
        "probeMode": "sample" if sample_per_source is not None else "all",
        "dependencies": dependencies,
        "sources": probes,
        "estimate": sizing,
        "status": "blocked" if blockers else "ready_for_acquisition",
        "blockers": blockers,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--output", type=Path, help="検査結果JSONの保存先")
    parser.add_argument("--all", action="store_true", help="全regionへHEADを送る。本文は取得しない")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--raw-root", default=".earth-surface/raw")
    args = parser.parse_args()
    if args.workers <= 0 or args.timeout <= 0:
        parser.error("--workersと--timeoutは正数が必要です")
    report = run(args.manifest, None if args.all else 1, args.timeout, args.workers, args.raw_root)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(encoded)
        os.replace(temporary, args.output)
    print(encoded, end="")
    return 1 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError) as error:
        print(f"earth-surface:preflight: {error}", file=sys.stderr)
        sys.exit(1)
