#!/usr/bin/env python3
"""Generate canonical ICRF/J2000 Chebyshev source JSON for Tepui.

This is an offline release tool, never a browser startup path.  It can either
reproduce a JPL SPK interval directly (modern DE440), or continue the positive
DE441 boundary with an explicitly versioned N-body model (far future).  The
JSON output is consumed by `node tools/ephemeris/cli.mjs pack`.

The far-future solution is a deterministic model prediction, not observed
truth.  `validate` performs a same-length forecast wholly inside DE441 so the
model error is measured instead of being hidden behind interpolation accuracy.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rebound
from jplephem.spk import SPK

DAY = 86400.0
J2000 = 2451545.0
JULIAN_YEAR = 365.25
MODEL_ID = "tepui-de441-11body-ias15-lunar-secular-v2"
# The point-mass continuation misses part of DE441's long-period lunar phase.
# Fitting a 2924-y forecast ending at the positive DE441 boundary gives this
# additional mean-longitude acceleration. It is an empirical continuation of
# DE441, not a claim about observed AD 20000 truth.
LUNAR_LONGITUDE_ACCEL_ARCSEC_PER_CY2 = 62.56448970403922

# System GM values [m^3/s^2]. Giant-planet entries are system barycentres.
BODIES = (
    ("sun", 10, 1.32712440018e20),
    ("mercury", 1, 2.203186855e13),
    ("venus", 2, 3.24858592e14),
    ("earth", 399, 3.98600435436e14),
    ("moon", 301, 4.902800118e12),
    ("mars", 4, 4.2828375816e13),
    ("jupiter", 5, 1.267127648e17),
    ("saturn", 6, 3.79405852e16),
    ("uranus", 7, 5.7945564e15),
    ("neptune", 8, 6.8365271e15),
    ("pluto", 9, 9.755e11),
)

# Which point each entry records.  DE440/441 resolve Mercury, Venus, Earth and
# the Moon down to body centres (segments 1->199, 2->299, 3->399, 3->301) but
# carry no equivalent for Mars outward, so those entries are the barycentre of
# the planet and its satellites.  The consumer binds a barycentre series to the
# planetary system rather than to the planet, so this must be declared.
BODY_POINTS = {name: "systemBarycenter" for name, code, _ in BODIES if code in (4, 5, 6, 7, 8, 9)}


def gregorian_jd(year: int, month: int, day: int, hour: int = 0,
                 minute: int = 0, second: float = 0.0) -> float:
    y, m = year, month
    if m <= 2:
        y -= 1
        m += 12
    a = math.floor(y / 100)
    b = 2 - a + math.floor(a / 4)
    return (math.floor(365.25 * (y + 4716))
            + math.floor(30.6001 * (m + 1)) + day + b - 1524.5
            + (hour * 3600 + minute * 60 + second) / DAY)


def parse_epoch(text: str) -> float:
    date, clock = text.split("T", 1)
    y, m, d = (int(v) for v in date.split("-"))
    hh, mm, ss = clock.removesuffix("TDB").split(":")
    return gregorian_jd(y, m, d, int(hh), int(mm), float(ss))


def add_state(left, right):
    return left[0] + right[0], left[1] + right[1]


def spk_state(kernel: SPK, body: int, jd: float):
    if body == 10:
        state = kernel[0, 10].compute_and_differentiate(jd)
    elif body == 1:
        state = add_state(kernel[0, 1].compute_and_differentiate(jd),
                          kernel[1, 199].compute_and_differentiate(jd))
    elif body == 2:
        state = add_state(kernel[0, 2].compute_and_differentiate(jd),
                          kernel[2, 299].compute_and_differentiate(jd))
    elif body in (399, 301):
        state = add_state(kernel[0, 3].compute_and_differentiate(jd),
                          kernel[3, body].compute_and_differentiate(jd))
    else:
        state = kernel[0, body].compute_and_differentiate(jd)
    # jplephem returns km and km/day.
    return np.asarray(state[0]) * 1000.0, np.asarray(state[1]) * (1000.0 / DAY)


def simulation_at(kernel: SPK, jd: float) -> rebound.Simulation:
    sim = rebound.Simulation()
    sim.G = 1.0
    sim.integrator = "ias15"
    for _, code, gm in BODIES:
        r, v = spk_state(kernel, code, jd)
        sim.add(m=gm, x=r[0], y=r[1], z=r[2], vx=v[0], vy=v[1], vz=v[2])
    return sim


def rotate_about_axis(vector: np.ndarray, axis: np.ndarray, angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return vector * c + np.cross(axis, vector) * s + axis * np.dot(axis, vector) * (1 - c)


def states_of(sim: rebound.Simulation, lunar_elapsed_seconds: float | None = None
              ) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    result = {}
    for i, (name, _, _) in enumerate(BODIES):
        p = sim.particles[i]
        result[name] = (np.array((p.x, p.y, p.z)), np.array((p.vx, p.vy, p.vz)))
    if lunar_elapsed_seconds is not None and lunar_elapsed_seconds != 0:
        earth_r, earth_v = result["earth"]
        moon_r, moon_v = result["moon"]
        rel_r, rel_v = moon_r - earth_r, moon_v - earth_v
        axis = np.cross(rel_r, rel_v)
        axis /= np.linalg.norm(axis)
        centuries = lunar_elapsed_seconds / (36525 * DAY)
        accel = LUNAR_LONGITUDE_ACCEL_ARCSEC_PER_CY2 * math.pi / (180 * 3600)
        angle = 0.5 * accel * centuries * centuries
        angle_rate = accel * centuries / (36525 * DAY)
        corrected_r = rotate_about_axis(rel_r, axis, angle)
        corrected_v = rotate_about_axis(rel_v, axis, angle) + angle_rate * np.cross(axis, corrected_r)
        result["moon"] = (earth_r + corrected_r, earth_v + corrected_v)
    return result


def fit_segment(sample, start_et: float, end_et: float, degree: int):
    # Chebyshev nodes are evaluated in ascending physical time so an N-body
    # simulation never changes integration direction inside a segment.
    x = np.cos(np.pi * (np.arange(degree + 1) + 0.5) / (degree + 1))
    x.sort()
    times = (start_et + end_et) / 2 + x * (end_et - start_et) / 2
    values = np.asarray([sample(float(t)) for t in times])
    return [np.polynomial.chebyshev.chebfit(x, values[:, axis], degree).tolist()
            for axis in range(3)]


def direct_spk_segments(kernel: SPK, start_jd: float, end_jd: float,
                        span_days: float, degree: int):
    segments = []
    start_et = (start_jd - J2000) * DAY
    end_et = (end_jd - J2000) * DAY
    for name, code, _ in BODIES:
        cursor = start_et
        while cursor < end_et:
            segment_end = min(end_et, cursor + span_days * DAY)
            coeffs = fit_segment(
                lambda et, code=code: spk_state(kernel, code, J2000 + et / DAY)[0],
                cursor, segment_end, degree,
            )
            segments.append({"body": name, "start": cursor, "end": segment_end,
                             "coefficients": coeffs})
            cursor = segment_end
    return segments


def extended_segments(kernel: SPK, boundary_jd: float, start_jd: float,
                      end_jd: float, span_days: float, degree: int):
    if start_jd < boundary_jd:
        raise ValueError("extended interval must start at or after the DE441 boundary")
    sim = simulation_at(kernel, boundary_jd)
    sim.integrate((start_jd - boundary_jd) * DAY)
    base_t = sim.t
    start_et = (start_jd - J2000) * DAY
    end_et = (end_jd - J2000) * DAY
    segments = []
    cursor = start_et
    while cursor < end_et:
        segment_end = min(end_et, cursor + span_days * DAY)
        nodes = np.cos(np.pi * (np.arange(degree + 1) + 0.5) / (degree + 1))
        nodes.sort()
        times = (cursor + segment_end) / 2 + nodes * (segment_end - cursor) / 2
        samples = {name: [] for name, _, _ in BODIES}
        for et in times:
            sim.integrate(base_t + (et - start_et))
            for name, (r, _) in states_of(sim, sim.t).items():
                samples[name].append(r)
        for name, _, _ in BODIES:
            values = np.asarray(samples[name])
            coeffs = [np.polynomial.chebyshev.chebfit(nodes, values[:, axis], degree).tolist()
                      for axis in range(3)]
            segments.append({"body": name, "start": cursor, "end": segment_end,
                             "coefficients": coeffs})
        cursor = segment_end
    return segments


def write_fixture(path: Path, source: str, start_jd: float, end_jd: float, segments):
    fixture = {
        "manifest": {
            "format": "tepui-ephemeris-pack", "version": 1,
            "frame": "ICRF-J2000", "timeScale": "TDB", "timeOrigin": "J2000-ET",
            "positionUnit": "m", "timeUnit": "s",
            "validStart": (start_jd - J2000) * DAY,
            "validEnd": (end_jd - J2000) * DAY,
            "bodyPoints": BODY_POINTS,
            "sourceModel": source,
        },
        "segments": segments,
    }
    path.write_text(json.dumps(fixture, separators=(",", ":")), encoding="utf-8")


def validate_forecast(kernel: SPK, start_jd: float, years: float):
    target_jd = start_jd + years * JULIAN_YEAR
    sim = simulation_at(kernel, start_jd)
    sim.integrate(years * JULIAN_YEAR * DAY)
    predicted = states_of(sim, sim.t)
    earth_true = spk_state(kernel, 399, target_jd)[0]
    earth_pred = predicted["earth"][0]
    report = {"model": MODEL_ID, "startJdTdb": start_jd, "targetJdTdb": target_jd,
              "forecastYears": years,
              "lunarLongitudeAccelArcsecPerCy2": LUNAR_LONGITUDE_ACCEL_ARCSEC_PER_CY2,
              "bodies": {}}
    for name, code, _ in BODIES:
        true = spk_state(kernel, code, target_jd)[0] - earth_true
        pred = predicted[name][0] - earth_pred
        error = float(np.linalg.norm(pred - true))
        if name == "earth":
            angle = 0.0
        else:
            angle = math.degrees(math.acos(float(np.clip(
                np.dot(pred, true) / (np.linalg.norm(pred) * np.linalg.norm(true)), -1, 1))))
        report["bodies"][name] = {"geocentricPositionErrorM": error,
                                   "geocentricAngularErrorDeg": angle}
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("spk", "extend"):
        p = sub.add_parser(command)
        p.add_argument("--kernel", required=True, type=Path)
        p.add_argument("--start", required=True, help="YYYY-MM-DDTHH:MM:SSTDB")
        p.add_argument("--years", required=True, type=float)
        p.add_argument("--output", required=True, type=Path)
        p.add_argument("--span-days", type=float, default=4.0)
        p.add_argument("--degree", type=int, default=12)
        if command == "extend":
            p.add_argument("--boundary", default="17191-03-14T00:00:00TDB")
    p = sub.add_parser("validate")
    p.add_argument("--kernel", required=True, type=Path)
    p.add_argument("--start", default="14000-01-01T00:00:00TDB")
    p.add_argument("--years", type=float, default=2924.1047)
    p.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    kernel = SPK.open(str(args.kernel))
    start = parse_epoch(args.start)
    if args.command == "validate":
        args.output.write_text(json.dumps(validate_forecast(kernel, start, args.years), indent=2), encoding="utf-8")
        return 0
    end = start + args.years * JULIAN_YEAR
    if args.command == "spk":
        segments = direct_spk_segments(kernel, start, end, args.span_days, args.degree)
        source = "JPL SPK direct Chebyshev refit"
    else:
        segments = extended_segments(kernel, parse_epoch(args.boundary), start, end,
                                     args.span_days, args.degree)
        source = MODEL_ID
    write_fixture(args.output, source, start, end, segments)
    return 0


if __name__ == "__main__":
    sys.exit(main())
