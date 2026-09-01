# Ephemeris pack tooling

This directory contains a deliberately small version 1 ephemeris-pack
serializer. It is a transport format for precomputed position Chebyshev
coefficients; it is not a source of astronomical data and does not download
DE440/DE441 files. `fixture.json` is synthetic data used only to exercise the
CLI.

Pack positions are barycentric ICRF/J2000 coordinates. `timeScale` is always
TDB and all manifest/segment times are seconds from the J2000 ET epoch
(`timeOrigin: "J2000-ET"`); they are not Earth-centered seconds or Julian
dates. Earth-centered conversion belongs to the later consumer stage.

The binary layout is documented at the top of
`src/physics/ephemeris/pack-format.ts`: a 32-byte little-endian header,
canonical UTF-8 JSON manifest, then contiguous little-endian Float64 values.
For each series, coefficients are ordered X, Y, Z and each component has
`degree + 1` values. The manifest's `payloadSha256` is the SHA-256 digest of
the payload section alone.

Try the complete local workflow without adding generated files to the repo:

```sh
tmpdir=$(mktemp -d)
node tools/ephemeris/cli.mjs pack tools/ephemeris/fixture.json "$tmpdir/fixture.epk"
node tools/ephemeris/cli.mjs verify "$tmpdir/fixture.epk"
node tools/ephemeris/cli.mjs unpack "$tmpdir/fixture.epk" "$tmpdir/unpacked.json"
rm -rf "$tmpdir"
```

The CLI has the same commands and examples in `node tools/ephemeris/cli.mjs
help`.

## Official-kernel and far-future generation

Install the offline-only Python dependencies in an isolated environment:

```sh
python3 -m pip install -r tools/ephemeris/requirements.txt
```

`generate.py spk` refits a requested DE440 interval without integrating it.
`generate.py extend` starts at the positive DE441 boundary and performs the
versioned long-term N-body prediction. Neither command runs in the browser or
during an ordinary webpack build.

```sh
python3 tools/ephemeris/generate.py spk \
  --kernel /path/to/de440.bsp \
  --start 2026-01-01T00:00:00TDB --years 10 \
  --output /tmp/modern.json

python3 tools/ephemeris/generate.py extend \
  --kernel /path/to/de441_part-2.bsp \
  --start 20115-05-14T06:00:00TDB --years 10 \
  --output /tmp/far-future.json

node tools/ephemeris/cli.mjs pack /tmp/far-future.json far-future.epk
```

Before publishing a far-future pack, run a forecast of the same length wholly
inside DE441. The report records measured geocentric position and angular
errors per body. These are model errors and must not be confused with the much
smaller Chebyshev representation errors.

```sh
python3 tools/ephemeris/generate.py validate \
  --kernel /path/to/de441_part-2.bsp \
  --start 14000-01-01T00:00:00TDB --years 2924.1047 \
  --output validation-2924y.json
```
