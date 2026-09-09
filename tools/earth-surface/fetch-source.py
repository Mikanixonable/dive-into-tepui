#!/usr/bin/env python3
"""固定された地表ソースを領域単位で取得し、検証済み実体と取得記録を保存する。"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import urllib.error
import urllib.request
import uuid
import zipfile


class InvalidSource(ValueError):
    """取得した実体がソース契約を満たさない場合のエラー。"""


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


# 固定版・座標・変数を持つソースマニフェストを読み込む。
def load_manifest(path):
    value = json.loads(Path(path).read_text())
    if value.get("schemaVersion") != 1 or not re.fullmatch(r"[a-z0-9-]+", value.get("datasetId", "")):
        raise InvalidSource("schemaVersion/datasetIdが不正です")
    required = {"id", "product", "variables", "period", "crs", "noData", "regrid", "inputSha256", "attribution"}
    sources = value.get("sources", [])
    if not sources or len({source["id"] for source in sources}) != len(sources):
        raise InvalidSource("sourcesは重複のない一覧が必要です")
    for source in sources:
        if not required.issubset(source) or source["crs"] != "EPSG:4326":
            raise InvalidSource("ソースの必須属性またはCRSが不正です")
    return value


# 指定領域のURLを組み立てる。ERA5は明示的なローカルexportを受け取る。
def source_url(source, region, local_file=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", region):
        raise InvalidSource("領域名が不正です")
    if source.get("regions") and region not in source["regions"]:
        raise InvalidSource("ソースに存在しない領域です")
    if source.get("regionGridDegrees"):
        match = re.fullmatch(r"([NS])(\d{2})([EW])(\d{3})", region)
        if not match:
            raise InvalidSource("ETOPO領域はN15W075等の北西端で指定してください")
        lat = int(match[2]) * (1 if match[1] == "N" else -1)
        lon = int(match[4]) * (1 if match[3] == "E" else -1)
        if not (-90 < lat <= 90 and -180 <= lon < 180 and lat % 15 == lon % 15 == 0):
            raise InvalidSource("ETOPO領域が15度格子の外です")
    if local_file:
        return Path(local_file).resolve().as_uri()
    if source.get("acquisition") == "explicit_local_export":
        raise InvalidSource("ERA5は固定変数・期間のNetCDF exportを--local-fileで指定してください")
    return source["urlTemplate"].format(region=region)


# TIFFのIFDを読み、寸法・CRS・NoDataと画像データの格納範囲を検査する。
def validate_geotiff(path, source):
    size = Path(path).stat().st_size
    with Path(path).open("rb") as stream:
        header = stream.read(8)
        if header[:4] not in (b"II*\x00", b"MM\x00*"):
            raise InvalidSource("通常TIFFのヘッダーが必要です")
        endian = "<" if header[:2] == b"II" else ">"
        stream.seek(struct.unpack(endian + "I", header[4:])[0])
        count_bytes = stream.read(2)
        if len(count_bytes) != 2:
            raise InvalidSource("TIFF IFDが欠落しています")
        count = struct.unpack(endian + "H", count_bytes)[0]
        entries = stream.read(count * 12)
        if len(entries) != count * 12:
            raise InvalidSource("TIFF IFDが途切れています")
        tags = {}
        formats = {1: "B", 2: "s", 3: "H", 4: "I", 11: "f", 12: "d"}
        for tag, kind, length, inline in struct.iter_unpack(endian + "HHI4s", entries):
            if kind not in formats:
                continue
            fmt = formats[kind]
            byte_count = length * struct.calcsize(fmt)
            if byte_count > min(size, 1024 * 1024):
                raise InvalidSource("TIFF属性が検査上限を超えています")
            if byte_count <= 4:
                raw = inline[:byte_count]
            else:
                stream.seek(struct.unpack(endian + "I", inline)[0])
                raw = stream.read(byte_count)
            if len(raw) != byte_count:
                raise InvalidSource("TIFF属性が途切れています")
            tags[tag] = raw if kind == 2 else struct.unpack(endian + str(length) + fmt, raw)

    # 地理座標の単位と格子の大きさは取得時に確定する。
    dimensions = [tags.get(256, (0,))[0], tags.get(257, (0,))[0]]
    if dimensions != source["dimensions"] or tags.get(277, (1,))[0] != source["bands"]:
        raise InvalidSource("GeoTIFFの寸法またはバンド数が不一致です")
    keys = tags.get(34735, ())
    if len(keys) < 4 or len(keys) != 4 + keys[3] * 4:
        raise InvalidSource("GeoTIFFの座標系キーが不正です")
    epsg = [keys[i + 3] for i in range(4, len(keys), 4)
            if keys[i:i + 3] == (2048, 0, 1)]
    if epsg != [4326] or not ({33550, 33922}.issubset(tags) or 34264 in tags):
        raise InvalidSource("GeoTIFFは位置情報付きEPSG:4326が必要です")
    raw_nodata = tags.get(42113)
    nodata = float(raw_nodata.rstrip(b"\x00")) if raw_nodata else None
    if nodata != source["noData"]:
        raise InvalidSource("GeoTIFFのNoDataが不一致です")

    # オフセットだけ有効な、画素本体が途切れたファイルを拒否する。
    offsets = tags.get(324, tags.get(273, ()))
    lengths = tags.get(325, tags.get(279, ()))
    if not offsets or len(offsets) != len(lengths):
        raise InvalidSource("TIFFの画像データ領域が不正です")
    if any(offset < 8 or length <= 0 or offset + length > size for offset, length in zip(offsets, lengths)):
        raise InvalidSource("TIFFの画像データが途切れています")


# ZIPのCRCとfull-resolutionの必須地理レイヤーを検査する。
def validate_gshhg(path, source):
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise InvalidSource("GSHHG ZIPのCRCが不一致です")
        names = archive.namelist()
        for level in source["polygonLevels"]:
            suffix = f"GSHHS_f_L{level}"
            for extension in ("shp", "shx", "dbf", "prj"):
                selected = [name for name in names if name.endswith(f"{suffix}.{extension}")]
                if len(selected) != 1:
                    raise InvalidSource(f"GSHHGの{suffix}.{extension}が欠落しています")
                if extension == "prj":
                    projection = archive.read(selected[0]).decode()
                    if "WGS_1984" not in projection and "WGS 84" not in projection:
                        raise InvalidSource("GSHHGのCRSがWGS84ではありません")


# NetCDF実体の変数名をGDALで検査する。依存不足は取得物の破損と区別する。
def validate_netcdf(path, source):
    try:
        from osgeo import gdal
    except ImportError as error:
        raise RuntimeError("NetCDF検査にはrequirements.txtと同版のGDALが必要です") from error
    gdal.UseExceptions()
    dataset = gdal.OpenEx(str(path), gdal.OF_RASTER)
    if dataset is None:
        raise InvalidSource("NetCDFを開けません")
    aliases = {"2m_temperature": "t2m", "total_cloud_cover": "tcc"}
    variables = {name.rsplit(":", 1)[-1] for name, _ in dataset.GetSubDatasets()}
    if not all(variable["id"] in variables or aliases[variable["id"]] in variables
               for variable in source["variables"]):
        raise InvalidSource("NetCDFのERA5変数が不一致です")


# HTTP MIMEと実体の両方で形式を検査する。
def validate_file(path, source, content_type=""):
    with Path(path).open("rb") as stream:
        prefix = stream.read(512)
    if "html" in content_type.lower() or prefix.lstrip().lower().startswith((b"<!doctype", b"<html")):
        raise InvalidSource("データの代わりにHTMLが返りました")
    validators = {"geotiff": validate_geotiff, "zip": validate_gshhg, "netcdf": validate_netcdf}
    validator = validators.get(source["format"])
    if validator is None:
        raise InvalidSource("未知のソース形式です")
    try:
        validator(path, source)
    except (struct.error, zipfile.BadZipFile, UnicodeError) as error:
        raise InvalidSource("データ形式が壊れています") from error


# JSONを隣接する一時ファイルから原子的に置き換える。
def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


# 中断データを再開し、形式・長さ・任意の固定hashを検証して取得記録へ確定する。
def fetch_region(source, region, url, directory, manifest_sha, expected_sha=None, expected_bytes=None,
                 max_bytes=1024 * 1024 * 1024):
    if expected_sha is not None and not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise InvalidSource("SHA-256は64桁の小文字16進数が必要です")
    if max_bytes <= 0 or (expected_bytes is not None and not 0 < expected_bytes <= max_bytes):
        raise InvalidSource("取得長の上限が不正です")
    directory = Path(directory) / source["id"]
    directory.mkdir(parents=True, exist_ok=True)
    suffix = {"geotiff": ".tif", "zip": ".zip", "netcdf": ".nc"}[source["format"]]
    target = directory / (region + suffix)
    receipt_path = target.with_suffix(target.suffix + ".json")
    partial = target.with_suffix(target.suffix + ".part")
    resume_path = partial.with_suffix(partial.suffix + ".json")
    identity = {"url": url, "sourceManifestSha256": manifest_sha,
                "sourceContractSha256": contract_hash(source), "expectedSha256": expected_sha,
                "expectedBytes": expected_bytes}

    # 完了済みの同一実体を再利用し、同じ版のすり替わりを検出する。
    if target.exists():
        if not receipt_path.exists():
            raise InvalidSource("取得記録が欠落しています")
        receipt = json.loads(receipt_path.read_text())
        if any(receipt.get(key) != value for key, value in identity.items()):
            raise InvalidSource("完了済み領域のソース契約が変わっています")
        validate_file(target, source)
        if target.stat().st_size != receipt["bytes"] or file_hash(target) != receipt["sha256"]:
            raise InvalidSource("完了済み領域の長さまたはSHA-256が不一致です")
        return receipt

    # サーバのvalidatorがある部分ファイルにRange/If-Rangeを適用する。
    saved = json.loads(resume_path.read_text()) if resume_path.exists() else {}
    reusable = all(saved.get(key) == value for key, value in identity.items()) and saved.get("validator")
    offset = partial.stat().st_size if partial.exists() and reusable else 0
    headers = {"Accept-Encoding": "identity"}
    if offset:
        headers.update({"Range": f"bytes={offset}-", "If-Range": saved["validator"]})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            status = getattr(response, "status", None)
            content_type = response.headers.get("Content-Type", "")
            declared = response.headers.get("Content-Length")
            remaining = int(declared) if declared is not None else None
            if status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or int(match[1]) != offset or int(match[2]) < offset:
                    raise InvalidSource("再開レスポンスのContent-Rangeが不正です")
                total = int(match[3])
                if int(match[2]) + 1 != total or remaining != total - offset:
                    raise InvalidSource("再開レスポンスの長さが不一致です")
            elif status in (None, 200):
                offset, total = 0, remaining
            else:
                raise InvalidSource(f"未知のHTTP status: {status}")
            if "html" in content_type.lower() or response.headers.get("Content-Encoding", "identity") != "identity":
                raise InvalidSource("HTTP実体がHTMLまたは未対応のContent-Encodingです")
            if total is not None and (total > max_bytes or (expected_bytes is not None and total != expected_bytes)):
                raise InvalidSource("HTTP実体の長さが契約外です")

            # 途中で切れた転送は再開可能な状態を残す。
            validator = response.headers.get("ETag") or response.headers.get("Last-Modified")
            write_json(resume_path, {**identity, "validator": validator})
            received = offset
            with partial.open("ab" if offset else "wb") as stream:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    received += len(block)
                    if received > max_bytes:
                        raise InvalidSource("取得上限を超えました")
                    stream.write(block)
            if total is not None and received != total:
                raise ConnectionError("転送が途中で切れました。再実行すると再開します")
            if expected_bytes is not None and received != expected_bytes:
                raise InvalidSource("実体の長さが不一致です")
        validate_file(partial, source, content_type)
        digest = file_hash(partial)
        if expected_sha is not None and digest != expected_sha:
            raise InvalidSource("実体のSHA-256が不一致です")
    except InvalidSource:
        rejected = directory / "rejected" / uuid.uuid4().hex
        rejected.mkdir(parents=True)
        for path in (partial, resume_path):
            if path.exists():
                os.replace(path, rejected / path.name)
        raise

    # 初回観測hashと事前固定hashを取得記録上で区別する。
    receipt = {**identity, "sourceId": source["id"], "region": region, "bytes": received,
               "sha256": digest, "hashVerification": "pinned" if expected_sha else "observed",
               "accessedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "attribution": source["attribution"]}
    write_json(receipt_path, receipt)
    os.replace(partial, target)
    resume_path.unlink(missing_ok=True)
    return receipt


# 領域を明示して取得するコマンドライン入口。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="assets-src/earth-surface/sources.json")
    parser.add_argument("--source", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--local-file")
    parser.add_argument("--output-root", default=".earth-surface/raw")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--expected-bytes", type=int)
    parser.add_argument("--max-bytes", type=int, default=1024 * 1024 * 1024)
    args = parser.parse_args()
    manifest = load_manifest(args.manifest)
    source = next((item for item in manifest["sources"] if item["id"] == args.source), None)
    if source is None:
        parser.error("未知のsourceです")
    pinned = next((item for item in source["inputSha256"] if item["region"] == args.region), {})
    if pinned and args.expected_sha256 and args.expected_sha256 != pinned["sha256"]:
        raise InvalidSource("指定hashとソースマニフェストのhashが不一致です")
    receipt = fetch_region(source, args.region, source_url(source, args.region, args.local_file),
                           args.output_root, contract_hash(manifest),
                           pinned.get("sha256", args.expected_sha256),
                           pinned.get("bytes", args.expected_bytes), args.max_bytes)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(f"earth-surface:fetch: {error}", file=sys.stderr)
        sys.exit(1)
