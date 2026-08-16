# Audio restructuring — agent index

Entry point for the audio work. Written for a fresh agent with no chat history:
read this file first, then whichever of the linked files the task needs.

- [done.md](done.md) — **past**: what has shipped, and why each decision was made that way.
- [roadmap.md](roadmap.md) — **future**: what is planned, in order, with the open questions
  that block some of it.
- [conventions.md](conventions.md) — the project rules and audio-specific invariants that a
  change here must not break. Read before writing code.
- [disposal.md](disposal.md) — what `dispose()` means in this repo, how much of it applies to
  audio (less than it looks), and the one leak the audit found in `Bgm`.
- [human.md](human.md) — arx-ein's own notes. **Read only. Never write to it.**

## Where the work sits

`src/audio/` is the shared substrate at the root plus one folder per concern:

```text
audio/
  audio-engine.ts          AudioContext lifecycle (unlock), shared noise buffer,
                           and the tone/noiseBurst primitive voices
  bgm/
    bgm.ts                 the app-facing window: user volume (master gain), the one
                           lookahead pump, and the musical lines it advances
    conductor.ts           one musical line: which track, when it gives way to the
                           next, the piece sounding, and this line's own gain
    track-playback.ts      one sounding piece: its own gain, composer, step
                           position, and note -> WebAudio
    composer.ts            the note-generation seam. Names no WebAudio type
    composer-factory.ts    the single switch from a track's kind to its composer
    instrument.ts          the sound-making seam: play(freq, when, duration, velocity)
    instrument-factory.ts  the single switch from an instrument's kind to its class
    composers/
      utils.ts             cycle lookup + index -> frequency, shared by the composers
      phasing-composer.ts  the Reich-style algorithm
      antipode-composer.ts the second algorithm; still a sketch
    instruments/
      types.ts             InstrumentDef union + params, fenced per instrument
      tone-instrument.ts   one oscillator + envelope + pan
      unison-instrument.ts detuned stack through a shared filter
    tracks/
      types.ts             BgmTrack union + params, fenced per composer
      tracks.ts            BGM_TRACKS, the data itself
  sfx/
    world-sfx.ts           sounds emitted by objects/events in the game world,
                           plus the thrust/RCS loop channels
    ui-sfx.ts              position-less operation/notification blips
```

作曲用のプレビューは `tools/bgm-lab/`(`npm run bgm-lab`)。ゲームを起動せずに1曲を鳴らす。

`audio-engine.ts` stays at the root because both folders build on it — the same shape
`src/game/` uses (an orchestrator at the root, concerns in subfolders).

Nothing else in the repo synthesizes audio. There are no audio-file assets and that is a
deliberate design choice worth keeping (recorded in `DEVELOP/SPEC.md` §8).

## Past — what has shipped

The whole of hedalu244's `memos/hedalu244/sfx_todo.md` "sfxとbgmの分離" plan is done and that
section has been deleted from their memo. Details and rationale in [done.md](done.md).

1. `56818a69` extract `AudioEngine` + `Bgm` out of the old `Sfx` monolith.
2. `f3a4b8a7` fix BGM staying silent forever after a stopped track preview.
3. `6afff4e5` split the rest of `Sfx` into `WorldSfx` / `UiSfx`, narrow ~20 injection sites.
4. the BGM engine/data split — `BgmTrack` now carries each track's whole structure.
   Verified sound-identical over 54,240 scheduled notes; see [done.md](done.md) §4.
5. the playback/generation split — `Bgm` controls playback, a `Composer` generates the
   notes. Same verification; see [done.md](done.md) §5.
6. the `BgmTrack` union + a blank second composer, then `bgm/` sub-foldered into
   `composers/` / `instruments/` / `tracks/`; see §10.
7. the `Instrument` seam, which is also where per-instrument pan came from; see §11.
8. discarded playbacks are disconnected rather than merely faded — 85 stranded audio nodes
   an hour down to 8; see §12 and [disposal.md](disposal.md).
9. `Conductor` extracted: one class per continuous musical line; see §13.
10. 線ぶんのゲインと pause/resume、そして試聴を独立した線にする(§14–15)。
11. 伏せる指示が線の遅延生成をまたぐ修正と、`beginAudition` / `autoStartUsed` への整理。
12. 作曲用プレビュー `tools/bgm-lab/`(`npm run bgm-lab`)。

Everything above is on `main`. PR #4 carried items 1–8 and was merged after being confirmed
by ear.

## Present

Branch `workspace5` on the shared repo (`origin` is Mikanixonable's; every contributor has a
`workspaceN` branch there). `npm run typecheck` green, 8 harnesses green. PR #5 carries items
9–12 and is open.

Roadmap §2 の第五段まで完了。次は §1 の作曲そのもので、そのための `npm run bgm-lab` も
用意してある。構造の宿題として残っているのは §2a-1(伏せるだけの pause を本来の形へ)と
§2c(クロスフェード)。

## Future — the tracks can now be made distinct

Giving each track its own transposition plan, cadences and levels is now a pure data edit in
`tracks/tracks.ts`, and it is the cheapest real improvement left. **The two-line design
(gameplay music and auditioning as independent `Conductor`s) is recorded in
[roadmap.md](roadmap.md) §2a**, and it exists to keep auditioning from perturbing the
adaptive-music state the gameplay line will carry — read it before building anything above
`Conductor`. The mic system is the biggest remaining piece but is **blocked on a design
question hedalu244 raised themselves** — do not start it without asking.
