# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

A playable LEO (low Earth orbit) shooting game: TypeScript + Webpack + npm, Three.js `WebGPURenderer` (via the `three/webgpu` entry point). Real-scale/real-time Earth orbit, KSP-style frame-based RCS translation (orbital / target reference frames), manual rotation with RCS damping, time warp, lead-marker gunnery, shell casings and destruction debris on accurate orbital physics, win on destroying all 5 enemies, lose on atmospheric reentry (drag decay → adiabatic-heating overheat or dynamic-pressure breakup). Also: Earth-shadow lighting, a KSP-style navball (canvas 2D, bottom center), and target-board bullet-pass markers for aim correction.

`dev.md` is explicitly marked as human-authored only ("この文書は人間のみが記入できる") — do not edit it. Read it for project context, but leave modifications to the user.

### Commands
- `npm run dev` — start webpack-dev-server at http://localhost:8080
- `npm run build` — production build to `dist/`
- `npm run typecheck` — `tsc --noEmit`

There is no automated test suite wired into npm. Physics can be verified by compiling `src/physics/*.ts` to CommonJS with `tsc` and running assertions in node (pure functions, no DOM/THREE deps).

### Architecture

Simulation state lives in ECI coordinates (Y axis = north pole), SI units (m, m/s), as plain `{x,y,z}` data. Rendering uses a **floating origin**: the player ship is always at world (0,0,0) and everything else (including the Earth mesh at `-playerR`) is positioned relative to it each frame, so f32 GPU precision never sees absolute LEO magnitudes. Camera: near=2m, far=6e7m — no logarithmic depth needed (see comment in `scene.ts`).

Physics runs on the main thread (per-entity central-gravity two-body integration is cheap); the N-body worker is **currently unused**, kept for the future cislunar (Sun-Earth-Moon) phase.

- `src/main.ts` — entry point; WebGPU init, error overlay fallback, rAF loop driving `Game.update`.
- `src/game/game.ts` — orchestrator: entity management, substepped integration (higher warp → more substeps, max 20s each), input→thrust/torque, segment-vs-sphere bullet collision (tunneling-proof), win/lose, render sync, HUD markers (boresight/lead/prograde/target).
- `src/game/const.ts` — all gameplay tuning constants (thrust, warp levels, fire rate, hit radii...).
- `src/game/navball.ts` — canvas-2D attitude ball (body frame: +X right/+Y up/+Z nose); sphere is repainted per frame via a per-pixel dot product against the body-frame Earth direction (cheap: rotate Earth dir into body frame once, not per pixel).
- `src/physics/atmosphere.ts` — piecewise-exponential density model (Vallado table, 0–1000 km). Drag (Cd·A/m per entity class, co-rotating atmosphere) is applied as the RK4 extra-acceleration; player hull temp uses Sutton–Graves stagnation heating + Stefan-Boltzmann radiative cooling (see `updateThermal` in game.ts).
- `src/game/{input,camera,hud,audio,entities}.ts` — keyboard/mouse state + edge-trigger queue; ship-centered chase camera (up = radial); DOM-overlay HUD (panels, screen-projected markers, help, end screen); WebAudio synth SFX + lookahead-scheduled synth battle BGM loop (no assets; starts on first user gesture, stops on win/lose); entity type defs.
- `src/physics/orbital.ts` — central-gravity RK4 for one entity with optional extra-acceleration callback (thrust, evaluated per RK4 stage), state→orbital elements, ellipse sampling for orbit lines. Pure functions.
- `src/physics/attitude.ts` — rigid-body attitude: quaternion + body-frame ω via Euler's equations. ω integrated with RK4 + kinetic-energy projection (naive explicit integration diverges — this is what makes the Dzhanibekov effect on debris stable long-term). Pure functions.
- `src/physics/vec3.ts` — plain-object Vec3 math helpers.
- `src/physics/{bodies,integrator,physics.worker}.ts` — original N-body RK4 worker stack, unused by the LEO game; retained for the cislunar phase.
- `src/render/earth.ts` — realistic-style Earth: high-res indexed `SphereGeometry` (512×384) with smooth per-vertex colors from deterministic 3D fBm noise (continuous smoothstep-blended biomes, no facet jitter), clouds **baked into vertex colors** (a separate cloud shell z-fights with the surface near the horizon at 24-bit depth), additive BackSide atmosphere rim shells.
- `src/render/ships.ts` — primitive-built low-poly meshes: player ship (nose = body +Z), enemy variants, shared-geometry tracer bullets, casings, debris shards, billboard flash.
- `src/render/{stars,orbitline}.ts` — stars as tiny world-space triangles (WebGPU points are 1px; `THREE.Points` size doesn't work), sun billboard; orbit ellipse lines (`THREE.Line` — **`LineLoop` is unsupported by the WebGPU renderer**, close the loop manually).
- `src/types/three-shims.d.ts` — three.js 0.169 ships no `.d.ts` for `three/webgpu`; minimal `WebGPURenderer` typings. Remove once upstream types cover it. Import THREE **only** from `'three/webgpu'` (mixing with `'three'` would duplicate classes at runtime).

### WebGPU renderer gotchas (three.js 0.169)
- `THREE.LineLoop` and `THREE.Points` sizing are not supported; use `THREE.Line` / triangle-based sprites.
- Additive-blended materials need explicit `transparent: true`.
- Headless-Chrome screenshots work with `--headless=new --enable-gpu --enable-unsafe-webgpu --disable-gpu-sandbox --no-sandbox` (flaky; retry a few times).

Not yet implemented: J2/tidal perturbations, Sun/Moon perturbation, enemy AI (targets are passive), aurora effects, cloud shadows, ECS. See `dev.md` for design direction.

## Project concept (from dev.md)

An orbital-mechanics shooting game, intended as a web game, set in the Earth-Moon system (current build: LEO only):

- Gameplay centers on realistic orbital maneuvers and physically accurate ballistic calculations, low-poly but visually appealing depictions of Earth's atmosphere, spacecraft, and spacecraft destruction.
- Orbital calculations should account for Sun-Earth-Moon three-body dynamics, atmospheric drag, and tidal forces. Reference concepts to consider: Sun-Earth and Earth-Moon Lagrange points, sun-synchronous recurrent orbits, halo orbits, low-energy transfers and ballistic capture, double lunar swingbys, and gradual altitude-raising approach maneuvers (like the Kounotori HTV's ISS approach).
- Aesthetic goals: Earth auroras, auroras from solar storms, auroras from charged particles generated by combat, shadows on Earth's evening clouds, and the Dzhanibekov effect on destroyed debris.

## Controls (current build)

W/S = prograde/retrograde, A/D = normal±, Q/E = radial in/out (F switches to target-relative frame: approach/retreat/left/right/down/up). I/K/J/L/U/O = pitch/yaw/roll, T = RCS rotation damping, Tab = cycle target, Space / left click = fire, right drag / wheel = camera, `,` / `.` = time warp (thrust and guns locked above ×4), P = pause, H = help, R = restart (after game end).
