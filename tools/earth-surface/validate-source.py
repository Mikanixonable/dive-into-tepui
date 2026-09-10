#!/usr/bin/env python3
"""Validate local Earth-surface inputs without contacting their source URLs."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys


class ValidationError(ValueError):
    """A local source or ERA5 export does not satisfy the input contract."""


def contract_hash(value):
    """Return the hash used by fetch-source.py for an immutable JSON contract."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False, allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def file_hash(path):
    """Hash a local file in bounded chunks."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(path):
    """Load the source contract and reject malformed source metadata early."""
    path = Path(path)
    try:
        manifest = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"source manifestを読めません: {path}: {error}") from error
    if manifest.get("schemaVersion") != 1:
        raise ValidationError("source manifestのschemaVersionは1である必要があります")
    if not re.fullmatch(r"[a-z0-9-]+", manifest.get("datasetId", "")):
        raise ValidationError("source manifestのdatasetIdが不正です")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValidationError("source manifestのsourcesが空です")
    if any(not isinstance(source, dict) for source in sources):
        raise ValidationError("source manifestのsources要素がobjectではありません")
    ids = [source.get("id") for source in sources]
    if any(not re.fullmatch(r"[a-z0-9-]+", source.get("id", "")) for source in sources) \
            or len(set(ids)) != len(ids):
        raise ValidationError("source manifestのsource idが不正または重複しています")
    for source in sources:
        if not isinstance(source.get("inputSha256"), list):
            raise ValidationError(f"{source['id']}: inputSha256は配列が必要です")
        for pin in source["inputSha256"]:
            if (not isinstance(pin, dict) or not re.fullmatch(r"[A-Za-z0-9_-]+", pin.get("region", ""))
                    or not re.fullmatch(r"[0-9a-f]{64}", pin.get("sha256", ""))
                    or type(pin.get("bytes")) is not int or pin["bytes"] <= 0):
                raise ValidationError(f"{source['id']}: inputSha256の領域・hash・bytesが不正です")
    return manifest


def source_regions(source):
    """Return the local region names implied by a source contract."""
    if source.get("regions"):
        return list(source["regions"])
    if source.get("regionGridDegrees"):
        return [
            f"{'N' if latitude >= 0 else 'S'}{abs(latitude):02d}"
            f"{'E' if longitude >= 0 else 'W'}{abs(longitude):03d}"
            for latitude in range(90, -90, -15)
            for longitude in range(-180, 180, 15)
        ]
    return ["global"]


def _suffix(source):
    try:
        return {"geotiff": ".tif", "zip": ".zip", "netcdf": ".nc"}[source["format"]]
    except KeyError as error:
        raise ValidationError(f"{source.get('id', '<unknown>')}: 未知のformatです") from error


def _pins(source):
    return {pin["region"]: pin for pin in source.get("inputSha256", [])}


def _receipt_path(path):
    return path.with_suffix(path.suffix + ".json")


def validate_source_files(manifest, raw_root, require_pinned=False):
    """Validate downloaded files and receipt metadata; never open a URL."""
    root = Path(raw_root)
    manifest_hash = contract_hash(manifest)
    files = []
    unpinned = []
    for source in manifest["sources"]:
        source_hash = contract_hash(source)
        pins = _pins(source)
        for region in source_regions(source):
            path = root / source["id"] / f"{region}{_suffix(source)}"
            receipt_path = _receipt_path(path)
            if not path.is_file():
                raise ValidationError(f"{source['id']}/{region}: 入力ファイルがありません: {path}")
            if not receipt_path.is_file():
                raise ValidationError(f"{source['id']}/{region}: 取得記録がありません: {receipt_path}")
            try:
                receipt = json.loads(receipt_path.read_text())
            except (OSError, json.JSONDecodeError) as error:
                raise ValidationError(f"{source['id']}/{region}: 取得記録を読めません: {error}") from error
            expected = {
                "sourceId": source["id"],
                "region": region,
                "sourceContractSha256": source_hash,
                "sourceManifestSha256": manifest_hash,
                "attribution": source.get("attribution"),
            }
            for key, value in expected.items():
                if receipt.get(key) != value:
                    raise ValidationError(f"{source['id']}/{region}: receiptの{key}が不一致です")
            if source.get("acquisition") == "explicit_local_export":
                if not isinstance(receipt.get("url"), str) or not receipt["url"].startswith("file:"):
                    raise ValidationError(f"{source['id']}/{region}: local exportのreceipt URLがfile URIではありません")
            else:
                expected_url = source["urlTemplate"].format(region=region)
                if receipt.get("url") != expected_url:
                    raise ValidationError(f"{source['id']}/{region}: receiptのURLがsource metadataと不一致です")
            actual_bytes = path.stat().st_size
            actual_hash = file_hash(path)
            if receipt.get("bytes") != actual_bytes:
                raise ValidationError(f"{source['id']}/{region}: bytesが不一致です")
            if receipt.get("sha256") != actual_hash:
                raise ValidationError(f"{source['id']}/{region}: SHA-256が不一致です")
            pin = pins.get(region)
            if pin is None:
                unpinned.append({"sourceId": source["id"], "region": region,
                                 "sha256": actual_hash, "bytes": actual_bytes})
                if require_pinned:
                    raise ValidationError(f"{source['id']}/{region}: source manifestにSHA-256固定値がありません")
            elif pin["sha256"] != actual_hash or pin["bytes"] != actual_bytes:
                raise ValidationError(f"{source['id']}/{region}: 固定SHA-256またはbytesが不一致です")
            files.append({"sourceId": source["id"], "region": region,
                          "path": str(path), "bytes": actual_bytes, "sha256": actual_hash,
                          "receipt": str(receipt_path),
                          "hashVerification": receipt.get("hashVerification")})
    return {"sourceManifestSha256": manifest_hash, "files": files, "unpinned": unpinned}


def _era5_source(manifest):
    try:
        source = next(source for source in manifest["sources"] if source["id"] == "era5-monthly-1991-2020")
    except StopIteration as error:
        raise ValidationError("ERA5 source (era5-monthly-1991-2020) がsource manifestにありません") from error
    if source.get("acquisition") != "explicit_local_export":
        raise ValidationError("ERA5 sourceはexplicit_local_exportである必要があります")
    return source


def _coordinate_variable(dataset, names, role):
    for name in names:
        if name in dataset.variables:
            return name, dataset.variables[name]
    raise ValidationError(f"ERA5の{role}座標変数がありません ({', '.join(names)})")


def _expected_times():
    return [(year, month, hour) for year in range(1991, 2021)
            for month in range(1, 13) for hour in range(24)]


def _check_axis(values, expected, name, tolerance=1e-8):
    if len(values) != len(expected):
        raise ValidationError(f"ERA5 {name}のセル数が不一致です: {len(values)} != {len(expected)}")
    if any(not math.isfinite(float(value)) for value in values):
        raise ValidationError(f"ERA5 {name}に有限でない座標があります")
    if any(abs(float(value) - wanted) > tolerance for value, wanted in zip(values, expected)):
        raise ValidationError(f"ERA5 {name}の値または座標順序が契約と不一致です")


def validate_era5_export(path, manifest, netcdf_module=None):
    """Validate one explicit ERA5 NetCDF export and return its reproducible identity."""
    path = Path(path)
    if not path.is_file():
        raise ValidationError(f"ERA5のローカルexportがありません: {path}")
    source = _era5_source(manifest)
    if netcdf_module is None:
        try:
            import netCDF4 as netcdf_module
        except ImportError as error:
            raise ValidationError(
                "ERA5のNetCDF検査にはnetCDF4が必要です。"
                " `conda env create -f tools/earth-surface/environment.yml` で環境を作成してください"
            ) from error
    try:
        dataset = netcdf_module.Dataset(str(path), "r")
    except Exception as error:
        raise ValidationError(f"ERA5のNetCDFを開けません: {path}: {error}") from error
    try:
        dimensions = dataset.dimensions
        if "time" not in dimensions:
            raise ValidationError("ERA5にtime次元がありません")
        time_name = "time"
        latitude_name, latitude = _coordinate_variable(dataset, ("latitude", "lat"), "緯度")
        longitude_name, longitude = _coordinate_variable(dataset, ("longitude", "lon"), "経度")
        expected_shape = (8640, 721, 1440)
        actual_shape = (len(dimensions[time_name]), len(dimensions[latitude_name]), len(dimensions[longitude_name]))
        if actual_shape != expected_shape:
            raise ValidationError(f"ERA5のtime/緯度/経度格子が不一致です: {actual_shape} != {expected_shape}")
        if tuple(latitude.dimensions) != (latitude_name,) or tuple(longitude.dimensions) != (longitude_name,):
            raise ValidationError("ERA5の座標変数の次元が不正です")
        _check_axis(latitude[:], [90 - index * 0.25 for index in range(721)], "緯度")
        _check_axis(longitude[:], [index * 0.25 for index in range(1440)], "経度")
        if getattr(latitude, "units", "degrees_north") not in ("degrees_north", "degree_north"):
            raise ValidationError("ERA5緯度の単位はdegrees_northである必要があります")
        if getattr(longitude, "units", "degrees_east") not in ("degrees_east", "degree_east"):
            raise ValidationError("ERA5経度の単位はdegrees_eastである必要があります")

        aliases = {"2m_temperature": ("t2m", "2m_temperature"),
                   "total_cloud_cover": ("tcc", "total_cloud_cover")}
        variables = {}
        for logical in ("2m_temperature", "total_cloud_cover"):
            name = next((candidate for candidate in aliases[logical] if candidate in dataset.variables), None)
            if name is None:
                raise ValidationError(f"ERA5変数がありません: {logical}")
            variable = dataset.variables[name]
            if tuple(variable.dimensions) != (time_name, latitude_name, longitude_name):
                raise ValidationError(f"ERA5変数{name}の次元順序はtime, latitude, longitudeが必要です")
            if tuple(variable.shape) != expected_shape:
                raise ValidationError(f"ERA5変数{name}の格子寸法が不一致です: {tuple(variable.shape)} != {expected_shape}")
            unit = getattr(variable, "units", None)
            allowed = ("K", "kelvin") if logical == "2m_temperature" else ("1", "fraction")
            if unit not in allowed:
                raise ValidationError(f"ERA5変数{logical}の単位が不一致です: {unit!r}")
            variables[logical] = {"name": name, "units": unit, "shape": list(variable.shape)}

        time = dataset.variables.get(time_name)
        if time is None or tuple(time.dimensions) != (time_name,) or not getattr(time, "units", None):
            raise ValidationError("ERA5 timeの次元またはunitsが不正です")
        calendar = getattr(time, "calendar", "standard")
        if calendar not in ("standard", "gregorian", "proleptic_gregorian"):
            raise ValidationError(f"ERA5のcalendarが不正です: {calendar}")
        dates = netcdf_module.num2date(time[:], time.units, calendar=calendar)
        observed = [(item.year, item.month, item.hour) for item in dates]
        if observed != _expected_times():
            raise ValidationError("ERA5の時間軸は1991-01から2020-12まで各月24時刻を昇順で含む必要があります")
        return {
            "path": str(path), "bytes": path.stat().st_size, "sha256": file_hash(path),
            "variables": variables, "dimensions": {"time": 8640, "latitude": 721, "longitude": 1440},
            "coordinateOrder": {"latitude": "90..-90 by -0.25", "longitude": "0..359.75 by +0.25"},
            "time": {"start": "1991-01", "end": "2020-12", "records": 8640,
                     "hoursUtc": list(range(24)), "calendar": calendar, "units": time.units},
        }
    except ValidationError:
        raise
    except Exception as error:
        raise ValidationError(f"ERA5の内容検査に失敗しました: {error}") from error
    finally:
        dataset.close()


def validate(manifest_path, era5_path, raw_root=None, require_pinned=False):
    """Validate the local ERA5 export and, when supplied, downloaded source receipts."""
    manifest = load_manifest(manifest_path)
    if era5_path is None:
        raise ValidationError("ERA5のローカルexportを--era5で明示してください")
    result = {"schemaVersion": 1, "kind": "earth-surface-local-validation",
              "datasetId": manifest["datasetId"],
              "sourceManifestSha256": contract_hash(manifest),
              "era5": validate_era5_export(era5_path, manifest)}
    if raw_root is not None:
        result["sources"] = validate_source_files(manifest, raw_root, require_pinned)
    return result


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--era5", required=True, help="CDSから明示的にexportしたNetCDFのローカルパス")
    parser.add_argument("--raw-root", help="取得済みソースとreceiptのルートも検査する")
    parser.add_argument("--require-pinned", action="store_true", help="全入力にsource manifestの固定hashを要求する")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = validate(args.manifest, args.era5, args.raw_root, args.require_pinned)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        _write_json(args.output, report)
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValidationError, OSError) as error:
        print(f"earth-surface:validate: {error}", file=sys.stderr)
        sys.exit(1)
