# Molecular Nodes compatibility probe

Probe date: 2026-08-24

- Blender found: `/Applications/Blender.app/Contents/MacOS/Blender`
- Blender version: 5.0.1
- Embedded Python: 3.11
- Molecular Nodes installed: no
- Background import probe: `ModuleNotFoundError: No module named 'molecularnodes'`
- Latest checked Molecular Nodes release: 4.5.13; manifest requires Blender >= 5.1.0 and ships CPython 3.13 wheels, so it is not installable into this Blender.
- Compatible candidate checked: Molecular Nodes 4.4.3; manifest requires Blender >= 4.4.0 and ships CPython 3.11 wheels. It is a viable installation candidate for a separate local Blender 5.0.1 test, but it is not installed in the current environment.

`build-protein.py` now invokes `blender-export-protein.py` whenever Blender is found. Missing/incompatible Molecular Nodes returns a non-zero exit code and never invokes the JSON fallback. The fallback remains available only when Blender is absent.
