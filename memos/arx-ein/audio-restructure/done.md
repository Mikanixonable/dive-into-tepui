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
  becomes available. It is guarded by a private one-shot flag (now `autoStartUsed`) that the preview path also
  sets, so auditioning a track in the settings view forfeits the auto-start — otherwise
  stopping a preview could be undone by the next keypress in game. `main.ts` wires
  `input.onUserGesture = () => { audioEngine.unlock(); bgm.autoStart(); }`.

`Game` lost its only audio-lifecycle line (it had held the `unlock` wiring) and now just
passes the SFX reference around.

---

## 2. `f3a4b8a7` — resume BGM after closing a stopped preview session

`Bgm.resume()` arrived with the settings view but had no caller, so stopping a track preview
left the game silent for the rest of the run.

**The rule implemented**: `SettingsView` snapshots `bgm.isRunning` when it opens
(`bgmPlayingAtOpen`), and on close calls `bgm.resume()` only if that snapshot was true and
the BGM is stopped now — it restores exactly what the preview session broke, nothing more.

| situation | result |
| --- | --- |
| preview → 試聴を停止 → close | BGM resumes (4 s fade-in). This was the bug. |
| preview still playing at close | no restart; that track simply continues as the BGM |
| BGM already off at open (run-end fade-out, title screen) | left alone — a decided run's silence is never resurrected |

Also in this commit: `Bgm` gained a one-line `isRunning` getter; each open starts a fresh
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
`tracks/types.ts` <- `tracks/tracks.ts`, `composers/*`, `composer-factory.ts`
(it imports only `instruments/types.ts`, for the instrument list a track declares — see §18);
`composer.ts` (imports nothing) <- `composers/*`, `track-playback.ts`, `composer-factory.ts`.

All three harnesses re-run. Note that `compare-playback.mjs` had to switch from `playTrack(0)`
to `autoStart()`: the preview no longer rotates by design, so driving the preview path made the
old and new diverge legitimately at the 300 s mark. It now compares the ambient path and again
reports every scheduled note identical across a rotation. Their shared module loading moved
into a `load-bgm.mjs` helper, so the next move only needs one file updated.

---

## 11. Instruments — step 1 of roadmap §3

The note vocabulary carried its own synthesis (`wave`, `level`, `attackSec`), which capped what
a composer could ask for at "one oscillator". A note now names an **instrument** and a
**velocity**, and the instrument decides what that sounds like.

- `instrument.ts` — the seam: `play(freq, when, durationSec, velocity)`.
- `instruments/tone-instrument.ts` — the only implementation so far, reproducing the old voice
  exactly, plus a persistent `StereoPannerNode`. **Pan is a per-instrument parameter**, which
  is how the stereo item from §1 got absorbed.
- `instrument-factory.ts` — the same union+`never`-guard shape as `composer-factory.ts`.
- `TrackPlayback` builds the track's instruments once and looks them up by id; an unknown or
  duplicated id throws rather than going silently quiet.

**`level` → `velocity` is a boundary fix, not a rename.** Level is an absolute gain (a mixing
decision — it belongs to the instrument); velocity is how hard the note is struck, and the
instrument chooses what that drives. Today it scales gain; tomorrow it can open a filter.

The five phasing tracks each declare six instruments (`voiceA`, `voiceA-harmonic`, `voiceB`,
`pads`, `drone`, `sparkle`) derived mechanically from their old per-layer `wave`/`level`/
`attack`, with within-layer differences (the drone's quieter second voice, the sparkle's
decaying echoes) becoming velocities.

**Verified, and better than expected**: I budgeted for last-bit drift in gain, since velocity ×
level replaces a literal, and taught the harness a relative tolerance. It was not needed —
all 54,240 notes match exactly, because velocity is exactly 1 wherever it is not a ratio, and
the ratios round-trip. End-to-end, 3745 scheduled notes still match across a rotation, with
routing now asserted as `note -> noteGain -> instrumentPanner -> playbackGain -> masterGain ->
destination`.

Pans are all 0 in the migrated data, so nothing moved in the stereo field yet — placing the
layers is a data edit whenever you want it.

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

## 12. Discarded playbacks are disconnected, not just faded

Found while writing up upstream's disposal chain: nothing in `src/audio/` called `.disconnect()`,
so every track rotation, preview click and run boundary stranded a `TrackPlayback`'s gain and all
six of its instrument panners on `masterGain` for the rest of the session — 85 persistent nodes
after an hour where 8 is correct.

The fix hangs on one question, **"when has this piece gone quiet"**, and the first design got
that question wrong: it proposed waiting for the fade to finish. Rotation deliberately does not
fade at all (the pattern just switches and already-scheduled notes ring out), and once a piece's
oscillators have stopped nothing flows through its gain whatever the fade is doing — so the fade
is neither necessary nor sufficient. `TrackPlayback.soundingUntil` answers the real question from
what it already tracks while scheduling.

- `Instrument` gains a required `dispose()`; `ToneInstrument` disconnects its panner.
- `TrackPlayback` tracks its latest note end, exposes `soundingUntil` (+ `RELEASE_TAIL_SEC` for
  the instrument's own release), and disposes instruments then gain.
- `Bgm.retire(playback)` is the single retirement path, taken by both `stop()` and
  `openPlayback()` — the latter is what fixes rotation, which previously dropped the outgoing
  piece without so much as fading it.
- `Bgm` itself gets no `dispose()`, and `masterGain` stays. Nothing tears the audio layer down,
  and the repo rule is not to add one speculatively.

`RELEASE_TAIL_SEC` = 0.25 s was measured, not guessed: sweeping it shows 18 notes cut short at 0,
none at 0.04. The requirement is exactly `ToneInstrument`'s `+0.05` release past `durationSec`, so
0.25 is 5x headroom for a longer-tailed instrument.

Verified: 85 live nodes → 8, and 0 notes cut short across 40,887 scheduled in an hour. The other
four harnesses are unchanged, which is the important negative result — retirement moved no
scheduled sound. **The cut-note check itself was tested**: it first passed against a deliberately
broken margin because its instrumentation had silently failed to apply, and now reports 190 cuts
for that value. A harness never seen to fail proves nothing.


## 13. `Conductor` — one class per continuous musical line

Roadmap §2d step 3. Pure refactor: the ambient line only, no pause, no audition line.

`Bgm` was doing two jobs that stop being one job the moment there are two independent musical
lines. What moved out to `Conductor`: the current `TrackPlayback`, `trackIdx`/`trackStartTime`,
track selection (`nextTrackIndex`), rotation timing, `openPlayback`, `retire`, and the constants
that go with them (`START_DELAY_SEC`, `FADE_IN_SEC`, `TRACK_ROTATION_SEC`). What stayed on `Bgm`:
the master gain, the one `setInterval` pump and `LOOKAHEAD_SEC`, the volume and its persistence,
the auto-start latch, and the public API every caller already holds — `Launcher` and `SettingsView` are
untouched.

`Bgm.ambient` is `Conductor | null`, built lazily on first play, because a `Conductor` holds its
`AudioContext` and there is none before `unlock()`. That mirrors `masterGain`'s existing laziness
for the same reason. The auto-start latch stays on `Bgm` (decided with arx-ein): it is about the first
user gesture, which is an app-level event, not a property of any one line.

**`rotates` is still mutable, passed as `start(trackIdx, rotates)`.** With a single line,
`playTrack` still has to pin the track it was asked for, so the policy cannot yet be fixed at
construction — that happens in step 5, when the audition line makes it a per-line fact. Passing
it as an argument does remove the write-then-overwrite (`start()` set it true and `playTrack()`
set it false on the next line), so the smell is gone even though the field is not yet `readonly`.

Verified: all five harnesses green **with their assertions unchanged**, and `check-rotation`
reproduces the exact same track sequences as before the refactor — `[0]`, `[2,3,2]`, `[0,3,2]`,
same seed, same choices, same rotation timing. That identity is the whole evidence for this step.

One harness edit was needed and it is worth being precise about why it does not weaken that:
`check-rotation` observes which track is playing by reading a private field, and that field moved.
Re-pointing the probe from `bgm.trackIdx` to `bgm.ambient.currentTrackIndex` changes *how it
reaches* the value, not *what it asserts*. Changing an expectation would have been the thing to
distrust.


## 14. `Conductor.pause()` / `resume()`, and the line's own gain

Roadmap §2d step 4. Still unused — step 5 wires it — so nothing audible changed.

Ducking needs a gain the line owns, which is the routing change step 3 deliberately deferred:
`note -> noteGain -> panner -> playbackGain -> conductorGain -> masterGain`. **Three gain layers
now, and they cannot be collapsed.** Each has a different writer for a different reason — user
volume, this line ducking, this piece fading — and two writers on one `AudioParam` means the
later call cancels the earlier one's shape. There is also a concrete failure if the line ducked
through the *piece's* gain instead: rotation opens a new `TrackPlayback` at gain 1, so a paused
line would come back un-ducked the moment its track changed.

`pause()`/`resume()` are `setTargetAtTime` ramps to `DUCK_LEVEL` / 1 over `DUCK_FADE_SEC` (0.3 s).
The line keeps being advanced while ducked, so it resumes wherever it would have been rather than
where it left off — the interim recorded in roadmap §2a-1, upgradeable inside these two method
bodies plus a `resumeAt` on `TrackPlayback`.

New harness `check-pause.mjs` covers what is otherwise unreachable: the duck ramp, the restore
ramp, and that ticking continues across both. It carries an `EXPECT_NOTES_WHILE_PAUSED` flag at
the top — flip it to `false` when proper pause lands and the third assertion inverts, rather than
deleting the check. Verified it can fail: flipped, it reports `202 notes over the paused 20s`
against an expectation of zero.

Two existing harnesses needed updating, both because the *structure* moved rather than the sound:

- `compare-playback` asserts the routing chain by walking it, so it gained the `conductorGain`
  hop. **Its note comparison was untouched and still reports 3745 identical notes** — that is the
  part that would have caught an audible change, and it did not fire.
- `count-leaks` was inferring how many playbacks existed from the gain count, which the new
  permanent gain threw off (it started reporting a fractional leak). Rewritten around a stronger
  invariant that needs no such arithmetic: **live persistent nodes must not grow with session
  length.** 23 nodes built over 15 min and 86 over an hour, 9 live in both cases. That check
  survives further layers without edits, which the old one would not have.


## 15. The audition line — two `Conductor`s, and the bug goes away

Roadmap §2d step 5, and the first behavioural change since the merge.

`Bgm` now holds two lines. `ambient` is the gameplay music, built once and kept. `audition` is
built by `playTrack` and destroyed by `stopAudition`/`endAudition`, with its own gain and its own
chain to the master. `rotates` is a constructor argument on both, so it is a fact about a line
rather than a flag anyone can write — **the old bug is now unrepresentable**, not fixed: the
audition line has no way to reach gameplay's rotation policy, because it is a different object.

What the player sees: opening the settings view ducks the gameplay music, auditioning is heard on
its own line, closing destroys the audition and un-ducks gameplay. Stopping an audition leaves the
panel silent, since gameplay stays ducked while it is open.

`SettingsView` lost `bgmPlayingAtOpen` entirely. It existed because the view had to remember audio
state the audio layer did not; pause/resume is symmetric, so a line that was silent at open is
ducked and un-ducked back to silence with nothing to remember. The view now reports two events and
holds no audio state. `Bgm.isRunning` went with it — it had no other reader, and unused API is not
kept around.

Two supporting changes fell out. The pump is now shared and lifecycle-managed by a private
`syncPump()` — it runs while *any* line is sounding, rather than being started and cleared by
`start`/`stop` directly, which no longer works when a line can be silent while another plays.
And `Conductor.dispose(fadeSec)` fades, retires the piece, then disconnects the line's own gain
once it goes quiet — the whole-line counterpart of §12's per-piece retirement.

One deliberate consequence worth knowing: raising the volume from zero *inside* the settings view
now starts the gameplay line ducked, so it is heard on close rather than immediately. The pause
menu's slider is unaffected. That follows from the panel's premise — gameplay music is paused
while it is open — and the master gain still applies to the audition line, so the slider is
audible while previewing.

Verified. `check-rotation` was rewritten (this is the step where changing an expectation is the
point) and gained the two cases that pin the fix: **`ambient under audition` produces `[2,3,2]`,
byte-identical to plain ambient** — the audition disturbs nothing — and `ambient after close`
still rotates where the old code pinned it for the rest of the run. `count-leaks` gained an
audition-cycle scenario, since the audition line is created and destroyed repeatedly and
`Conductor.dispose()` was previously unexercised: **566 persistent nodes built over an hour of
auditions, 9 still live** — the same 9 as ambient alone. Confirmed that check can fail by breaking
the gain disconnect, which reports live nodes growing 24 -> 69.


## 16. 見直しで出た3件 — 遅延生成をまたぐ pause、対でない対、ラッチの帰属

arx-ein が `Bgm` を「共通 / ambient / audition」の3節へコメントで切り分けた際、`started` が
両方の conductor から書かれていて疎結合化の障害になっている、という指摘から出た3件。

**1. 伏せる指示が線の遅延生成をまたがなかった(不具合)。** `pause()` は `this.ambient?.pause()`
だけで、線がまだ組まれていないと指示ごと消えていた。そのあと線が作られると伏せられずに始まり、
試聴の上にゲーム側 BGM が全音量で重なる。到達経路はタイトル画面で設定を開き、音量を 0 から
上げる筋道。伏せているかを `Bgm` の private `paused` に持ち、`ensureAmbient` が線を組むときに
適用する。**SPEC.md は既に正しい挙動を書いていた** — 直したのは実装が追いついていなかったぶん。

**2. `pause()` と `resume()` が対ではなかった(罠)。** 前者は伏せるだけ、後者は「止まっていた
BGM を鳴らし始める」で、続けて呼ぶと伏せたまま鳴り続けて無音になる。実際の対は
`pause()`↔`endAudition()` と `resume()`↔`stop()` の2組。前者を出来事の名前
(`beginAudition`/`endAudition`)へ戻して衝突を解いた。

**3. `started` は「鳴っているか」ではなく「一度きりの自動開始を使い切ったか」だった。**
`autoStartUsed` へ改名し、`playAudition` からの書き込みを落として ambient 専用にした。その
書き込みは単一線時代の名残で、線が2本になった今は経路が消えている。

実効的な仕事が1点だけであることは測って確かめた。新設した `check-autostart.mjs` でラッチを
わざと外すと、「何度呼んでも開始は一度きり」は**通ったまま**で(`start()` が `isSounding` で
弾くため)、落ちるのは「`stop()` のあと以後の操作で鳴り出さない」だけ。決着で黙らせた BGM が
次のキー入力で蘇るのを止める、それがこのラッチの全部。

改名の取りこぼしも掃除した: `CLAUDE.md` と `OWNERSHIP.md` に `autoStart` / `playTrack` が
残っていた。ハーネス5本も旧 API 名で全滅していたので追随させた(`compare-playback` は BASE と
現行の両方を回すので、`ensureStarted` が無ければ `autoStart` を呼ぶ形にしてある)。

## 17. 作曲用プレビュー `tools/bgm-lab/`

ゲームを起動して曲が進むのを待たないと値の変更が聞けない、という作曲側の詰まりを外す道具。
`npm run bgm-lab` で 8081 番に立つ。1曲だけを鳴らし、**任意のステップから開始**、区間ループ、
声部ごとの抜き差し、各循環の現在位置の表示。`tracks/tracks.ts` を保存すると再読込され、曲・
開始位置・ミュートは `localStorage` から戻る。

要るのは「待たされない」ことなので、開始ステップが本体。既定の曲は step 長 0.42s、オクターブの
循環が 768 steps なので、**音域が動くまで実時間で5分24秒**かかる。そこを直接叩ける。

**音を作る側(`Composer` / `Instrument`)は本番と同じものを import する。** ここが別実装だと
聞こえ方がずれて、詰めた値が本編で再現しない。自前で持つのは刻みのループだけで、これは任意
ステップ開始と区間ループという本番に無い要求のために要る。そのぶんは
`check-lab-fidelity.mjs` が押さえていて、同じ曲・同じ開始位置で予約される発振器の列を
`TrackPlayback` と突き合わせる — 全6曲 6,753音が一致。刻み幅を 0.1% ずらすだけで落ちる。

構成は `lab-player.ts`(鳴らす仕組み、DOM を触らない)と `main.ts`(画面)に分けてある。前者を
DOM から切り離してあるのは、上の照合を node 上で回せるようにするため。ビルドは
`webpack.bgm-lab.config.js` で本体とは別 — こちらは保存のたびに再読込したいが、本体の config は
`liveReload: false`(実行中のゲームが再読込されると困る)なので、同居させられない。出力先も
`.bgm-lab/`(gitignore)で `docs/` には触れない。`tsconfig.json` の `include` に `tools` を
足したので、この道具も `npm run typecheck` の対象。


## 18. 楽器宣言の型を instruments/types.ts へ

`tracks/types.ts` が「トラック宣言の型」と「楽器宣言の型」の両方を抱えていた。`InstrumentDef` と
`ToneParams` を `instruments/types.ts` へ移し、楽器の実装と同じ階層に置いた。

**なぜ Composer の params は `tracks/` に残すのか。** 対称に見えないが、これは非対称でよい。
Composer の params は**曲の中身そのもの**(音階・パターン・カデンツ)で、`tracks.ts` の実体は
ほぼそれ。曲を編集することと Composer の params を編集することは同じ作業なので、型が `tracks/`
にあるのが自然。対して楽器宣言は**曲をまたいで共有される語彙**(どの曲も `tone` を使える)で、
トラックはそれを id で参照するだけ。だから楽器側の階層へ寄せる。

依存は一方向のまま。`instruments/types.ts` は何も import せず、`tracks/types.ts` がそれを引く
(`BgmTrack.instruments` のため)。循環は無い。

型だけの移動なので鳴り方は変わらない。ハーネス7本とも不変で、`check-lab-fidelity` の
6,753音一致もそのまま。


## The two merges of `main` into the PR branch (`4e21f958`, then `78370b6b`)

Upstream landed the **run-lifecycle rework** — `Launcher` owns the `Game` and recreates it
in-page, `Game.dispose()` became the root of a disposal chain, the HUD grew per-view roots —
while PR #4 was open, then landed `PlanAttractors` on top of that during the merge itself.
Both are merged in.

**Merge, not rebase, and that was the right call.** 11 of this branch's 14 commits touch the
conflict set; a rebase would have replayed the same three conflicts eleven times, against
intermediate states of `main.ts`/`launcher.ts` that never existed on either side. The merge
resolves each once. It also matches house style — `upstream/main` is itself a chain of merge
commits from the other contributors' workspaces. `git rerere` is on, so the seven recorded
resolutions replay automatically if this has to be redone.

Same union pattern as the earlier rebase, with one new wrinkle: upstream did not merely add
prose alongside ours, it **rewrote the paragraphs describing a lifecycle that no longer
exists**. So the resolution was "take upstream's rewritten text wholesale, then re-apply the
audio facts onto it" rather than keeping both sides.

- `src/launcher.ts` — upstream's `startRun`/`endRun` shape with the audio set threaded in.
  `SNAPSHOT_PENDING_KEY` and the `sessionStorage` stash are gone with the page-reload model.
  **`onUserGesture` moved inside `startRun`**: `Input` is rebuilt with every `Game`, so the
  `audioEngine.unlock()` + `bgm.autoStart()` wiring must be re-applied per run, not once at
  boot. `sfx.resumeBgm()` → `bgm.resume()`; run-end silence is
  `worldSfx.setThrust(false)` + `bgm.stop()`.
- `src/main.ts` — Launcher-owns-Game construction; `initHud` returns the four audio objects and
  passes them to `Launcher`, which no longer builds a `Game` here at all.
- `src/game/game.ts` — **a semantic conflict git merged cleanly.** Upstream's new
  `Game.dispose()` calls `this._sfx.setThrust/setRcs`; that field was renamed on this branch.
  No conflict marker, no textual overlap — `npm run typecheck` is what caught it. Worth
  remembering: a clean merge is not a correct one.
- `src/game/targeter.ts` — kept upstream's `handleThemeChange`, dropped a comment about an sfx
  argument this branch had already removed.
- `CLAUDE.md`, `OWNERSHIP.md`, `CALLSTACK.md`, `refactoring_todo.md` — upstream's rewritten
  prose with the audio names re-applied. One miss on the first pass (`OWNERSHIP.md`'s
  `startRun` line still said `sfx.resumeBgm()`) was found by grepping the docs for stale audio
  identifiers afterwards; do that sweep as a matter of course, the conflict markers do not
  cover semantic staleness.

Verified after each merge: typecheck clean, and all four harnesses unchanged — 54,240 notes
still bit-identical to the pre-refactor baseline.

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
