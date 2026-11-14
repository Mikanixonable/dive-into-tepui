"""地表ツール間で共有する、hash・JSON・ソース領域列挙の小さなhelper。"""

import hashlib
import json
import os
from pathlib import Path
import re


# JSONの表現差を除いたソース契約の識別子を返す。
def contract_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


# ストリームで読み、ファイル全体のSHA-256を返す。
def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# JSONを隣接する一時ファイルから原子的に置き換える。
def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


# NetCDFの単位表記は変換器によって空白や大文字小文字が変わるため正規化する。
def normalized_unit(value):
    return re.sub(r"\s+", "", value.strip().lower()) if isinstance(value, str) else value


# ソース形式ごとの取得ファイル拡張子。
SOURCE_SUFFIXES = {"geotiff": ".tif", "zip": ".zip", "netcdf": ".nc"}


# regionGridDegreesソースの15度格子領域名（北西端セル名）を列挙する。
def region_grid_names():
    return [f"{'N' if latitude >= 0 else 'S'}{abs(latitude):02d}"
            f"{'E' if longitude >= 0 else 'W'}{abs(longitude):03d}"
            for latitude in range(90, -90, -15)
            for longitude in range(-180, 180, 15)]


# manifestの1ソースが要求するローカル入力ファイルを列挙する。実体は開かない。
def source_file_paths(raw_root, source):
    root = Path(raw_root) / source["id"]
    suffix = SOURCE_SUFFIXES[source["format"]]
    explicit = source.get("inputFiles")
    if explicit:
        return [root / item for item in explicit]
    if source.get("regions"):
        return [root / f"{region}{suffix}" for region in source["regions"]]
    if source.get("regionGridDegrees"):
        return [root / f"{name}{suffix}" for name in region_grid_names()]
    return [root / f"global{suffix}"]
