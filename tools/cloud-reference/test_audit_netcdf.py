"""audit-netcdf.py を検証する小規模な合成 NetCDF テスト。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import netCDF4
import numpy as np


MODULE_PATH = Path(__file__).with_name("audit-netcdf.py")
SPEC = importlib.util.spec_from_file_location("audit_netcdf", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
audit_netcdf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_netcdf)


CASE = {
    "id": "tiny-case",
    "source": {"provider": "NOAA", "product": "GOES-18 ABI test"},
    "series": {
        "start": "2024-05-15T17:50:00Z",
        "end": "2024-05-15T18:00:00Z",
        "intervalMinutes": 10,
    },
}


def stamp(slot: str, second_tenths: str) -> str:
    return f"{slot}{second_tenths}"


def write_product(case_dir: Path, slot: str, spec: tuple, longitude: float = -137.0) -> Path:
    directory, product_name, field_name, band_id = spec
    quality_product = {
        "L1b-RadF-M6C02": "L1B_RAD",
        "L1b-RadF-M6C13": "L1B_RAD",
        "L2-CODF-M6": "L2_COD",
        "L2-ACHAF-M6": "L2_ACHA",
        "L2-ACTPF-M6": "L2_ACTP",
        "L2-ACMF-M6": "L2_ACM",
    }[product_name]
    start = datetime.strptime(slot, "%Y%j%H%M").replace(tzinfo=timezone.utc) + timedelta(seconds=20.8)
    end = start + timedelta(minutes=9, seconds=30.8)
    created = end + timedelta(seconds=0.5)
    start_token = stamp(slot, f"{start.second * 10 + start.microsecond // 100_000:03d}")
    end_slot = end.strftime("%Y%j%H%M")
    end_token = stamp(end_slot, f"{end.second * 10 + end.microsecond // 100_000:03d}")
    created_slot = created.strftime("%Y%j%H%M")
    created_token = stamp(created_slot, f"{created.second * 10 + created.microsecond // 100_000:03d}")
    filename = f"OR_ABI-{product_name}_G18_s{start_token}_e{end_token}_c{created_token}.nc"
    folder = case_dir / directory
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    shape = (3, 4) if band_id == 2 else (2, 3)
    with netCDF4.Dataset(path, "w") as dataset:
        dataset.createDimension("y", shape[0])
        dataset.createDimension("x", shape[1])
        dataset.createDimension("bounds", 2)
        x = dataset.createVariable("x", "i2", ("x",))
        x.scale_factor = 0.0001
        x.add_offset = -0.15
        x.units = "rad"
        y = dataset.createVariable("y", "i2", ("y",))
        y.scale_factor = -0.0001
        y.add_offset = 0.15
        y.units = "rad"
        dataset.createVariable("t", "f8")
        dataset.createVariable("time_bounds", "f8", ("bounds",))
        projection = dataset.createVariable("goes_imager_projection", "i4")
        projection.grid_mapping_name = "geostationary"
        projection.perspective_point_height = 35786023.0
        projection.semi_major_axis = 6378137.0
        projection.semi_minor_axis = 6356752.31414
        projection.longitude_of_projection_origin = longitude
        projection.sweep_angle_axis = "x"

        field_dtype = "u1" if field_name in ("Phase", "ACM") else "i2"
        field_fill = 255 if field_dtype == "u1" else 32767
        field = dataset.createVariable(field_name, field_dtype, ("y", "x"), fill_value=field_fill)
        field.grid_mapping = "goes_imager_projection"
        field.valid_range = np.array([0, 10], dtype=np.uint8 if field_dtype == "u1" else np.int16)
        field.units = "1"
        field_values = (np.arange(shape[0] * shape[1]) % 6).astype(np.uint8 if field_dtype == "u1" else np.int16).reshape(shape)
        field_values[-1, -1] = field_fill
        field[:] = field_values.tolist()
        dqf = dataset.createVariable("DQF", "u1", ("y", "x"), fill_value=255)
        if quality_product == "L1B_RAD":
            dqf.valid_range = np.array([0, 4], dtype=np.uint8)
            dqf[:] = (np.array([0, 1, 2, 3, 4, 255], dtype=np.uint8)[np.arange(shape[0] * shape[1]) % 6]).reshape(shape).tolist()
        elif quality_product == "L2_COD":
            dqf.valid_range = np.array([0, 16], dtype=np.uint8)
            dqf[:] = (np.array([0, 1, 2, 3, 4, 6], dtype=np.uint8)[np.arange(shape[0] * shape[1]) % 6]).reshape(shape).tolist()
        elif quality_product == "L2_ACHA":
            dqf.valid_range = np.array([0, 3], dtype=np.uint8)
            dqf[:] = (np.array([0, 1, 2, 3, 4, 255], dtype=np.uint8)[np.arange(shape[0] * shape[1]) % 6]).reshape(shape).tolist()
        elif quality_product == "L2_ACTP":
            dqf.valid_range = np.array([0, 63], dtype=np.uint8)
            dqf[:] = (np.array([0, 1, 2, 3, 64, 255], dtype=np.uint8)[np.arange(shape[0] * shape[1]) % 6]).reshape(shape).tolist()
        else:
            dqf.valid_range = np.array([0, 6], dtype=np.uint8)
            dqf[:] = (np.array([0, 1, 2, 3, 6, 255], dtype=np.uint8)[np.arange(shape[0] * shape[1]) % 6]).reshape(shape).tolist()

        epoch = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)
        time_var = dataset.variables["t"]
        time_var.units = "seconds since 2000-01-01 12:00:00"
        time_var.assignValue((start + (end - start) / 2 - epoch).total_seconds())
        dataset.variables["time_bounds"][:] = [(start - epoch).total_seconds(), (end - epoch).total_seconds()]
        if band_id is not None:
            band = dataset.createVariable("band_id", "i2")
            band.assignValue(band_id)
        dataset.platform_ID = "G18"
        dataset.dataset_name = filename
        dataset.time_coverage_start = start.isoformat().replace("+00:00", "Z")
        dataset.time_coverage_end = end.isoformat().replace("+00:00", "Z")
    return path


def make_case(case_dir: Path) -> None:
    for slot in audit_netcdf.scan_slots(CASE["series"]):
        for spec in audit_netcdf.PRODUCTS:
            write_product(case_dir, slot, spec)


class AuditNetcdfTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"cases": [CASE]}), encoding="utf-8")
        self.case_dir = self.root / "case"
        self.case_dir.mkdir()
        make_case(self.case_dir)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_audits_all_six_products_for_each_slot_in_chunks(self) -> None:
        report = audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, None)
        self.assertEqual(len(report["files"]), 12)
        c02 = next(
            item for item in report["files"]
            if item["product"] == "L1b-RadF-M6C02" and item["slot"] == "20241361750"
        )
        self.assertEqual(c02["dqf_raw_counts"], {"0": 2, "1": 2, "2": 2, "3": 2, "4": 2, "255": 2})
        self.assertEqual(c02["field_valid_samples"], 11)
        self.assertEqual(c02["field_fill_samples"], 1)
        self.assertEqual(c02["field_out_of_range_samples"], 0)
        self.assertEqual(c02["shape"], [3, 4])
        self.assertEqual(report["auditedSlots"], ["20241361750", "20241361800"])
        for item in report["files"]:
            pixel_count = item["shape"][0] * item["shape"][1]
            self.assertEqual(
                item["field_valid_samples"] + item["field_fill_samples"] + item["field_out_of_range_samples"],
                pixel_count,
            )
            self.assertEqual(
                item["dqf_in_range_samples"] + item["dqf_fill_samples"] + item["dqf_out_of_range_samples"],
                pixel_count,
            )
            self.assertEqual(sum(item["dqf_raw_counts"].values()), pixel_count)

    def test_rejects_missing_product(self) -> None:
        path = next(self.case_dir.rglob("*L2-ACTPF*.nc"))
        path.unlink()
        with self.assertRaisesRegex(audit_netcdf.AuditError, "missing expected product/slot"):
            audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, None)

    def test_rejects_duplicate_slot_product(self) -> None:
        source = next(self.case_dir.rglob("*L2-CODF*.nc"))
        filename, creation_time = source.name.rsplit("_c", 1)
        duplicate = source.with_name(f"{filename}_c{int(creation_time[:14]) + 1:014d}.nc")
        duplicate.write_bytes(source.read_bytes())
        with self.assertRaisesRegex(audit_netcdf.AuditError, "duplicate file"):
            audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, None)

    def test_rejects_projection_mismatch(self) -> None:
        path = next(self.case_dir.rglob("*L2-CODF*.nc"))
        with netCDF4.Dataset(path, "r+") as dataset:
            dataset.variables["goes_imager_projection"].longitude_of_projection_origin = -136.0
        with self.assertRaisesRegex(audit_netcdf.AuditError, "projection disagrees"):
            audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, None)

    def test_rejects_global_time_mismatch(self) -> None:
        path = next(
            path for path in self.case_dir.rglob("*M6C02*.nc")
            if audit_netcdf.filename_match(path, "L1b-RadF-M6C02", "G18", "20241361750")
        )
        with netCDF4.Dataset(path, "r+") as dataset:
            dataset.time_coverage_start = "2024-05-15T17:50:21.800Z"
        with self.assertRaisesRegex(audit_netcdf.AuditError, "time_coverage_start disagrees"):
            audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, None)

    def test_counts_fill_and_out_of_range_values_in_separate_partitions(self) -> None:
        path = next(
            path for path in self.case_dir.rglob("*M6C02*.nc")
            if audit_netcdf.filename_match(path, "L1b-RadF-M6C02", "G18", "20241361750")
        )
        with netCDF4.Dataset(path, "r+") as dataset:
            field = dataset.variables["Rad"]
            dqf = dataset.variables["DQF"]
            field.set_auto_maskandscale(False)
            dqf.set_auto_maskandscale(False)
            raw_field = np.zeros(field.shape, dtype=np.int16)
            raw_field[0, 0:3] = [32767, 11, 0]
            field[:] = raw_field.tolist()
            raw_dqf = np.zeros(dqf.shape, dtype=np.uint8)
            raw_dqf[0, 0:3] = [255, 5, 4]
            dqf[:] = raw_dqf.tolist()
        report = audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, "20241361750")
        c02 = next(
            item for item in report["files"]
            if item["product"] == "L1b-RadF-M6C02" and item["slot"] == "20241361750"
        )
        self.assertEqual(c02["field_fill_samples"], 1)
        self.assertEqual(c02["field_out_of_range_samples"], 1)
        self.assertEqual(c02["field_valid_samples"], 10)
        self.assertEqual(c02["dqf_fill_samples"], 1)
        self.assertEqual(c02["dqf_out_of_range_samples"], 1)
        self.assertEqual(c02["dqf_in_range_samples"], 10)

    def test_rejects_product_timestamp_mismatch(self) -> None:
        path = next(self.case_dir.rglob("*L2-CODF*.nc"))
        match = audit_netcdf.FILENAME.fullmatch(path.name)
        assert match is not None
        start = audit_netcdf.utc_scan_time(match.group("start")) + timedelta(seconds=1)
        end = audit_netcdf.utc_scan_time(match.group("end")) + timedelta(seconds=1)
        start_token = start.strftime("%Y%j%H%M") + f"{start.second * 10 + start.microsecond // 100_000:03d}"
        end_token = end.strftime("%Y%j%H%M") + f"{end.second * 10 + end.microsecond // 100_000:03d}"
        created = audit_netcdf.utc_scan_time(match.group("created")) + timedelta(seconds=1)
        created_token = created.strftime("%Y%j%H%M") + f"{created.second * 10 + created.microsecond // 100_000:03d}"
        renamed = path.with_name(
            f"OR_ABI-{match.group('product')}_{match.group('satellite')}_s{start_token}_"
            f"e{end_token}_c{created_token}.nc"
        )
        with netCDF4.Dataset(path, "r+") as dataset:
            dataset.time_coverage_start = start.isoformat().replace("+00:00", "Z")
            dataset.time_coverage_end = end.isoformat().replace("+00:00", "Z")
            dataset.dataset_name = renamed.name
            bounds = dataset.variables["time_bounds"]
            bounds[:] = np.asarray(bounds[:]) + 1
            time_var = dataset.variables["t"]
            time_var.assignValue(float(time_var[()]) + 1)
        path.rename(renamed)
        with self.assertRaisesRegex(audit_netcdf.AuditError, "scan start disagrees"):
            audit_netcdf.audit(self.manifest, "tiny-case", self.case_dir, "20241361750")


if __name__ == "__main__":
    unittest.main()
