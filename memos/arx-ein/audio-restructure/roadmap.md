# Future — roadmap

Ordered by what unblocks what, not by appeal. Item 1 is freely actionable, item 2 is
arx-ein's own planned architecture, and item 3 is blocked on a design question that belongs
to hedalu244.

> The engine/data split that used to head this list is **done** — see [done.md](done.md) §4.
> `BgmTrack` now carries each track's whole structure, so everything below is edited as data
> unless it says otherwise.

---

## 1. Artistic work on the BGM

All of it must stay **asset-free** — synthesized at runtime, no audio files. That is a
deliberate design choice, recorded in `DEVELOP/SPEC.md` §8, and worth keeping.

- **Differentiate the five tracks.** The split landed with every track carrying identical
  structure values (that was deliberate — it kept the refactor provably sound-identical), so
  the tracks still differ only in pitch material and tempo. Giving each its own transposition
  plan, cadences and levels is now a pure data edit in `tracks/tracks.ts`, and it is the cheapest
  real improvement available.
- **Track transitions.** The ~5-minute switch is currently a hard cut mid-phase. Either
  crossfade, or switch only on a macro-cycle boundary so the new track enters in phase. The
  super-cycle length is now derivable from the track data (the `transpose`/`octave` cycles),
  which is what a phase-aligned switch needs.
- **Stereo** is now part of §3: pan is a per-instrument parameter, so widening the BGM is a
  data edit once instruments exist. The output bus it implies is also **the foundation the mic
  system (§4) needs**, so it pays for itself twice.
- **Asset-free effects.** A `ConvolverNode` reverb needs no files if the impulse response is
  generated from decaying noise at unlock time. A feedback-delay node could replace the
  sparkle echoes, which are still scheduled one tone per echo (`SparkleLayer.echoes`).
- **Adaptive music** (layering intensity on game state — combat vs. map view, reentry heat,
  time warp). Attractive, but this is a *wiring* question as much as an audio one: `Bgm` would
  need a per-frame `update(...)` called from the orchestration with explicit arguments, in the
  spirit of refactor-fixed rule 18 (read shared state fields passed in; never reach into
  input-source-specific state). **Sketch it and propose the wiring before building it.**

## 2. The conductor — arx-ein's planned BGM architecture

arx-ein's own sketch (2026-08-15), worked through in discussion on 2026-08-15. Three layers:
a **conductor** owning which music plays and how pieces hand over, **composers** as the
note-generation algorithms behind one shared interface, and **tracks** as the parameters a
composer consumes. The `Composer` seam already landed to be the bottom of it.

### 2a. Conductor is a class, one per independent musical line

**Decided 2026-08-16, after consulting Mikanixonable.** This supersedes the earlier conclusion
that `Bgm` should merely *play* the conductor role; the argument for that was "the conductor is a
singleton, and extracting a singleton out of a singleton buys little," which was sound at the
time and whose premise no longer holds.

**Auditioning and gameplay music are two independent lines**, each with its own node chain, and
they must not interfere. That is a requirement of the adaptive-music work (§1): the gameplay line
will carry state that responds to what is happening in game, and opening the settings panel must
not perturb it. Two independent programs means the conducting role — which piece plays, when it
gives way to the next, how it is shaped over time — becomes **plural**, and a plural role earns a
class.

```text
Bgm (the app-facing service: a mixing desk and a clock)
  masterGain    <- user volume, shared by both lines
  timer         <- the one pump, advances whichever lines are active
  volume, autoStarted
  ambient:  Conductor        <- gameplay music. permanent. grows adaptive layers later
  audition: Conductor | null <- built when the settings panel opens, destroyed on close

Conductor (one continuous musical line)
  gain          <- this line's own output, feeding masterGain
  playback: TrackPlayback | null
  trackIdx, trackStartTime
  rotates       <- fixed at construction, not a mutable flag

TrackPlayback (one sounding piece — unchanged)
```

`Bgm` keeps its name: what is left there is not conducting. It is the master gain, the one clock,
the line slots and the volume persistence, and it is what `main.ts` / `Launcher` / `SettingsView`
already hold.

- **Rotation stops being a flag.** It is a constructor argument per line, so the audition line's
  "do not rotate" cannot leak into gameplay — the two are different objects. The bug this
  replaces (a pinned preview silently disabling rotation for the rest of the run) becomes
  unrepresentable rather than fixed.
- **One timer, not one per line.** `Bgm.pump()` stays the single `setInterval` and advances each
  active line. Per-line timers would work (each schedules against `ctx.currentTime`, so no drift
  bug) but buy nothing and cost `Bgm` its control of ordering.
- **`bgmPlayingAtOpen` disappears from `SettingsView`.** It exists only because the view has to
  remember audio state the audio layer does not. Pause/resume makes that symmetric and internal;
  the view is left reporting two events, `beginAudition()` / `endAudition()`.
- **Destroying the audition line is already implemented** — `Conductor.dispose()` →
  `TrackPlayback.dispose()` → instruments, retiring at `soundingUntil` (see
  [disposal.md](disposal.md)). The audition line is that machinery's first whole-line consumer.

Build order: extract `Conductor` with the ambient line alone (pure refactor, harnesses green) →
add pause/resume → add the audition line and the `SettingsView` wiring (the behavioural change).
`Conductor` holds `TrackPlayback | null`, **not** an array — plural pieces arrive with crossfade
(§2c), and guessing that interface now is guessing.

### 2a-1. Pause is ducking for now, and should become real later

**Interim, chosen deliberately.** `Conductor.pause()` ducks the line's gain to silence and keeps
being advanced; `resume()` un-ducks. So the gameplay line keeps *running* while the settings panel
is open and comes back wherever it would have been, rather than where it left off — over a long
settings session it can rotate to another track unheard.

Acceptable now for two reasons. The game itself is already paused while the panel is open
(`SettingsView.onOpenChange` → `launcher.current?.pause()`), so no game events are driving
adaptive state that could desynchronise. And it is strictly better than what it replaces, which
*stopped* the BGM outright and lost its position entirely.

**Proper pause** stops advancing the line and rebases its clock on resume, so the step counter
continues untouched and the line keeps its `TrackPlayback`, instruments and their nodes alive
across the pause — which is the point, since adaptive music will accumulate per-line state that
must not be rebuilt because someone opened a panel. WebAudio cannot unschedule, so already-queued
notes still need the duck; the addition is the stop-advancing and the rebase.

Contained by construction: only the two method bodies change, plus a `resumeAt(time)` on
`TrackPlayback` to rebase `nextTime`. `beginAudition`/`endAudition` and every call site stay
identical, so nothing built now has to be torn out. Two sub-decisions when it is done: whether
`trackStartTime` is rebased too (it should be, or a long settings session rotates the instant you
close), and the duck fade length, which is audible on both edges.

### 2b. Tracks: a discriminated union over `kind`, switched in exactly one factory

```ts
// bgm/tracks/types.ts
export type BgmTrack =
  | { kind: 'phasing'; name: string; params: PhasingParams }
  | { kind: 'drone';   name: string; params: DroneParams };
```

- **What is common vs per-kind** has a clean test: *what does a consumer read without caring
  which kind it is?* `SettingsView` reads `.name` to build the preview list, so `name` is
  common. Nothing outside the factory reads `params`.
- **The factory needs its own file** (`bgm/composer-factory.ts`), not `composer.ts`: it must
  import every implementation, and `composers/phasing-composer.ts` already imports `composer.ts`, so
  putting it there creates an import cycle. Keeping the seam dependency-free is also what
  lets a new composer be written without touching it.
- **Not in `tracks/tracks.ts` either** — that is a data registry, the analogue of
  `solar-system.ts`'s `SOLAR_SYSTEM`, and those stay data plus a `kind` discriminant with the
  switches elsewhere. (The per-kind *schemas* do live there, the same way `CelestialBodyDef`
  keeps its star/planet/satellite variants together.)
- **Force exhaustiveness** with a `default` branch assigning to `never`, so a new `kind`
  without a factory branch is a compile error rather than a runtime fallthrough. Same class of
  switch `refactor-fixed` rule 3 blesses for `CelestialBodyDef.kind`: closed by construction,
  since a composer cannot exist without an implementation.
- **Rejected alternative**: a `createComposer()` method on each track object. That puts
  functions in the data registry and gives every track a closure.
- **Open wrinkle**: `Composer.stepDurSec` assumes a uniform step grid. A composer with
  irregular rhythm can still declare a fine grid and return `[]` on most steps — a step is a
  scheduling quantum, not a musical beat — but be deliberate about that rather than
  discovering it later.

### 2c. Crossfade: two gain layers, and two lifetime traps

Today every note routes `osc -> noteGain -> bgm.gain -> destination`, one gain for everything.
Note that `playTrack` **already** creates two gain nodes transiently (`stop(0.05)` ramps the
old one down while its scheduled notes still sound through it, then `start()` builds a new
one) — but the old node is dropped, so nothing can shape it afterwards. Fine for a hard cut,
useless for a controlled crossfade.

```text
notes of piece A -> playbackGain(A) -+
                                     +-> masterGain (user volume) -> destination
notes of piece B -> playbackGain(B) -+
```

- **The two layers must be separate params.** If one gain does both jobs, a volume change
  during a crossfade writes the same `AudioParam` the fade is ramping, and the later call
  cancels the earlier one's shape. Split, they are orthogonal.
- **Trap 1: stop pumping the outgoing piece when its fade starts**, or it keeps scheduling
  notes into a gain heading for zero.
- **Trap 2: do not tear a playback down the instant its fade ends... but do wait for the
  fade.** Already-scheduled notes are long — pads run `stepDur * 34` (~20 s) and the drone
  `stepDur * 66` (~40 s on the slowest track). Because the playback gain reaches ~0, the tail
  is inaudible, so teardown is *fade duration + epsilon*, not *longest outstanding note*. It
  is emphatically not "immediately", which would chop a drone mid-decay audibly.
- **Open question worth settling before writing the crossfade**: a musical handover wants to
  start B at a sensible point in A's cycle, which needs A's position within its super-cycle.
  Either `Composer` exposes something like `superCycleSteps`, or the conductor computes it
  from track data — and the latter leaks phasing-specific knowledge into the conductor, which
  is the thing the seam exists to prevent.

### 2d. Build order

The original plan held that the conductor layer earns its keep only once a second composer
exists or crossfade lands. **The audition line supersedes that** — two independent musical
programs is on its own a reason for the layer, and it arrives before either of the other two.

1. ~~**The union + a second composer.**~~ **Done** — [done.md](done.md) §10.
2. ~~**Playback extraction** (`TrackPlayback`).~~ **Done** — [done.md](done.md) §10.
3. **`Conductor`, ambient line only** — pure refactor, harnesses green on current expectations.
4. **Pause/resume** (ducking, per §2a-1), still unused.
5. **The audition line** + `beginAudition`/`endAudition` + `SettingsView` wiring. The
   behavioural change; `check-rotation` is rewritten here.
6. **Crossfade**, once 2c's open question is settled.

### 2e. The bug this architecture makes unrepresentable

**試聴 in the settings view rotated after `TRACK_ROTATION_SEC`** — auditioning a track long
enough swapped it for another, which is not what a sound test does.

The first answer was a mutable `rotates` flag on `Bgm`: `start()` sets it true, `playTrack()`
sets it false immediately afterwards. That stops the audition rotating, and **introduces a worse
bug in exchange**: nothing sets it back. Close the settings panel while a preview is still
playing — the supported way to adopt a track as the music — and rotation stays off for the rest
of the run, which in CREATIVE never ends. Both symptoms come from one cause: a policy belonging
to one line, stored on an object shared with the other.

Two `Conductor`s with `rotates` fixed at construction removes the cause. The audition line cannot
write gameplay's rotation policy because it is not the same object, so there is no state to
forget to restore. Still not two playback modules, and still not a property of `TrackPlayback` —
the playback does not care why it is sounding.

## 3. Instruments — the DSP layer, so composers can actually design sound

Discussed 2026-08-15. The note vocabulary (one oscillator, linear attack, exponential decay) is
too thin to compose against, and the WebAudio DSP palette is unused. The unlock is noticing
there are **two different DSP needs that want opposite treatments**:

| | lifetime | configured by | expressed as |
| --- | --- | --- | --- |
| **voice / instrument** — what makes a note a bell vs a pad | per note | pitch/velocity + patch params | **code** + a params type |
| **bus effects** — reverb, delay, chorus, compression | once per piece | scalars only | **data** + a factory |

Conflating them is what makes "parameter-driven DAW" feel like it needs a big machine.

### 3a. No DSP inside composers

A composer would have to return audio graphs, so it would import WebAudio types, so it would
stop being a pure function of `step` — and that property is what lets every change be proven
inert by diffing note streams. The fix strengthens it instead: a note saying
`instrument: 'bell', velocity: 0.8` is *more* abstract than one carrying `wave`/`attackSec`,
which are instrument concerns that leaked into the note.

### 3b. The performer already exists — it is `TrackPlayback`

It receives notes and makes sound; what it lacks is an instrument set instead of one hardcoded
voice. So the new concept is `Instrument`, not a new layer. Three roles, one new abstraction:

```text
Composer   (pure)   what to play, how hard  -> notes referencing instruments
Instrument (code)   what that sounds like   -> per-note voice + persistent modulation
Effect     (data)   how it sits in the mix  -> bus chains, shared      [not yet built]
```

`level` becomes `velocity` on the note. Not a rename: level is an absolute gain (a mixing
decision, belongs to the instrument), velocity is how hard the note is struck, and **the
instrument decides what that does** — gain, filter opening, FM index, attack length.

### 3c. Why instruments are code but effects are data

The fully declarative version (`nodes: {...}, connections: [...]`) is a trap. It works until
you need **modulation**, which is where WebAudio's power lives: ramps on an `AudioParam`, an
LFO connected *into* a param, cutoff tracking pitch, envelope depth scaled by velocity.
Expressing that in data means inventing an expression language — i.e. reimplementing Max/MSP
in JSON. In code it is four lines and type-checked.

Effects are the opposite: a fixed small graph with scalar knobs and no per-note automation, so
`{kind:'reverb', decaySec, mix}` really is complete. Both halves then use the same
union + factory shape the composers already use, so the whole subsystem has one mental model.

### 3d. Contracts to hold instruments to

1. **`play(freq, when, durationSec, velocity)` must never read `ctx.currentTime`.** The
   scheduler runs `LOOKAHEAD_SEC` ahead; every automation point derives from `when`. This is
   the easiest way to silently break the lookahead.
2. **No reverb inside a voice** — convolution and delay belong on a shared bus. This is most of
   the argument for having buses at all.
3. **Node budget.** 2 nodes/note today; a rich voice is 5–8, and at ~25 notes/s that is a few
   hundred nodes/s created and discarded. Fine for WebAudio, but ambition belongs on buses,
   not multiplied per voice.
4. **Duration is known up front, so there is no note-off** — the instrument schedules its own
   release at `when + durationSec`. Simple and sufficient, but it means an *indefinitely held*
   note has no expression in this design. That wall is fine to leave standing for now.

Persistent modulation is supported naturally: an instrument is constructed once per playback
with `(ctx, destination, params)`, so an LFO that runs across notes lives in its constructor
and only the per-note nodes are transient.

### 3e. Settled questions

- **Instrument identity is a string id** (`'pads'`), resolved by the playback; an unknown id is
  a loud error, not a silent skip.
- **One named output per instrument, no sends yet.** Sends (dry + N depths sharing one reverb)
  are a real capability and a real complexity; add them when a piece wants one.
- **Instrument defs live per track**, like composer params. A shared preset library is the
  natural refactor once two tracks want the same patch.

### 3f. Build order

1. ~~`Instrument` + notes carrying `instrument`/`velocity` + per-instrument `pan`, no buses.~~
   **Done** — see [done.md](done.md) §11. Writing a richer instrument is now a new class, a
   params type, a fence in `tracks/types.ts` and a factory branch.
2. **Buses + the effect union**, when reverb or delay is first wanted.
3. **Then design** — both a composer and its instruments.

### 3g. `dispose()` for playbacks and instruments

~~Discarded `TrackPlayback`s are never disconnected, so every rotation, preview and run boundary
strands 7 nodes on `masterGain` forever.~~ **Done** — see [done.md](done.md) §12 and
[disposal.md](disposal.md) §4. `Instrument.dispose()` is now part of the seam, so an instrument
written for the bus/effect work below already has the place to release its filters and LFOs.

## 4. The mic system — BLOCKED, do not start without asking

This is `memos/hedalu244/sfx_todo.md`'s remaining content, and the biggest piece left:
positional world SFX taking a mic position as an argument, with distance attenuation, panning
and Doppler; plus rebuilding the two judgments that memo flags as currently imprecise.

**The blocker is in the memo's own opening line.** hedalu244 wrote that this may not be worth
doing at all, because attenuating sound with distance is not physical in a vacuum — and the
current behavior can be read as structure-borne sound heard aboard the operated ship. That is
an unresolved design question about what the game is depicting, and it is theirs to settle.
**Ask before building.**

What the memo asks for, if it does go ahead:

- The mic position must be **decoupled from both the camera and the player** — passed as an
  argument so `Game`'s orchestration decides, provisionally following the camera.
- Volume/pan/Doppler follow from the collision pair's kind, the distance to the mic, and the
  relative velocity. **Whether a ship is the operated one must not be consulted** — it is not
  an acoustic property.
- Sources beyond some distance are ignored entirely.
- Two known-imprecise judgments to rebuild at the same time:
  - `Bullet.checkLoss` tests near-miss on per-substep positions only, never the closest
    approach along the segment, so a fast plasma bolt passing between substeps fails to
    sound. (Also logged in `memos/hedalu244/better_simulation/backlog.md` item 11.)
  - `DebrisPiece.collideWith` plays `WorldSfx.clank()` at a fixed volume for any `Player`,
    with no attenuation — so in CREATIVE a distant ship's casings are as loud as your own.
    (backlog item 12.)
- `altAlarm` belongs to this same fix — see [done.md](done.md) for why it was deliberately
  classified as a world sound rather than a UI one.

**Structural payoff already banked**: because the world/UI boundary is now drawn exactly where
the mic system needs it, this work should touch `world-sfx.ts`'s API and its callers, and
essentially nothing else.

---

## Not on this roadmap

- **`AGENTS.md`'s stale audio reference** — see the "deliberately left alone" section in
  [done.md](done.md). Needs a regenerate-or-delete decision from the others, not an audio fix.
- **Dock/shop sound effects.** `memos/mikanixonable/DOCKVIEW_UX_PROPOSAL_2026-08-09.md`
  notes there is no purchase/swap/repair sound and suggests short electronic blips would
  suffice, matching the existing synthesis style. That would be new `UiSfx` methods. Small,
  but it is mikanixonable's proposal to prioritize, not mine to pick up unasked.
