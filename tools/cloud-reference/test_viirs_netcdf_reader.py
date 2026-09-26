"""VIIRS CLDPROP NetCDF reader を合成 v1.1 標本で検査する。"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import netCDF4
import numpy as np


MODULE_PATH = Path(__file__).with_name("viirs-netcdf-reader.py")
SPEC = importlib.util.spec_from_file_location("viirs_netcdf_reader", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
READER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READER
SPEC.loader.exec_module(READER)
DECODER_SPEC = importlib.util.spec_from_file_location(
    "viirs_cldprop", Path(__file__).with_name("viirs-cldprop.py"),
)
assert DECODER_SPEC is not None and DECODER_SPEC.loader is not None
DECODER = importlib.util.module_from_spec(DECODER_SPEC)
sys.modules[DECODER_SPEC.name] = DECODER
DECODER_SPEC.loader.exec_module(DECODER)


QA_DESCRIPTIONS = {
    "description20": "VNSWIR-2.1 Retrieval Spectral Data QA",
    "description22": "VNSWIR-2.1 Retrieval Confidence QA",
    "description24": "10 = Good",
    "description25": "11 = Very Good",
    "description26": "VNSWIR-2.1 Retrieval Outcome",
    "description27": "1 = Successful",
    "description37": "Primary retrieval processing path",
    "description39": "010 = Water Cloud",
    "description44": "Band Used for Optical Thickness Retrieval",
    "description45": "00 = No attempt",
    "description49": "Optical thickness out of bounds",
    "description50": "1 = yes",
    "description51": "VIIRS Bow-tie pixel indicator",
    "description54": "Clear Sky Restoral Type QA",
    "description55": "00 = Not Restored",
    "description72": "Earth surface type used in optical thickness retrieval",
    "description73": "00 = ice-free ocean",
}
CLOUD_MASK_DESCRIPTIONS = {
    "description14": "Cloud Mask Flag",
    "description15": "1 = Determined",
    "description17": "Unobstructed FOV Quality Flag 00 = Cloudy",
    "description18": "01 = Uncertain",
    "description20": "11 = Confident Clear",
    "description23": "Day or Night Path 0 = Night / 1 = Day",
    "description24": "Sunglint Path 0 = Yes / 1 = No",
    "description25": "Snow/Ice Background Path 0 = Yes / 1 = No",
    "description26": "Land or Water Path 00 = Water",
}
FILENAME = "CLDPROP_L2_VIIRS_SNPP.A2024136.2006.011.2024137120325.nc"


def _set_qa_descriptions(variable: object) -> None:
    for name, value in QA_DESCRIPTIONS.items():
        setattr(variable, name, value)


def _set_mask_descriptions(variable: object) -> None:
    for name, value in CLOUD_MASK_DESCRIPTIONS.items():
        setattr(variable, name, value)


def write_granule(path: Path) -> None:
    with netCDF4.Dataset(path, "w", format="NETCDF4") as dataset:
        dataset.createDimension("number_of_lines", 2)
        dataset.createDimension("number_of_pixels", 3)
        dataset.createDimension("number_of_quality_assurance_bytes", 4)
        dataset.createDimension("number_of_cloud_mask_bytes", 2)
        dataset.processing_level = "L2"
        dataset.processing_version = "v1.1"
        dataset.cdm_data_type = "swath"
        dataset.instrument = "VIIRS"
        dataset.platform = "Suomi-NPP"
        dataset.ShortName = "CLDPROP_L2_VIIRS_SNPP"
        dataset.product_version = "1.1"
        dataset.product_name = path.name
        dataset.LocalGranuleID = path.name
        dataset.DayNightFlag = "Day"
        dataset.time_coverage_start = "2024-05-15T20:06:00Z"
        dataset.time_coverage_end = "2024-05-15T20:12:00Z"

        science = dataset.createGroup("geophysical_data")
        geo = dataset.createGroup("geolocation_data")
        cod = science.createVariable(
            "Cloud_Optical_Thickness", "i2", ("number_of_lines", "number_of_pixels"), fill_value=-9999,
        )
        cod.valid_min = np.int16(0)
        cod.valid_max = np.int16(15000)
        cod.scale_factor = np.float64(0.01)
        cod.add_offset = np.float64(0.0)
        cod.units = "none"
        cod.set_auto_maskandscale(False)
        cod[:] = np.full((2, 3), 1234, dtype=np.int16)

        qa = science.createVariable(
            "Quality_Assurance", "i1",
            ("number_of_lines", "number_of_pixels", "number_of_quality_assurance_bytes"),
            fill_value=0,
        )
        qa.valid_min = np.int8(1)
        qa.valid_max = np.int16(255)
        qa.units = "none"
        _set_qa_descriptions(qa)
        qa.set_auto_maskandscale(False)
        qa[:] = np.broadcast_to(np.array([13, 18, 0, 0], dtype=np.int8), (2, 3, 4))

        cloud_mask = science.createVariable(
            "Cloud_Mask", "i1",
            ("number_of_lines", "number_of_pixels", "number_of_cloud_mask_bytes"),
            fill_value=0,
        )
        cloud_mask.valid_min = np.int8(1)
        cloud_mask.valid_max = np.int16(255)
        cloud_mask.units = "none"
        _set_mask_descriptions(cloud_mask)
        cloud_mask.set_auto_maskandscale(False)
        cloud_mask[:] = np.broadcast_to(np.array([57, 0], dtype=np.int8), (2, 3, 2))

        for name, dtype, fill, minimum, maximum, units in (
            ("latitude", "f4", -999.0, -90.0, 90.0, "degrees"),
            ("longitude", "f4", -999.0, -180.0, 180.0, "degrees"),
        ):
            variable = geo.createVariable(name, dtype, ("number_of_lines", "number_of_pixels"), fill_value=fill)
            variable.valid_min = np.float32(minimum)
            variable.valid_max = np.float32(maximum)
            variable.units = units
            variable.set_auto_maskandscale(False)
            variable[:] = np.full((2, 3), 30.0 if name == "latitude" else -130.0, dtype=np.float32)

        solar = geo.createVariable(
            "solar_zenith", "i2", ("number_of_lines", "number_of_pixels"), fill_value=-32768,
        )
        solar.valid_min = np.int16(0)
        solar.valid_max = np.int16(18000)
        solar.scale_factor = np.float64(0.01)
        solar.add_offset = np.float64(0.0)
        solar.units = "degrees"
        solar.set_auto_maskandscale(False)
        solar[:] = np.full((2, 3), 5000, dtype=np.int16)


class ViirsNetcdfReaderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / FILENAME
        write_granule(self.path)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_reads_raw_fields_and_decoder_metadata(self) -> None:
        inputs = READER.read_cod_inputs(self.path)
        self.assertEqual(inputs.best_point_cod_raw.dtype, np.dtype("int16"))
        self.assertEqual(inputs.best_point_cod_raw.shape, (2, 3))
        self.assertTrue(np.all(inputs.best_point_cod_raw == 1234))
        self.assertEqual(inputs.quality_assurance.shape, (2, 3, 4))
        self.assertEqual(inputs.cloud_mask.shape, (2, 3, 2))
        self.assertEqual(inputs.solar_zenith_raw[0, 0], 5000)
        self.assertEqual(inputs.granule_name, FILENAME)
        self.assertEqual(inputs.time_coverage_end - inputs.time_coverage_start, READER.timedelta(minutes=6))
        self.assertEqual(inputs.decoder_arguments()["processing_version"], "v1.1")
        self.assertEqual(inputs.qa_descriptions["description39"], QA_DESCRIPTIONS["description39"])
        decoded = DECODER.decode_daytime_cod(**inputs.decoder_arguments())
        self.assertTrue(np.all(decoded.valid))
        np.testing.assert_allclose(decoded.cod, np.full((2, 3), 12.34))

    def test_rejects_wrong_processing_version(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.processing_version = "v1.0"
        with self.assertRaisesRegex(READER.ViirsNetcdfError, "processing_version"):
            READER.read_cod_inputs(self.path)

    def test_rejects_packed_scale_mismatch(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.groups["geophysical_data"].variables["Cloud_Optical_Thickness"].scale_factor = 0.1
        with self.assertRaisesRegex(READER.ViirsNetcdfError, "scale_factor"):
            READER.read_cod_inputs(self.path)

    def test_rejects_wrong_dimension_layout(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            field = dataset.groups["geophysical_data"].variables["Cloud_Optical_Thickness"]
            field.set_auto_maskandscale(False)
            dataset.renameDimension("number_of_pixels", "pixel")
        with self.assertRaisesRegex(READER.ViirsNetcdfError, "dimension"):
            READER.read_cod_inputs(self.path)

    def test_existing_decoder_rejects_quality_description_mismatch(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.groups["geophysical_data"].variables["Quality_Assurance"].description39 = "011 = Ice Cloud"
        inputs = READER.read_cod_inputs(self.path)
        with self.assertRaisesRegex(ValueError, "description39"):
            DECODER.decode_daytime_cod(**inputs.decoder_arguments())

    def test_rejects_non_utc_or_filename_mismatched_time(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.time_coverage_start = "2024-05-15T20:06:00-07:00"
        with self.assertRaisesRegex(READER.ViirsNetcdfError, "must be UTC"):
            READER.read_cod_inputs(self.path)

    def test_matches_filename_to_coverage_at_minute_precision(self) -> None:
        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.time_coverage_start = "2024-05-15T20:06:00.250Z"
            dataset.time_coverage_end = "2024-05-15T20:12:00.250Z"
        inputs = READER.read_cod_inputs(self.path)
        self.assertEqual(inputs.time_coverage_start.microsecond, 250000)

        with netCDF4.Dataset(self.path, "r+") as dataset:
            dataset.time_coverage_start = "2024-05-15T20:07:00Z"
        with self.assertRaisesRegex(READER.ViirsNetcdfError, "disagrees"):
            READER.read_cod_inputs(self.path)


if __name__ == "__main__":
    unittest.main()
