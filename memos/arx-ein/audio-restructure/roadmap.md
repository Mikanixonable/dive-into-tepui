# Future — roadmap

Ordered by what unblocks what, not by appeal. Item 1 is freely actionable; item 2 is
blocked on a design question that belongs to hedalu244.

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
  plan, cadences and levels is now a pure data edit in `bgm-tracks.ts`, and it is the cheapest
  real improvement available.
- **Track transitions.** The ~5-minute switch is currently a hard cut mid-phase. Either
  crossfade, or switch only on a macro-cycle boundary so the new track enters in phase. The
  super-cycle length is now derivable from the track data (the `transpose`/`octave` cycles),
  which is what a phase-aligned switch needs.
- **Stereo.** Everything currently sums mono into `ctx.destination`. A shared output bus with
  a `StereoPannerNode` per voice widens the BGM cheaply — **and that same bus is the
  foundation the mic system (item 2) needs**, so it pays for itself twice. Probably the
  highest-value single change here.
- **Asset-free effects.** A `ConvolverNode` reverb needs no files if the impulse response is
  generated from decaying noise at unlock time. A feedback-delay node could replace the
  sparkle echoes, which are still scheduled one tone per echo (`SparkleLayer.echoes`).
- **Adaptive music** (layering intensity on game state — combat vs. map view, reentry heat,
  time warp). Attractive, but this is a *wiring* question as much as an audio one: `Bgm` would
  need a per-frame `update(...)` called from the orchestration with explicit arguments, in the
  spirit of refactor-fixed rule 18 (read shared state fields passed in; never reach into
  input-source-specific state). **Sketch it and propose the wiring before building it.**

## 2. The mic system — BLOCKED, do not start without asking

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
