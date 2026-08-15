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
| `bgm.ts` | `Bgm` — the music engine: lookahead scheduler, track rotation, volume persistence, preview | 232 |
| `bgm-tracks.ts` | `BGM_TRACKS` — composition data, one entry per track | 106 |
| `world-sfx.ts` | `WorldSfx` — sounds emitted by objects/events in the game world, plus the thrust/RCS loop channels | 262 |
| `ui-sfx.ts` | `UiSfx` — position-less operation/notification blips | 12 |

Nothing else in the repo synthesizes audio. There are no audio-file assets and that is a
deliberate design choice worth keeping (recorded in `DEVELOP/SPEC.md` §8).

## Past — three commits, all shipped

The whole of hedalu244's `memos/hedalu244/sfx_todo.md` "sfxとbgmの分離" plan is done and that
section has been deleted from their memo. Details and rationale in [done.md](done.md).

1. `56818a69` extract `AudioEngine` + `Bgm` out of the old `Sfx` monolith.
2. `f3a4b8a7` fix BGM staying silent forever after a stopped track preview.
3. `6afff4e5` split the rest of `Sfx` into `WorldSfx` / `UiSfx`, narrow ~20 injection sites.

## Present — nothing in flight

Branch `workspace5`, rebased onto `5ff773e4` (the current `main`, which brought the deferred
rendering pipeline in). Working tree clean, `npm run typecheck` green, no uncommitted work.

The three commits above are the branch's entire content. **They have not been reviewed by
hedalu244 or mikanixonable yet**, and they have not been smoke-tested by ear — see the
"before handing off" list in [done.md](done.md).

## Future — next step is the BGM engine/data split

The recommended next piece of work is pulling the hardcoded composition constants out of
`Bgm.scheduleStep` into the `BgmTrack` schema; it is low-risk and it unlocks most of the
artistic ideas. The mic system (positional audio) is the biggest remaining piece but is
**blocked on a design question hedalu244 raised themselves** — do not start it without
asking. Full ordering and reasoning in [roadmap.md](roadmap.md).
