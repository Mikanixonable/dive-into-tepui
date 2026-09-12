#!/usr/bin/env python3
"""NCAR GDEXのERA5月平均2変数を取得し、検証可能なNetCDFへ統合する。"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess


YEARS = range(1991, 2021)
LATITUDES = [90 - index * 0.25 for index in range(721)]
LONGITUDES = [index * 0.25 for index in range(1440)]


def _fetch_module():
    path = Path(__file__).with_name("fetch-source.py")
    spec = importlib.util.spec_from_file_location("earth_surface_fetch", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_manifest(path):
    return _fetch_module().load_manifest(path)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path, value):
    temporary = Path(path).with_suffix(Path(path).suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


def download(url, destination):
    """Download one mirror file atomically and return its observed identity."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return {"url": url, "path": str(destination), "bytes": destination.stat().st_size,
                "sha256": file_hash(destination)}
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.unlink(missing_ok=True)
    try:
        subprocess.run([
            "curl", "--fail", "--location", "--retry", "4", "--retry-all-errors",
            "--retry-delay", "2", "--connect-timeout", "30", "--max-time", "300",
            "--speed-limit", "1024", "--speed-time", "30", "--output", str(temporary), url,
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        os.replace(temporary, destination)
    except (OSError, subprocess.CalledProcessError) as error:
        temporary.unlink(missing_ok=True)
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise RuntimeError(f"GDEXファイルの取得に失敗しました: {url}: {detail}") from error
    return {"url": url, "path": str(destination), "bytes": destination.stat().st_size,
            "sha256": file_hash(destination)}


def _coordinate(dataset, name, expected, label):
    if name not in dataset.variables:
        raise ValueError(f"GDEX ERA5に{label}座標がありません")
    values = dataset.variables[name][:]
    if len(values) != len(expected) or any(abs(float(actual) - wanted) > 1e-8
                                           for actual, wanted in zip(values, expected)):
        raise ValueError(f"GDEX ERA5の{label}座標が不一致です")
    return dataset.variables[name]


def _monthly_variable(dataset, candidates, label):
    for name in candidates:
        if name in dataset.variables:
            variable = dataset.variables[name]
            if variable.dimensions != ("time", "latitude", "longitude"):
                raise ValueError(f"GDEX ERA5の{label}次元順序が不正です")
            if variable.shape != (12, 721, 1440):
                raise ValueError(f"GDEX ERA5の{label}寸法が不正です: {variable.shape}")
            return variable
    raise ValueError(f"GDEX ERA5に{label}変数がありません")


def _validate_year(tcc_path, temperature_path, year, netcdf_module):
    from netCDF4 import num2date

    with netcdf_module.Dataset(tcc_path, "r") as tcc_dataset, netcdf_module.Dataset(temperature_path, "r") as temperature_dataset:
        for dataset in (tcc_dataset, temperature_dataset):
            _coordinate(dataset, "latitude", LATITUDES, "緯度")
            _coordinate(dataset, "longitude", LONGITUDES, "経度")
        tcc = _monthly_variable(tcc_dataset, ("TCC", "tcc", "total_cloud_cover"), "雲量")
        temperature = _monthly_variable(temperature_dataset, ("VAR_2T", "t2m", "2m_temperature"), "気温")
        tcc_dates = num2date(tcc_dataset.variables["time"][:], tcc_dataset.variables["time"].units,
                             calendar=getattr(tcc_dataset.variables["time"], "calendar", "standard"))
        temperature_dates = num2date(temperature_dataset.variables["time"][:], temperature_dataset.variables["time"].units,
                                     calendar=getattr(temperature_dataset.variables["time"], "calendar", "standard"))
        expected = [(year, month) for month in range(1, 13)]
        if [(item.year, item.month) for item in tcc_dates] != expected or [(item.year, item.month) for item in temperature_dates] != expected:
            raise ValueError(f"GDEX ERA5 {year}の時刻軸が1月〜12月ではありません")
        if tcc.units not in ("(0-1)", "(0 - 1)", "0-1", "fraction", "1"):
            raise ValueError(f"GDEX ERA5雲量の単位が不正です: {tcc.units!r}")
        if temperature.units not in ("K", "kelvin"):
            raise ValueError(f"GDEX ERA5気温の単位が不正です: {temperature.units!r}")
        return tcc_dataset, temperature_dataset, tcc, temperature


def merge_years(manifest, raw_root, output):
    try:
        import netCDF4
        import numpy as np
    except ImportError as error:
        raise RuntimeError("GDEX ERA5統合にはnetCDF4とnumpyが必要です") from error
    source = next(item for item in manifest["sources"] if item["id"] == "era5-monthly-1991-2020")
    templates = source.get("mirrorUrlTemplates")
    if not isinstance(templates, list) or len(templates) != 2:
        raise ValueError("ERA5 source manifestに2本のGDEX mirrorUrlTemplatesが必要です")
    raw_root = Path(raw_root)
    mirror_root = raw_root / "era5-gdex-mirror"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise RuntimeError(f"ERA5統合出力が既に存在します: {output}")

    manifest_hash = _fetch_module().contract_hash(manifest)
    raw_inputs = []
    temporary = output.with_suffix(output.suffix + ".part")
    temporary.unlink(missing_ok=True)
    try:
        with netCDF4.Dataset(temporary, "w", format="NETCDF4") as merged:
            merged.createDimension("time", 360)
            merged.createDimension("latitude", 721)
            merged.createDimension("longitude", 1440)
            time = merged.createVariable("time", "i4", ("time",))
            latitude = merged.createVariable("latitude", "f8", ("latitude",))
            longitude = merged.createVariable("longitude", "f8", ("longitude",))
            temperature = merged.createVariable("t2m", "f4", ("time", "latitude", "longitude"),
                                                zlib=True, complevel=4, chunksizes=(1, 721, 1440))
            cloud = merged.createVariable("tcc", "f4", ("time", "latitude", "longitude"),
                                         zlib=True, complevel=4, chunksizes=(1, 721, 1440))
            latitude[:] = LATITUDES
            longitude[:] = LONGITUDES
            latitude.units = "degrees_north"
            longitude.units = "degrees_east"
            time.units = "hours since 1900-01-01 00:00:00"
            time.calendar = "gregorian"
            temperature.units = "K"
            temperature.long_name = "2 metre temperature; ERA5 monthly mean"
            cloud.units = "1"
            cloud.long_name = "Total cloud cover; ERA5 monthly mean"
            merged.source = "ECMWF ERA5 monthly averaged data, mirrored by NCAR GDEX ds633.1"
            merged.source_manifest_sha256 = manifest_hash
            for year_index, year in enumerate(YEARS):
                urls = [template.format(year=year) for template in templates]
                tcc_identity = download(urls[0], mirror_root / f"{year}-tcc.nc")
                temperature_identity = download(urls[1], mirror_root / f"{year}-2t.nc")
                raw_inputs.extend([tcc_identity, temperature_identity])
                with netCDF4.Dataset(tcc_identity["path"], "r") as tcc_dataset, netCDF4.Dataset(temperature_identity["path"], "r") as temperature_dataset:
                    _coordinate(tcc_dataset, "latitude", LATITUDES, "緯度")
                    _coordinate(tcc_dataset, "longitude", LONGITUDES, "経度")
                    _coordinate(temperature_dataset, "latitude", LATITUDES, "緯度")
                    _coordinate(temperature_dataset, "longitude", LONGITUDES, "経度")
                    tcc_variable = _monthly_variable(tcc_dataset, ("TCC", "tcc", "total_cloud_cover"), "雲量")
                    temperature_variable = _monthly_variable(temperature_dataset, ("VAR_2T", "t2m", "2m_temperature"), "気温")
                    tcc_time = tcc_dataset.variables["time"]
                    temperature_time = temperature_dataset.variables["time"]
                    tcc_dates = netCDF4.num2date(tcc_time[:], tcc_time.units, calendar=getattr(tcc_time, "calendar", "standard"))
                    temperature_dates = netCDF4.num2date(temperature_time[:], temperature_time.units, calendar=getattr(temperature_time, "calendar", "standard"))
                    expected = [(year, month) for month in range(1, 13)]
                    if [(item.year, item.month) for item in tcc_dates] != expected or [(item.year, item.month) for item in temperature_dates] != expected:
                        raise ValueError(f"GDEX ERA5 {year}の時刻軸が不正です")
                    if tcc_variable.units not in ("(0-1)", "(0 - 1)", "0-1", "fraction", "1"):
                        raise ValueError(f"GDEX ERA5雲量の単位が不正です: {tcc_variable.units!r}")
                    if temperature_variable.units not in ("K", "kelvin"):
                        raise ValueError(f"GDEX ERA5気温の単位が不正です: {temperature_variable.units!r}")
                    for month in range(12):
                        cloud_values = np.asarray(tcc_variable[month, :, :], dtype="f4")
                        temperature_values = np.asarray(temperature_variable[month, :, :], dtype="f4")
                        if (not np.isfinite(cloud_values).all()
                                or (cloud_values < -1e-5).any() or (cloud_values > 1 + 1e-5).any()):
                            raise ValueError(f"GDEX ERA5 {year}-{month + 1:02d}の雲量が不正です")
                        # GDEXのfloat32丸めで1を数ppm超える値だけを契約範囲へ戻す。
                        cloud_values = np.clip(cloud_values, 0, 1)
                        if not np.isfinite(temperature_values).all() or (temperature_values <= 0).any():
                            raise ValueError(f"GDEX ERA5 {year}-{month + 1:02d}の気温が不正です")
                        index = year_index * 12 + month
                        time[index] = int(netCDF4.date2num(tcc_dates[month], time.units, time.calendar))
                        cloud[index, :, :] = cloud_values
                        temperature[index, :, :] = temperature_values
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    receipt = {
        "sourceId": source["id"], "region": "global", "sourceManifestSha256": manifest_hash,
        "sourceContractSha256": _fetch_module().contract_hash(source),
        "url": "mirror://ncar-gdex/ds633.1/era5-monthly-1991-2020",
        "sourceUrls": [item["url"] for item in raw_inputs], "rawInputs": raw_inputs,
        "bytes": output.stat().st_size, "sha256": file_hash(output), "hashVerification": "observed",
        "attribution": source.get("attribution"),
    }
    _write_json(output.with_suffix(output.suffix + ".json"), receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--raw-root", default=".earth-surface/raw-v3")
    parser.add_argument("--output", default=".earth-surface/raw-v3/era5-monthly-1991-2020/global.nc")
    args = parser.parse_args()
    receipt = merge_years(load_manifest(args.manifest), args.raw_root, args.output)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"earth-surface:fetch-era5-gdex: {error}")
        raise SystemExit(1)
