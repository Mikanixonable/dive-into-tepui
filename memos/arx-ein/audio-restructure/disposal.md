# Disposal — what `dispose()` is here, and what audio owes it

Written after merging upstream's lifecycle rework into this branch. Nothing in `src/audio/`
implements `dispose()` yet; this file explains the rule, works out how much of it applies to
audio, and records the one real defect the audit found.

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

That leaves `Bgm`, and `Bgm` has a genuine problem.

## 4. The defect: discarded playbacks stay connected

`TrackPlayback` builds a `GainNode` for the piece, and each of its instruments builds a
`StereoPannerNode` that lives for the whole piece. When the track changes:

```ts
stop(fadeSec = 2.5): void {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.playback?.fadeOut(fadeSec);
  this.playback = null;
}

fadeOut(sec: number): void {
  this.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, sec / 3);
}
```

The gain is ramped to near-silence and the reference is dropped — but **nothing is ever
disconnected**. There is not one `.disconnect()` call anywhere in `src/audio/`. A node that is
still connected to a reachable node is still part of the audio graph and is not collectable, so
every discarded playback leaves its gain and all of its instrument panners hanging off
`masterGain` permanently, quietly summing zero into the mix forever.

Measured with `count-leaks.mjs` (in the harness folder), against the current five tracks at six
instruments each:

| session | playbacks opened | should be live | actually live | leaked |
| --- | --- | --- | --- | --- |
| 15 min | 3 | 8 | 22 | **14** |
| 60 min | 12 | 8 | 85 | **77** |

That is **7 nodes per track rotation** (1 gain + 6 panners), one rotation every
`TRACK_ROTATION_SEC` = 300 s. Every preview click in the settings view and every run boundary
adds another 7 on top, since both go through the same `stop()` → `openPlayback()` path.

It is not audible today and it is not urgent — 77 silent nodes is nothing next to the ~10,000
note oscillators an hour legitimately schedules and releases. It matters for two reasons:

1. It is unbounded in session length, and the next thing on the roadmap makes it worse. The
   conductor/crossfade design has two playbacks alive at once by construction, and the
   instrument/DSP work adds filters, delays and LFOs per instrument — a leak of 7 nodes per
   rotation becomes a leak of dozens.
2. It is precisely the class of bug the rest of the repo just spent a lifecycle rework
   eliminating. Audio being `main.ts`-owned exempts it from the *chain*, not from the *rule*.

## 5. What to do about it (deferred, own commit)

The shape that fits both the repo rule and the roadmap:

- Give `TrackPlayback` a `dispose()` that disconnects its own gain and tells each instrument to
  disconnect its persistent nodes. Instruments need a `dispose()` on the `Instrument` interface
  for this — which is the right place for it anyway, since the DSP work will give them filters
  and LFOs that have the same lifetime.
- `Bgm.stop()`/`openPlayback()` cannot dispose the outgoing playback *immediately* — it is
  still fading out, and disconnecting mid-fade cuts the tail off. Dispose it after the fade
  completes. A `setTimeout(fadeSec * 1000 + margin)` is the obvious way and is fine; the pump
  is already an interval, so this adds no new kind of moving part.
- `Bgm` itself gets a `dispose()` only if something ever needs to tear down the whole audio
  layer — nothing does today, so per rule 3, do not add one speculatively.
- `masterGain` stays. It is the one node that legitimately outlives every piece.

Not started. This file records the finding so it is not re-derived from scratch.
