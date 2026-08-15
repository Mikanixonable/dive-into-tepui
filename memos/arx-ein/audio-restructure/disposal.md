# Disposal — what `dispose()` is here, and what audio owes it

Written after merging upstream's lifecycle rework into this branch. It explains the rule, works
out how much of it applies to audio (less than it looks), and records the one real defect the
audit found in `Bgm` — since fixed, with the measurements that justify the fix's one constant.

## 1. Why the repo grew a disposal chain at all

It used to be that ending a run meant **navigating**: restart wrote `?stage=<id>` to
`location`, returning to the title wrote `?title=1`, loading a snapshot stashed an id in
`sessionStorage` and reloaded. Every one of those threw the whole page away, so nothing ever
had to be cleaned up — the browser did it.

Upstream removed all of that. `Launcher` now owns the running `Game` and swaps it **in the same
page**:

```ts
private endRun(): void {
  this.game?.dispose();
  this.game = null;
  this.resultScreen.close();
  this.resultShown = false;
  this.pauseMenu.toggle(false);
}

private async startRun(stageClass, snapshotId?): Promise<void> {
  this.endRun();
  // ...build the ephemeris, then:
  this.game = new Game(...);
}
```

The moment the page stops being thrown away, everything the old `Game` attached to something
that outlives it — a scene graph, a DOM layer, a `window` listener, a timer, a sounding audio
node — survives into the next run. That is what `dispose()` exists to prevent, and why there
are now 74 of them across `src/`.

**The failure mode is not "memory grows".** It is doubled event handlers, dead overlays that
swallow input, and audio from a run that already ended. Those are audible and visible; a leaked
megabyte is not.

## 2. The rule (DEVELOP/OWNERSHIP.md §1-2)

Three sentences carry it:

1. **Disposal walks the ownership tree in reverse.** Whoever `new`ed a thing calls its
   `dispose()`. `Game.dispose()` is the root and is nothing but one line per subsystem, in
   reverse construction order — reverse because later subsystems hold references to earlier
   ones.
2. **Each node cleans up only what it created and attached** to the scene, the DOM, `window`,
   `document`, or the canvas.
3. **A node with no scene/DOM/listener of its own gets no `dispose()` at all.** Dropping the
   reference is enough; the GC handles it. Do not write an empty `dispose()` to look tidy.

And three boundaries where the rule stops:

- **Shared module-scope resources are never freed.** `render/ships.ts`'s parse cache and the
  bullet/casing/debris geometry, `celestial-surface.ts`'s LOD geometry pool,
  `glow-texture.ts`'s texture, every `ensureStyle()` `<style>` tag. These are built once and
  outlive every `Game`. Freeing one means the *next* `Game` draws from a released buffer.
- **Textures do not cascade.** `Material.dispose()` only fires a `'dispose'` event; it never
  reaches the texture in `map`. Whoever loaded it holds it and frees it.
- **Wiring into something longer-lived must always be undone**, but the container itself is
  left alone — empty out `Hud.layers`, never remove them.

`Game.dispose()` is worth reading once in full, because the middle of it is exactly this third
boundary and it names audio explicitly:

```ts
// Hud・効果音はこのゲームより長生きするので、書き換えたクラス・差し込んだ参照・鳴らしている
// 継続音を元へ戻す。BGM は周回の外側が決めるものなので触らない。
this._hud.root.classList.remove('creative-mode');
this._hud.statusPanel.setInput(null);
this._worldSfx.setThrust(false);
this._worldSfx.setRcs(false);
```

## 3. Where audio sits relative to all this

**Every audio object is owned by `main.ts`, not by `Game`.** `initHud` builds `AudioEngine`,
`Bgm`, `WorldSfx` and `UiSfx` before `Launcher` exists, and they are handed to each `Game` by
reference. So:

- Audio is **never disposed at a run boundary**, and should not be. The `AudioContext` can only
  be created from a real user gesture; tearing it down and rebuilding it per run would mean
  silence until the player next clicked something.
- What a run boundary *does* owe audio is exactly what `Game.dispose()` already does: stop the
  two continuous loops, so a ship that was thrusting when the run ended does not keep thrusting
  into the next one. `Bgm` is deliberately left alone there, because whether music plays across
  a boundary is `Launcher`'s decision (`endRun` → `bgm.stop()`, `startRun` → `bgm.resume()`),
  not `Game`'s.
- By rule 3 above, `WorldSfx`/`UiSfx` **should not get a `dispose()`**. They hold no persistent
  node of their own — every sound builds its oscillator/gain inside the call and lets it fall
  away after `stop()`. The two loop channels are the exception, and `setThrust(false)` /
  `setRcs(false)` is already their off switch.

That left `Bgm`, which had a genuine problem.

## 4. The defect that was here, and the fix

`TrackPlayback` builds a `GainNode` for the piece, and each of its instruments builds a
`StereoPannerNode` that lives for the whole piece. Both discard paths dropped the reference
without disconnecting anything — there was not one `.disconnect()` call in `src/audio/` — and a
node that is still connected to a reachable node is still part of the audio graph and is not
collectable. Every discarded playback therefore left its gain and all of its instrument panners
hanging off `masterGain` permanently, summing zero into the mix forever.

Worse on the rotation path than the stop path: `openPlayback` overwrote `this.playback` without
even fading the outgoing piece (deliberately — already-scheduled notes ring out and the beat
continues seamlessly), so rotation stranded a playback still at full gain.

Measured with `count-leaks.mjs`, five tracks at six instruments each:

| session | playbacks opened | persistent nodes built | live before | live after |
| --- | --- | --- | --- | --- |
| 15 min | 3 | 22 | 22 | 8 |
| 60 min | 12 | 85 | 85 | 8 |

8 is correct: `masterGain`, plus the one playing track's gain and its six panners.

### What decides when it is safe to disconnect

The first design here proposed waiting for the fade to finish. **That was wrong**, for two
reasons found on implementing it: rotation does not fade at all, so there is no fade to wait
on; and once a piece's oscillators have stopped, nothing flows through its gain whatever the
fade is doing, so the fade is not the quantity that matters either way.

The right deadline is **when the piece goes quiet**. `TrackPlayback` already knows it — it
tracks the latest `noteStart + durationSec` as it schedules — and exposes it as `soundingUntil`,
plus `RELEASE_TAIL_SEC` for the instrument's own release past the note length. `Bgm.retire` is
the single path both `stop()` and `openPlayback()` take, and it schedules
`playback.dispose()` for that time.

`RELEASE_TAIL_SEC` = 0.25 s is not a guess. Sweeping it against the harness's cut-note check:

| tail | notes cut short over an hour |
| --- | --- |
| 0 | 18 |
| 0.04 | 0 |
| 0.25 | 0 |

The requirement is exactly `ToneInstrument`'s own `+0.05` release past `durationSec`; 0.25 is
5x headroom for an instrument with a longer tail.

### Shape

- `Instrument.dispose()` is **required** on the interface, not optional. The interface's own
  contract already says persistent nodes are built in the constructor, and the whole point is
  that `TrackPlayback` can retire a piece without knowing which implementation it holds. The
  DSP work wants this anyway — filters and LFOs have the same whole-piece lifetime.
- `TrackPlayback.dispose()` disposes its instruments and then its gain — reverse construction
  order, the same rule `Game.dispose()` follows.
- `Bgm` gets **no** `dispose()`. Nothing wants to tear the whole audio layer down, and rule 3
  says do not add one speculatively. `masterGain` stays for the same reason it always did.
- The wait is a `setTimeout`. It has to be, because `stop()` clears the pump interval, so a
  list drained by the pump would never be drained after a stop. `MarkerManager`'s occlusion
  fades are the existing precedent for `setTimeout` in this repo.

### Testing the test

The cut-note check in `count-leaks.mjs` initially reported success against a deliberately broken
margin (`RELEASE_TAIL_SEC = -30`), because the instrumentation that records disconnect times had
silently failed to apply. It now reports 190 cut notes for that value and 0 for the real one. A
verification harness that has never been seen to fail is not evidence.
