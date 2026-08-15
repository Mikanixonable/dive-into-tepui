# Past — what has shipped

Three commits on `workspace5`, in order. Each was typecheck-green on its own and carried its
own documentation updates in the same changeset (project rule — see [conventions.md](conventions.md)).

---

## 1. `56818a69` — extract `AudioEngine` and `Bgm` from `Sfx`

The old `src/audio/sfx.ts` (519 lines) was three things fused together: the AudioContext
lifecycle, ~15 one-shot synthesized effects, and the entire BGM engine. `memos/hedalu244/refactoring_todo.md`
had already flagged it as far over the project's 200-line module standard.

**New `audio-engine.ts`** owns the AudioContext (`null` until `unlock()` on a real user
gesture; re-`resume()`s a context the browser suspended later), the shared white-noise
buffer, and the two primitive voices `tone()` / `noiseBurst()`.

> Why the primitives live on the engine rather than in a separate `synth.ts` of free
> functions: both SFX classes need them, duplicating them would violate the no-duplication
> rule, and free functions taking `(ctx, noiseBuf, …)` would just be the engine's own fields
> passed back into it. `toneAt` stayed private to `Bgm` — only music uses it, and its
> signature (scheduled time, attack envelope, custom destination) is music-specific.

**New `bgm.ts`** took the whole music engine verbatim: the 120 ms lookahead scheduler, the
three-tier phasing composition, the ~5-minute track rotation, volume persistence to
`localStorage` under `tepui.settings.bgm_vol`, and the settings-view preview. Internal names
dropped their now-redundant `bgm` prefixes (`bgmStep` → `step`, etc.).

**Two design decisions worth remembering:**

- **The thrust/RCS loop channels moved from unlock-time construction to lazy construction**
  inside `Sfx`, built on the first `setThrust`/`setRcs` call once the context exists. This
  removed the only reason `unlock()` would have had to notify its consumers. `ThrustEffects.sync`
  calls `setThrust` every frame, so the channels materialize immediately after unlock anyway,
  and their gains start at 0 — behavior is identical.
- **`Bgm.autoStart()` exists because BGM must start exactly once**, when the context first
  becomes available. It is guarded by a private `autoStarted` flag that `playTrack()` also
  sets, so auditioning a track in the settings view forfeits the auto-start — otherwise
  stopping a preview could be undone by the next keypress in game. `main.ts` wires
  `input.onUserGesture = () => { audioEngine.unlock(); bgm.autoStart(); }`.

`Game` lost its only audio-lifecycle line (it had held the `unlock` wiring) and now just
passes the SFX reference around.

---

## 2. `f3a4b8a7` — resume BGM after closing a stopped preview session

`Bgm.resume()` arrived with the settings view but had no caller, so stopping a track preview
left the game silent for the rest of the run.

**The rule implemented**: `SettingsView` snapshots `bgm.isPlaying` when it opens
(`bgmPlayingAtOpen`), and on close calls `bgm.resume()` only if that snapshot was true and
the BGM is stopped now — it restores exactly what the preview session broke, nothing more.

| situation | result |
| --- | --- |
| preview → 試聴を停止 → close | BGM resumes (4 s fade-in). This was the bug. |
| preview still playing at close | no restart; that track simply continues as the BGM |
| BGM already off at open (run-end fade-out, title screen) | left alone — a decided run's silence is never resurrected |

Also in this commit: `Bgm` gained a one-line `isPlaying` getter; each open starts a fresh
preview session (the 再生中 highlight resets on close, so it cannot go stale against the
5-minute rotation); and `DEVELOP/SPEC.md` §8's second bullet was corrected — it still
described a long-gone "A minor, 8-bar loop, Am–F–G–Am" BGM instead of the actual phasing
engine.

---

## 3. `6afff4e5` — split `Sfx` into `WorldSfx` and `UiSfx`

The three-way boundary hedalu244 asked for in `sfx_todo.md` ("BGM / UIのsfx / 位置に応じて
変わるsfx"). `sfx.ts` was renamed to `world-sfx.ts` (git recorded it as a 96 %-similar
rename) and `ui-sfx.ts` was added.

- **`WorldSfx`** — everything a ship or entity emits: gun one-shots, hits, clanks,
  explosions, near-miss, pickup, and the thrust/RCS loop channels. **This is the class the
  future mic system will parameterize**, which is the whole reason the boundary is drawn here.
- **`UiSfx`** — `warp()`, the operation/notification blip. That is currently its only method.

**`altAlarm` was classified as a world sound, reversing an earlier lean.** It reads like a
cockpit UI warning, but `ThermalSystem` runs for *every* ship, so today a distant CREATIVE-mode
ship decaying beeps at full volume. `sfx_todo.md` explicitly says audio must not be gated on
whether a ship is the operated one — so as a shipboard klaxon it is exactly what the mic
model should attenuate later, and putting it in `UiSfx` would have hidden that bug instead of
leaving it where the fix will land.

**Injection was narrowed so each consumer declares only the audio reach it actually uses**:
`SimSpeedManager` / `PlanEditor` / `PlanGuide` take `UiSfx`; `Logistics` alone takes both (a
spawn-notification blip plus the pickup sound); the entire entity/stage/docking graph
(`Player`, `Enemy`, `Bullet`, `DebrisPiece`, `Base`, `EffectsSystem`, `EntityManager`,
`Docking`, `Launcher`, the spawners, `WaveAttack`) takes `WorldSfx`. `StageDeps` carries
`worldSfx, uiSfx`.

**Two side effects of that narrowing:**

- The project's **"hud/sfx は必ず対で注入する" policy is retired** — injection by actual use
  replaces it. This is recorded in `DEVELOP/OWNERSHIP.md`'s shared-reference table, which now
  has separate `Hud` and `WorldSfx`/`UiSfx` rows.
- `Targeter`'s `sfx` constructor parameter, which existed *only* to honour that policy and
  was never stored, is gone. This closes the 引数整理 item in
  `memos/hedalu244/refactoring_todo.md` (deleted from that memo, per its own "完了した項目は
  消す" rule), along with the completed 分離 section of `sfx_todo.md`.

---

## 4. Split the BGM engine from its composition data

`Bgm.scheduleStep` had a lot of *composition* hardcoded into engine code: the transposition
table `[0, 2, 3, 1]` and its 192-step cycle, the 768-step octave shift, the pad/drone/sparkle
cadences, the per-layer levels and lengths, and the sparkle's three hand-scheduled echoes.
All five tracks therefore shared one structure and could differ only in pitch material.

**`BgmTrack` now describes a track in full** — `scale`, `stepDur`, two `PulseVoice`s (pattern,
waveform, level, length, attack, step offset, optional detuned harmonic), a `PadLayer`, a
`DroneLayer`, an optional `SparkleLayer`, and two `PhaseCycle`s (`transpose`, `octave`).
`scheduleStep` reads all of it off the track and holds no composition of its own.

Engine-side helpers that came out of it: `phaseValue(cycle, step)` (both the transposition and
the octave shift are "a cycle of values, each held for N steps" — one helper, two uses),
`scaleFreq(...)` (was the `getFreq` closure), and a private `scheduleVoice` so voice A and
voice B go through one path. `SEMITONES_PER_SCALE_STEP = 2` is named at module level; it is
the approximation that converts a scale-step transposition into a frequency ratio for the
pad/drone layers, which are given in Hz and so cannot transpose by index.

**Verified sound-identical, not assumed.** A throwaway harness transpiled both the `HEAD` and
working-tree versions of `bgm.ts` + `tracks/tracks.ts`, stubbed `toneAt` as a recorder, and ran
3072 steps (two full 1536-step super-cycles) for every track:

> 54,240 scheduled notes compared across 5 tracks — frequency, time, duration, volume,
> waveform and attack all bit-identical.

That is the property this commit is supposed to have: it is a mechanism change, and
**every track still carries the values the engine used to hardcode**, so nothing sounds
different yet. Actually differentiating the tracks is a follow-up data edit — deliberately
kept out of this commit so the refactor could be proven inert.

`tracks/tracks.ts` grew 106 → 362 lines. That is the cost of each track being self-describing,
and it is a data file rather than a logic module, so the project's 200-line module standard
does not apply the way it does to `game.ts`.

---

## 5. Separate playback control from note generation

`bgm.ts` had grown to two responsibilities: controlling *when* music plays (volume, fades,
rotation, preview) and generating *what* it plays. arx-ein called this out and asked for the
split, both to loosen the coupling and as a stepping stone toward tracks whose **inner
workings** differ, not just their parameters.

Three files now:

| file | responsibility |
| --- | --- |
| `bgm.ts` | playback control: volume + persistence, fade in/out, track rotation, the lookahead pump, and turning a note into WebAudio nodes (`playNote`) |
| `composer.ts` | the `Composer` seam: `stepDurSec` + `notesAt(step): readonly ComposerNote[]` |
| `composers/phasing-composer.ts` | `PhasingComposer` — the Reich-style algorithm, the only one so far |

**The seam is deliberately WebAudio-free.** A `ComposerNote` carries its onset as
`offsetSec` *relative to the step*, not an absolute `AudioContext` time, so a composer never
names an audio type and is a pure function of `step`. That is what makes an algorithm's output
readable and comparable without an `AudioContext` — the equivalence harness below depends on
it, and so will any future composer's verification.

Naming follows arx-ein's own sketch (see [roadmap.md](roadmap.md) §2) so the planned conductor
layer slots in above without a rename. Note `render/pipeline/` separately uses "composite" for
its final render pass; different folder, different domain, but worth knowing if the collision
ever grates.

Small things that came with it: the pump/lookahead/fade/rotation magic numbers are now named
constants, `selectTrack` is shared by startup and rotation, and `nextTrackIndex` gained a
guard for a single-track registry — the old expression computed an out-of-range index when
`BGM_TRACKS.length === 1` and would have crashed on the first rotation. Latent, never hit with
five tracks, fixed while the code was open.

**Verified sound-identical again** with the same harness, updated to read
`PhasingComposer.notesAt` on the new side and `Bgm.scheduleStep` on the old: 54,240 notes
across 5 tracks, bit-identical. `bgm.ts` went 250 → 172 lines.

---

## 6. Foldered `src/audio/`, and Compositor -> Composer

Two housekeeping changes arx-ein asked for.

**Folders.** `src/audio/` was seven flat files. It is now `audio-engine.ts` at the root plus
`bgm/` and `sfx/`, matching the shape `src/game/` uses (shared thing at the root, concerns in
subfolders). The engine stays at the root because both folders build on it. `tracks/tracks.ts`
keeps its prefix inside `bgm/` — it is named after its exports (`BgmTrack`, `BGM_TRACKS`), the
same way `plan/plan-path.ts` is.

**Rename.** `Compositor` -> `Composer` (`CompositorNote` -> `ComposerNote`,
`PhasingCompositor` -> `PhasingComposer`, and both file names). "Compositor" collides with the
render pipeline's composite pass and historically means a typesetter; a composer writes music,
which is what the interface does. Cheap now, and per the project's no-traces rule the old name
returns zero hits.

25 files outside `src/audio/` had import paths rewritten. Verified with the same harness —
still 54,240 notes identical — and the harness is now pinned to commit `33524dc9`, the last
one where the composition logic lived in `Bgm.scheduleStep`, so it stays a valid reference for
any further restructuring.

---

## 7. Tracks became a discriminated union, with a blank slate for the second algorithm

Step 1 of roadmap §2d. `BgmTrack` was the phasing algorithm's parameter type with a `name`
bolted on; it is now a union over `kind`:

```ts
export type BgmTrack =
  | { kind: 'phasing'; name: string; params: PhasingParams }
  | { kind: 'sketch';  name: string; params: SketchParams };
```

`name` is the only common field — the test being *what does a consumer read without caring
which kind it is?* (`SettingsView` reads it for the preview list; nothing outside the factory
reads `params`). Today's schema became `PhasingParams`, unchanged apart from losing `name`.

**`bgm/composer-factory.ts` is the single place the union is switched on**, in its own file
because it must import every implementation while the implementations import the seam —
putting it in `composer.ts` would be an import cycle. Its `default` branch assigns to `never`;
this was checked by temporarily adding a `'canon'` kind, which failed compilation at exactly
that line, then reverting.

**`bgm/composers/sketch-composer.ts` is the blank slate** — implements `Composer`, returns no notes, and
has **no `BGM_TRACKS` entry**, so rotation can never land on silence. The music is arx-ein's to
design; when `notesAt` returns something, add a track for it. If it wants scale-index-to-Hz
conversion, `composers/phasing-composer.ts`'s `scaleFreq` is already in a shape that can be lifted into a
shared module — deliberately not done in advance, since which helpers the second algorithm
actually wants is unknown until it exists.

Still 54,240 notes identical against the `33524dc9` reference.

---

## 8. Playback extracted from the conductor

Step 2 of roadmap §2d, no crossfade. `Bgm` now conducts — which track, when, user volume, the
one scheduler pump — and `bgm/track-playback.ts`'s `TrackPlayback` is one sounding piece: its
own gain, its `Composer`, its step position, `scheduleUntil(deadline)` and `playNote`.

**The two gain layers landed with it**, because they are what makes the split mean anything:
the master gain (user volume, outlives every track) and the playback gain (that piece's fade).
One node doing both would have `setVolume` and a fade ramping the same `AudioParam`, where the
later call cancels the earlier one's shape.

**`Bgm` holds `TrackPlayback | null`, not a list.** Nothing plays two pieces at once yet, and a
list without a crossfade would be speculative. Making that field plural *is* the crossfade
change — which is the whole reason the unit was extracted now.

Two details that had to be preserved rather than reinvented:

- **Rotation must not restart the beat.** The old code kept one gain and one `nextTime` across
  a track change, so the new track continued on the same grid. The new `openPlayback` takes
  the outgoing playback's `nextStepTime` as the incoming one's start, reproducing that.
- **Rotation must not fade in.** Only `start()` fades; `TrackPlayback` opens at full gain and
  `fadeIn()` is a separate call, so a mid-session track change stays the hard cut it was.

**Verified end-to-end, not just at the composer.** A second harness drives both the `33524dc9`
`Bgm` and the new one through a fake `AudioContext` (stubbed `setInterval`, pinned
`Math.random`, `playTrack(0)` for a deterministic opening track), pumps 400 simulated seconds
— **crossing the 300 s rotation** — and compares every scheduled oscillator with its note-gain
envelope:

> 3537 scheduled notes identical, and the routing asserted as
> `note -> noteGain -> playbackGain -> masterGain -> destination`.

The one intended difference is the fade curve: previously one exponential ramp `0.0001 ->
volume`; now `0.0001 -> 1` on the playback gain times a constant master. Same endpoint, same
shape, different starting infinitesimal — inaudible, and not claimed as bit-identical.

---

## 9. Preview no longer rotates

The settings-view 試聴 shared `pump()`'s 5-minute rotation, so auditioning a track long enough
swapped it. With the conductor role explicit this is one flag: `Bgm.rotates`, set true by
`start()` and cleared by `playTrack` right after.

It belongs to the conductor, not to `TrackPlayback` — the playback has no opinion about why it
is sounding — and it is not two playback modules, which was the first idea floated.

Checked with a fake `AudioContext` over 700 simulated seconds, `Math.random` pinned: preview
stays on `[0]`; ambient rotates `[2,1,2]`; and stopping a preview then resuming rotates again
`[0,2,1]`, so opting out does not leak into normal playback.

---

## 10. bgm/ sub-foldered, tracks split from their types

Layout arx-ein asked for. `bgm/` root now holds only the four modules that are one-of-a-kind
— `bgm.ts` (conductor), `track-playback.ts` (one sounding piece), `composer.ts` (the seam),
`composer-factory.ts` (kind -> implementation) — with the two growing sets in their own
folders: `composers/` for the algorithms and `tracks/` for the data.

`bgm-tracks.ts` split into `tracks/types.ts` (the `BgmTrack` union first, then one
comment-fenced section per composer's params) and `tracks/tracks.ts` (`BGM_TRACKS` itself).
`create-composer.ts` became `composer-factory.ts` so it does not read as one more
`*-composer.ts` implementation.

**Why the fenced schema file rather than each composer owning its params**: the params are
what a *track author* reads, and a track author wants one file listing every shape a track can
take. The composer implementer is the other audience, and they already have the fence to work
within. Colocation is the plausible alternative if `types.ts` ever gets unwieldy — composers
would export their own params and `types.ts` would import them to form the union, which stays
cycle-free because composers do not import the union.

Dependency direction after the move, all one-way:
`tracks/types.ts` (imports nothing) <- `tracks/tracks.ts`, `composers/*`, `composer-factory.ts`;
`composer.ts` (imports nothing) <- `composers/*`, `track-playback.ts`, `composer-factory.ts`.

All three harnesses re-run. Note that `compare-playback.mjs` had to switch from `playTrack(0)`
to `autoStart()`: the preview no longer rotates by design, so driving the preview path made the
old and new diverge legitimately at the 300 s mark. It now compares the ambient path and again
reports every scheduled note identical across a rotation. Their shared module loading moved
into a `load-bgm.mjs` helper, so the next move only needs one file updated.

---

## The rebase onto the new `main` (`5ff773e4`)

Upstream landed the deferred rendering pipeline while this branch was in flight, and it
touched the same paragraphs and the same `main.ts` lines. **Every conflict was a union, not a
contradiction** — nobody rewrote the same fact two different ways. The resolution pattern, if
this branch ever needs rebasing again:

> Keep upstream's new content, then re-apply the audio changes on top of it.

- `src/main.ts` (6 hunks): upstream threads a `RenderPipeline` into `initHud` (so `PauseMenu`'s
  描画 tab can write `debugTarget`) and builds `gpu`/`pipeline` ahead of it. Final shape is
  `initHud(graphics, pipeline)` returning the full audio set, and
  `new Game(gs, stageClass, hud, worldSfx, uiSfx, pauseMenu, …, graphics, pipeline, earthSpinPhase0, initialSave)`.
- `CLAUDE.md` (6 hunks) and `DEVELOP/OWNERSHIP.md` (4 hunks): upstream added pipeline prose to
  the same bullets/nodes the audio edits touched. Kept both sides' additions.
- `DEVELOP/CALLSTACK.md`, `SPEC.md`, `game.ts` and ~35 other files auto-merged.

After the rebase I re-checked ten specific claims the resolved docs make against the merged
source (initHud's signature, who builds `WorldSfx`/`UiSfx`, `PauseMenu`'s pipeline argument,
`SettingsView(…, bgm)`, `Launcher(…, worldSfx, bgm)`, the gesture wiring, `Game`'s argument
order, `bgm.stop()` at run end, `EnvironmentScene` receiving `pipeline.sunLight`) — all pass.

---

## Before handing off to the other contributors

- [ ] **Smoke test by ear** (`npm run dev`): fire, reload, warp blip, altitude alarm, BGM
      start on first input, and the preview → stop → close → resume path. None of the three
      commits was meant to change how anything sounds; all of it was re-plumbing.
- [ ] The three commits have **not been reviewed** by hedalu244 or mikanixonable yet. The
      retired hud/sfx pairing policy in particular is their call to confirm, since it was
      their convention.

## Deliberately left alone

- **`AGENTS.md` (repo root) still says `Sfx.clank()`.** It also describes architecture that has
  been gone for months (`resolvePhysicalCollisions`, a 5 m `PLAYER_RADIUS`), so it needs a
  decision — regenerate or delete — not a one-word patch. Not an audio task.
- **Dated reports under `memos/*/done/`, `refactor_lifecycle.md` etc. keep their historical
  `Sfx` references.** Renaming identifiers inside archived analyses would falsify what they
  recorded at the time. The no-traces rule applies to live code and live docs, not to history.
