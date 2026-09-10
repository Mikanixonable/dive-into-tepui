#!/usr/bin/env python3
"""CDSから計画書のERA5 local exportを取得する。"""

import argparse
import os
from pathlib import Path
import tempfile


DATASET = "reanalysis-era5-single-levels-monthly-means"
YEARS = [f"{year:04d}" for year in range(1991, 2021)]
MONTHS = [f"{month:02d}" for month in range(1, 13)]


def request_definition():
    """Return the immutable CDS selection required by the source manifest."""
    return {
        "product_type": "monthly_averaged_reanalysis",
        "variable": ["2m_temperature", "total_cloud_cover"],
        "year": YEARS.copy(),
        "month": MONTHS.copy(),
        "data_format": "netcdf",
    }


def download(output):
    """Download atomically, leaving no partial NetCDF at the contract path."""
    try:
        import cdsapi
    except ImportError as error:
        raise RuntimeError("cdsapi>=0.7.7を同じ環境へ導入してください") from error
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RuntimeError(f"ERA5出力が既に存在します: {destination} (削除せず別名を指定してください)")
    try:
        client = cdsapi.Client()
    except Exception as error:
        raise RuntimeError("CDS APIの認証設定がありません。~/.cdsapircを作成して利用規約へ同意してください") from error
    with tempfile.NamedTemporaryFile(prefix=f"{destination.name}.", suffix=".part",
                                     dir=destination.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        try:
            client.retrieve(DATASET, request_definition(), str(temporary_path))
        except Exception as error:
            raise RuntimeError(f"CDSからERA5を取得できません: {error}") from error
        if temporary_path.stat().st_size <= 0:
            raise RuntimeError("CDSが空のERA5ファイルを返しました")
        os.replace(temporary_path, destination)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".earth-surface/raw/era5-monthly-1991-2020/global.nc")
    args = parser.parse_args()
    path = download(args.output)
    print(f"earth-surface:era5-request: {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"earth-surface:era5-request: {error}")
        raise SystemExit(1)
