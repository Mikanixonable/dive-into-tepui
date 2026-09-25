"""summarize-audit.py の合成 JSON 集計テスト。"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("summarize-audit.py")
SPEC = importlib.util.spec_from_file_location("summarize_audit", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
summarize_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summarize_audit)


PRODUCTS = summarize_audit.PRODUCTS


def make_fixture(root: Path, anomaly_evidence: bool = True) -> tuple[Path, Path]:
    reports = root / "reports"
    reports.mkdir(parents=True)
    cases = []
    for case_index in range(9):
        case_id = f"case-{case_index:02d}"
        case = {
            "id": case_id,
            "source": {"provider": "NOAA", "product": "GOES-18 ABI synthetic"},
            "series": {
                "start": "2024-01-01T00:00:00Z",
                "end": "2024-01-01T00:10:00Z",
                "intervalMinutes": 10,
            },
        }
        cases.append(case)
        slots = summarize_audit.expected_slots(case["series"])
        files = []
        for slot in slots:
            for product, field, _label in PRODUCTS:
                is_anomaly = case_index == 0 and slot == slots[0] and product == "L2-ACMF-M6"
                counts = {
                    "field_valid_samples": 0 if is_anomaly else 1,
                    "field_fill_samples": 0,
                    "field_out_of_range_samples": 1 if is_anomaly else 0,
                    "dqf_in_range_samples": 1,
                    "dqf_fill_samples": 0,
                    "dqf_out_of_range_samples": 0,
                }
                item = {
                    "slot": slot,
                    "product": product,
                    "field": field,
                    "path": f"{case_id}/{slot}/{product}.nc",
                    "shape": [1, 1],
                    **counts,
                    "dqf_raw_counts": {"0": 1},
                    "dqf_fill_value": 255,
                }
                if is_anomaly and anomaly_evidence:
                    item["rawValueAnomaly"] = {
                        "path": item["path"],
                        "product": product,
                        "slot": slot,
                        "fieldOutOfRangeSamples": 1,
                        "dqfOutOfRangeSamples": 0,
                        "fieldOutOfRangeValueCounts": {"128": 1},
                        "coLocatedDqfRawCounts": {"0": 1},
                        "sampleCoordinatesYX": [[0, 0]],
                    }
                files.append(item)
        (reports / f"{case_id}.json").write_text(
            json.dumps({"schemaVersion": 1, "caseId": case_id, "auditedSlots": slots, "files": files}),
            encoding="utf-8",
        )
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({"cases": cases}), encoding="utf-8")
    return manifest, reports


class SummarizeAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest, self.reports = make_fixture(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_summarizes_coverage_partitions_and_optional_pixel_evidence(self) -> None:
        result = summarize_audit.summarize(self.manifest, self.reports)
        self.assertEqual(result["caseCount"], 9)
        self.assertEqual(result["overallSlotCount"], 18)
        self.assertEqual(result["overallFileCount"], 108)
        self.assertEqual(result["auditStatus"], "pass")
        self.assertEqual(result["result"], "pass_with_invalid_data_warnings")
        acm = result["perProductCounts"]["ACM"]
        self.assertEqual(acm["field_out_of_range_samples"], 1)
        self.assertEqual(acm["dqfRawCounts"], {"0": 18})
        warning = result["invalidDataWarnings"][0]
        self.assertEqual(warning["pixelEvidence"]["fieldOutOfRangeValueCounts"], {"128": 1})
        self.assertEqual(warning["pixelEvidence"]["coLocatedDqfRawCounts"], {"0": 1})

    def test_does_not_infer_pixel_evidence_from_counts(self) -> None:
        self.manifest, self.reports = make_fixture(self.root / "without-evidence", anomaly_evidence=False)
        warning = summarize_audit.summarize(self.manifest, self.reports)["invalidDataWarnings"][0]
        self.assertNotIn("pixelEvidence", warning)

    def test_rejects_missing_case_report(self) -> None:
        (self.reports / "case-08.json").unlink()
        with self.assertRaisesRegex(summarize_audit.SummaryError, "report set"):
            summarize_audit.summarize(self.manifest, self.reports)

    def test_rejects_invalid_partitions(self) -> None:
        path = self.reports / "case-00.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        report["files"][0]["field_valid_samples"] = 0
        path.write_text(json.dumps(report), encoding="utf-8")
        with self.assertRaisesRegex(summarize_audit.SummaryError, "field partitions"):
            summarize_audit.summarize(self.manifest, self.reports)

    def test_rejects_anomaly_evidence_that_disagrees_with_counts(self) -> None:
        path = self.reports / "case-00.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        report["files"][5]["rawValueAnomaly"]["fieldOutOfRangeValueCounts"] = {"128": 2}
        path.write_text(json.dumps(report), encoding="utf-8")
        with self.assertRaisesRegex(summarize_audit.SummaryError, "anomaly counts"):
            summarize_audit.summarize(self.manifest, self.reports)

    def test_rejects_anomaly_evidence_for_the_wrong_file(self) -> None:
        path = self.reports / "case-00.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        report["files"][5]["rawValueAnomaly"]["path"] = "another-file.nc"
        path.write_text(json.dumps(report), encoding="utf-8")
        with self.assertRaisesRegex(summarize_audit.SummaryError, "anomaly path"):
            summarize_audit.summarize(self.manifest, self.reports)


if __name__ == "__main__":
    unittest.main()
