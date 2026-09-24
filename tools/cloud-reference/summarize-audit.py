#!/usr/bin/env python3
"""保存済み GOES ABI 監査結果の網羅性と集計値を検証する。"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta
import json
from pathlib import Path
import re
import sys
from typing import Any


PRODUCTS = (
    ("L1b-RadF-M6C02", "Rad", "C02"),
    ("L1b-RadF-M6C13", "Rad", "C13"),
    ("L2-CODF-M6", "COD", "COD"),
    ("L2-ACHAF-M6", "HT", "ACHA"),
    ("L2-ACTPF-M6", "Phase", "ACTP"),
    ("L2-ACMF-M6", "ACM", "ACM"),
)
PRODUCT_FIELDS = {product: field for product, field, _ in PRODUCTS}
GOES_PRODUCT = re.compile(r"^GOES-(\d+) ABI ")
EXPECTED_NOAA_CASES = 9
COUNT_FIELDS = (
    "field_valid_samples",
    "field_fill_samples",
    "field_out_of_range_samples",
    "dqf_in_range_samples",
    "dqf_fill_samples",
    "dqf_out_of_range_samples",
)
FILE_WARNING_FIELDS = (
    "filesWithFieldFill",
    "filesWithFieldOutOfRange",
    "filesWithDqfFill",
    "filesWithDqfOutOfRange",
)


class SummaryError(Exception):
    """保存済み監査結果が要件を満たさないことを示す。"""


def fail(message: str) -> None:
    raise SummaryError(message)


def expected_slots(series: dict[str, Any]) -> list[str]:
    try:
        start = datetime.fromisoformat(series["start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(series["end"].replace("Z", "+00:00"))
        interval = int(series["intervalMinutes"])
    except (KeyError, TypeError, ValueError) as error:
        fail(f"invalid manifest series: {error}")
    if (
        start.tzinfo is None
        or end.tzinfo is None
        or start.utcoffset() != timedelta(0)
        or end.utcoffset() != timedelta(0)
        or interval <= 0
        or start >= end
    ):
        fail("manifest series requires ordered UTC times and a positive interval")
    if start.second or start.microsecond or end.second or end.microsecond:
        fail("manifest series bounds must align to whole minutes")
    if (end - start).total_seconds() % (interval * 60) != 0:
        fail("manifest series end is not aligned to its interval")
    slots = []
    cursor = start
    while cursor <= end:
        slots.append(cursor.strftime("%Y%j%H%M"))
        cursor += timedelta(minutes=interval)
    return slots


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {label} {path}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must contain a JSON object: {path}")
    return value


def supported_cases(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    manifest_cases = manifest.get("cases")
    if not isinstance(manifest_cases, list):
        fail("manifest cases must be an array")
    cases = []
    for case in manifest_cases:
        source = case.get("source", {})
        if source.get("provider") != "NOAA":
            continue
        if not GOES_PRODUCT.match(source.get("product", "")):
            fail(f"unsupported NOAA case: {case.get('id')}")
        cases.append(case)
    if len(cases) != EXPECTED_NOAA_CASES:
        fail(f"expected exactly {EXPECTED_NOAA_CASES} NOAA ABI cases, found {len(cases)}")
    if len({case.get("id") for case in cases}) != len(cases):
        fail("manifest contains duplicate NOAA case ids")
    return cases


def count_value(item: dict[str, Any], name: str, context: str) -> int:
    value = item.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail(f"{context}: {name} must be a non-negative integer")
    return value


def normalize_histogram(item: dict[str, Any], context: str) -> dict[str, int]:
    raw = item.get("dqf_raw_counts")
    if not isinstance(raw, dict):
        fail(f"{context}: dqf_raw_counts must be an object")
    histogram: dict[str, int] = {}
    for key, value in raw.items():
        try:
            normalized_key = str(int(key))
        except (TypeError, ValueError):
            fail(f"{context}: invalid DQF histogram key {key!r}")
        if normalized_key in histogram:
            fail(f"{context}: duplicate normalized DQF histogram key {key!r}")
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            fail(f"{context}: invalid DQF histogram count for {key!r}")
        histogram[normalized_key] = value
    return {key: histogram[key] for key in sorted(histogram, key=int)}


def validate_file(item: dict[str, Any], context: str) -> dict[str, Any]:
    product = item.get("product")
    if product not in PRODUCT_FIELDS:
        fail(f"{context}: unexpected product {product!r}")
    if item.get("field") != PRODUCT_FIELDS[product]:
        fail(f"{context}: unexpected field for product {product}")
    slot = item.get("slot")
    if not isinstance(slot, str):
        fail(f"{context}: slot must be a string")
    path = item.get("path")
    if not isinstance(path, str) or not path:
        fail(f"{context}: path must be a non-empty string")
    shape = item.get("shape")
    if (
        not isinstance(shape, list)
        or len(shape) != 2
        or any(not isinstance(size, int) or isinstance(size, bool) or size <= 0 for size in shape)
    ):
        fail(f"{context}: shape must contain two positive integers")
    pixels = shape[0] * shape[1]
    counts = {name: count_value(item, name, context) for name in COUNT_FIELDS}
    if sum(counts[name] for name in COUNT_FIELDS[:3]) != pixels:
        fail(f"{context}: field partitions do not sum to image size")
    if sum(counts[name] for name in COUNT_FIELDS[3:]) != pixels:
        fail(f"{context}: DQF partitions do not sum to image size")
    histogram = normalize_histogram(item, context)
    if sum(histogram.values()) != pixels:
        fail(f"{context}: DQF histogram does not sum to image size")
    fill_value = item.get("dqf_fill_value")
    if not isinstance(fill_value, int) or isinstance(fill_value, bool):
        fail(f"{context}: dqf_fill_value must be an integer")
    if histogram.get(str(fill_value), 0) != counts["dqf_fill_samples"]:
        fail(f"{context}: DQF fill count disagrees with raw histogram")
    evidence = validate_anomaly_evidence(item.get("rawValueAnomaly"), item, counts, histogram, context)
    return {
        "slot": slot,
        "product": product,
        "path": path,
        "shape": shape,
        **counts,
        "dqf_raw_counts": histogram,
        "rawValueAnomaly": evidence,
    }


def validate_anomaly_evidence(
    evidence: Any,
    item: dict[str, Any],
    counts: dict[str, int],
    dqf_histogram: dict[str, int],
    context: str,
) -> dict[str, Any] | None:
    """任意の画素根拠がファイル単位の集計と矛盾しないことを検査する。"""
    if evidence is None:
        return None
    if not isinstance(evidence, dict) or counts["field_out_of_range_samples"] == 0:
        fail(f"{context}: raw-value anomaly evidence requires field out-of-range pixels")
    for name in ("path", "product", "slot"):
        if evidence.get(name) != item[name]:
            fail(f"{context}: raw-value anomaly {name} disagrees with the audited file")
    for evidence_name, count_name in (
        ("fieldOutOfRangeSamples", "field_out_of_range_samples"),
        ("dqfOutOfRangeSamples", "dqf_out_of_range_samples"),
    ):
        if count_value(evidence, evidence_name, context) != counts[count_name]:
            fail(f"{context}: raw-value anomaly {evidence_name} disagrees with pixel partitions")
    value_counts = anomaly_histogram(evidence.get("fieldOutOfRangeValueCounts"), context)
    dqf_counts = anomaly_histogram(evidence.get("coLocatedDqfRawCounts"), context)
    expected_count = counts["field_out_of_range_samples"]
    if sum(value_counts.values()) != expected_count or sum(dqf_counts.values()) != expected_count:
        fail(f"{context}: raw-value anomaly counts do not match field out-of-range count")
    if any(count > dqf_histogram.get(value, 0) for value, count in dqf_counts.items()):
        fail(f"{context}: co-located DQF counts exceed the file histogram")
    coordinates = evidence.get("sampleCoordinatesYX")
    if not isinstance(coordinates, list) or len(coordinates) > expected_count:
        fail(f"{context}: raw-value anomaly coordinates are invalid")
    height, width = item["shape"]
    for point in coordinates:
        if (not isinstance(point, list) or len(point) != 2
            or any(not isinstance(value, int) or isinstance(value, bool) for value in point)
            or not (0 <= point[0] < height and 0 <= point[1] < width)):
            fail(f"{context}: raw-value anomaly coordinate lies outside the image")
    return evidence


def anomaly_histogram(value: Any, context: str) -> dict[str, int]:
    """生画素値別の件数を正規化し、重複や不正な件数を拒否する。"""
    if not isinstance(value, dict) or not value:
        fail(f"{context}: raw-value anomaly histogram must be non-empty")
    result: dict[str, int] = {}
    for key, count in value.items():
        try:
            normalized = str(int(key))
        except (TypeError, ValueError):
            fail(f"{context}: invalid raw-value anomaly key {key!r}")
        if normalized in result or not isinstance(count, int) or isinstance(count, bool) or count <= 0:
            fail(f"{context}: invalid raw-value anomaly count for {key!r}")
        result[normalized] = count
    return result


def new_product_totals() -> dict[str, Any]:
    return {
        "slotCount": 0,
        "fileCount": 0,
        **{name: 0 for name in COUNT_FIELDS},
        **{name: 0 for name in FILE_WARNING_FIELDS},
        "dqfRawCounts": {},
    }


def aggregate_product(rows: list[dict[str, Any]]) -> dict[str, Any]:
    totals = new_product_totals()
    totals["fileCount"] = len(rows)
    totals["slotCount"] = len({row["slot"] for row in rows})
    for row in rows:
        for name in COUNT_FIELDS:
            totals[name] += row[name]
        for name, count_name in (
            ("filesWithFieldFill", "field_fill_samples"),
            ("filesWithFieldOutOfRange", "field_out_of_range_samples"),
            ("filesWithDqfFill", "dqf_fill_samples"),
            ("filesWithDqfOutOfRange", "dqf_out_of_range_samples"),
        ):
            totals[name] += int(row[count_name] > 0)
        for value, count in row["dqf_raw_counts"].items():
            totals["dqfRawCounts"][value] = totals["dqfRawCounts"].get(value, 0) + count
    histogram = totals["dqfRawCounts"]
    totals["dqfRawCounts"] = {key: histogram[key] for key in sorted(histogram, key=int)}
    return totals


def audit_case(case: dict[str, Any], report_path: Path) -> dict[str, Any]:
    report = read_json(report_path, "case report")
    case_id = case["id"]
    if report.get("schemaVersion") != 1 or report.get("caseId") != case_id:
        fail(f"{report_path.name}: report schema or case id does not match manifest")
    slots = expected_slots(case["series"])
    if report.get("auditedSlots") != slots:
        fail(f"{report_path.name}: auditedSlots do not match manifest series")
    files = report.get("files")
    if not isinstance(files, list):
        fail(f"{report_path.name}: files must be an array")
    expected_keys = {(product, slot) for slot in slots for product, _, _ in PRODUCTS}
    validated = []
    actual_keys = set()
    for raw_item in files:
        if not isinstance(raw_item, dict):
            fail(f"{report_path.name}: each file entry must be an object")
        item = validate_file(raw_item, f"{report_path.name}:{raw_item.get('path', '?')}")
        key = (item["product"], item["slot"])
        if item["slot"] not in slots:
            fail(f"{report_path.name}: unexpected slot {item['slot']}")
        if key in actual_keys:
            fail(f"{report_path.name}: duplicate file for {key[0]} slot {key[1]}")
        actual_keys.add(key)
        validated.append(item)
    missing = expected_keys - actual_keys
    extra = actual_keys - expected_keys
    if missing or extra:
        fail(f"{report_path.name}: product/slot coverage mismatch (missing={len(missing)}, extra={len(extra)})")
    product_counts = {
        label: aggregate_product([row for row in validated if row["product"] == product])
        for product, _, label in PRODUCTS
    }
    warnings = []
    for item in validated:
        if item["field_out_of_range_samples"] == 0 and item["dqf_out_of_range_samples"] == 0:
            continue
        warning = {
            "slot": item["slot"],
            "product": item["product"],
            "path": item["path"],
            "fieldOutOfRangeSamples": item["field_out_of_range_samples"],
            "dqfOutOfRangeSamples": item["dqf_out_of_range_samples"],
        }
        evidence = item["rawValueAnomaly"]
        if evidence is not None:
            warning["pixelEvidence"] = evidence
        warnings.append(warning)
    return {
        "caseId": case_id,
        "auditStatus": "pass",
        "dataQualityClassification": "invalid_data_warnings" if warnings else "no_out_of_range_values_detected",
        "auditedSlots": len(slots),
        "fileCount": len(validated),
        "fullReport": report_path.name,
        "perProductCounts": product_counts,
        "invalidDataWarnings": warnings,
    }


def summarize(manifest_path: Path, reports_dir: Path) -> dict[str, Any]:
    manifest = read_json(manifest_path, "manifest")
    cases = supported_cases(manifest)
    expected_names = {f"{case['id']}.json" for case in cases}
    present_names = {path.name for path in reports_dir.glob("*.json")}
    if present_names != expected_names:
        fail(
            "case report set does not match NOAA manifest cases "
            f"(missing={len(expected_names - present_names)}, extra={len(present_names - expected_names)})"
        )
    summaries = []
    overall = {label: new_product_totals() for _, _, label in PRODUCTS}
    all_warnings = []
    overall_slots = 0
    overall_files = 0
    for case in cases:
        report_path = reports_dir / f"{case['id']}.json"
        item = audit_case(case, report_path)
        overall_slots += item["auditedSlots"]
        overall_files += item["fileCount"]
        all_warnings.extend({"caseId": case["id"], **warning} for warning in item["invalidDataWarnings"])
        for label, counts in item["perProductCounts"].items():
            target = overall[label]
            target["fileCount"] += counts["fileCount"]
            target["slotCount"] += counts["slotCount"]
            for name in COUNT_FIELDS + FILE_WARNING_FIELDS:
                target[name] += counts[name]
            for value, count in counts["dqfRawCounts"].items():
                target["dqfRawCounts"][value] = target["dqfRawCounts"].get(value, 0) + count
        summaries.append(item)
    for counts in overall.values():
        histogram = counts["dqfRawCounts"]
        counts["dqfRawCounts"] = {key: histogram[key] for key in sorted(histogram, key=int)}
    has_warnings = bool(all_warnings)
    return {
        "schemaVersion": 1,
        "auditStatus": "pass",
        "result": "pass_with_invalid_data_warnings" if has_warnings else "pass",
        "dataQualityClassification": "invalid_data_warnings" if has_warnings else "no_out_of_range_values_detected",
        "dataQualityClassificationThreshold": (
            "Any nonzero raw field or DQF out-of-range sample count is a warning; "
            "fill counts are reported separately."
        ),
        "caseCount": len(summaries),
        "overallSlotCount": overall_slots,
        "overallFileCount": overall_files,
        "perProductCounts": overall,
        "invalidDataWarnings": all_warnings,
        "cases": summaries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("manifest.json"))
    parser.add_argument("--reports-dir", type=Path, required=True, help="directory containing one JSON report per NOAA ABI case")
    args = parser.parse_args()
    try:
        result = summarize(args.manifest, args.reports_dir)
    except SummaryError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
