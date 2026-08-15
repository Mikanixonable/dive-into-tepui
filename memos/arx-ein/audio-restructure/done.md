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
