# Audio restructuring — agent index

Entry point for the audio work. Written for a fresh agent with no chat history:
read this file first, then whichever of the linked files the task needs.

- [done.md](done.md) — **past**: what has shipped, and why each decision was made that way.
- [roadmap.md](roadmap.md) — **future**: what is planned, in order, with the open questions
  that block some of it.
- [conventions.md](conventions.md) — the project rules and audio-specific invariants that a
  change here must not break. Read before writing code.
- [human.md](human.md) — arx-ein's own notes. **Read only. Never write to it.**

## Where the work sits

`src/audio/` is now four modules plus one data file:

| file | holds | lines |
| --- | --- | --- |
| `audio-engine.ts` | `AudioEngine` — AudioContext lifecycle (`unlock`), shared white-noise buffer, and the `tone`/`noiseBurst` primitive voices everything else is built from | 70 |
| `bgm.ts` | `Bgm` — the music engine: lookahead scheduler, track rotation, volume persistence, preview. Holds no composition of its own | 250 |
| `bgm-tracks.ts` | `BgmTrack` schema + `BGM_TRACKS` — each track described in full: scale, tempo, both pulse voices, pad/drone/sparkle layers, transposition and octave cycles | 362 |
| `world-sfx.ts` | `WorldSfx` — sounds emitted by objects/events in the game world, plus the thrust/RCS loop channels | 262 |
| `ui-sfx.ts` | `UiSfx` — position-less operation/notification blips | 12 |

Nothing else in the repo synthesizes audio. There are no audio-file assets and that is a
deliberate design choice worth keeping (recorded in `DEVELOP/SPEC.md` §8).

## Past — four pieces of work, all shipped

The whole of hedalu244's `memos/hedalu244/sfx_todo.md` "sfxとbgmの分離" plan is done and that
section has been deleted from their memo. Details and rationale in [done.md](done.md).

1. `56818a69` extract `AudioEngine` + `Bgm` out of the old `Sfx` monolith.
2. `f3a4b8a7` fix BGM staying silent forever after a stopped track preview.
3. `6afff4e5` split the rest of `Sfx` into `WorldSfx` / `UiSfx`, narrow ~20 injection sites.
4. the BGM engine/data split — `BgmTrack` now carries each track's whole structure.
   Verified sound-identical over 54,240 scheduled notes; see [done.md](done.md) §4.

## Present — nothing in flight

Branch `workspace5`, on top of `5ff773e4` (the current `main`, which brought the deferred
rendering pipeline in). `npm run typecheck` green.

**Not reviewed by hedalu244 or mikanixonable yet**, and not smoke-tested by ear — see the
"before handing off" list in [done.md](done.md).

## Future — the tracks can now be made distinct

With the split done, giving each track its own transposition plan, cadences and levels is a
pure data edit in `bgm-tracks.ts`, and it is the cheapest real improvement left. The stereo
output bus is the highest-value structural one (the mic system needs it too). The mic system
itself is the biggest remaining piece but is **blocked on a design question hedalu244 raised
themselves** — do not start it without asking. Full ordering in [roadmap.md](roadmap.md).
