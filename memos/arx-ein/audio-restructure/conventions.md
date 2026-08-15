# Conventions — what a change here must not break

This repo has strict, written, enforced responsibility boundaries. They are **not** optional
style preferences, and a PR that violates them will be rejected by the contributor who is
doing the organizing work. Read this before writing code.

## Primary sources, and the order to read them

Do not start by reading `src/`. The project mandates docs-first orientation (`/overview`):

| question | document |
| --- | --- |
| who owns this state / where is it `new`ed | `DEVELOP/OWNERSHIP.md` |
| when does it run, in what order, under what condition | `DEVELOP/CALLSTACK.md` |
| how is it supposed to behave (spec, numbers) | `DEVELOP/SPEC.md` |
| why is the responsibility placed there | `CLAUDE.md` Architecture section |
| cross-cutting rules that must never break | `.claude/skills/refactor-fixed/SKILL.md` |
| naming and TypeScript style | `DEVELOP/CODING_STYLE.md` |
| UI/DOM/CSS rules | `DEVELOP/DESIGN-RULES.md` (`/ui-design`) |

`memos/mikanixonable/dev.md` is **human-authored only — read, never edit.**

## Rules that bite hardest in practice

- **Documentation updates ship in the same changeset as the code.** Not "later". If you move a
  file, rename a public method, change per-frame call order, change who owns a field, or change
  player-visible behavior, the matching document changes in the same commit. Procedure is
  `/develop-docs`. A PostToolUse hook reminds you after every `src/**/*.ts` edit.
- **Renames leave no trace.** No "formerly", no "previously X", no compatibility aliases for the
  old name. Full-text search the old identifier and get zero hits in live code and live docs.
  (Archived dated memos are the exception — they record history.)
- **Comments follow `/comment`.** Write what a module/function *does* and how to use it, plus
  genuinely non-obvious reasons. Never write how it is implemented, what it does *not* do, who
  calls it, what it used to be, or what you changed. Conversely, a missing call-convention
  comment above a function, or a missing context comment inside a 10+ line function, counts as
  a defect too.
- **Verification is scoped to what you touched.** `npm run typecheck` always. `npm run test:physics`
  **only** if you touched `src/physics/`. There is no audio test suite — verification for audio
  is typecheck plus listening in `npm run dev`.
- **Don't write debug scaffolding nobody asked for**: no URL-query/env toggles, no enable/disable
  switches, no parameterized counts, no per-frame hooks, no "once only" state, no fallbacks.
  Constants inline, one call site.
- **Large rewrites are welcome; do them in verifiable stages.** "The code currently is this way"
  is explicitly *not* a reason to avoid a change. But split it so each stage is independently
  green, which is why the audio work was three commits rather than one.

## refactor-fixed rules most relevant to audio

- **Rule 7 — pass object references, not closures.** Never `(t) => other.method(t)` as an
  injected callback. Give the object. (`Docking` holds a documented interim exception for
  `pauseGame`/`resumeGame`; do not use it as precedent.)
- **Rule 12 — GUI is owned by whoever owns the state it writes.** `WorldSfx`/`UiSfx` are listed
  there as *shared services*, explicitly exempt from the ownership argument — which is why
  they can be injected broadly without violating it. `PauseMenu` is owned by `main.ts` because
  spanning modules is its nature.
- **Rule 18 — effects and SFX read the shared physics fields, not input-source-specific state.**
  `ThrustEffects` reads `ship.thrust`; `RcsEffects` reads `ship.torque`. This is why an autopilot
  burn (`PlanExecutor` writing `ship.thrust` directly) sounds identical to a manual one without
  either module knowing about the other. **Any new sound must follow this**: read the shared
  field, never reach into `PlayerThrottle`'s display state.
- **Rule 6 — no `ctx` / `options` / `params` bag arguments.** Explicit arguments or shared
  references. The name `snapshot` is banned for the same reason.
- **Rule 13 — no two-phase init.** Constructor takes the initial state; no `restore()` that
  overwrites a live instance.
- **Rule 21bis — absence is `T | null`**, not a stand-in empty instance plus a boolean.

## Audio-specific invariants established by the work so far

- **`AudioEngine` is the only owner of the `AudioContext`.** `Bgm`, `WorldSfx` and `UiSfx` each
  hold it by constructor reference and read `engine.ctx`, which is `null` until `unlock()`.
  Every public method must no-op safely while it is `null` — the title screen can call into
  audio before any user gesture has happened.
- **`unlock()` needs a real user gesture.** `main.ts` wires it to `Input.onUserGesture`, which
  deliberately does *not* fire on `pointermove` — a bare move carries no user activation and
  would construct the context already `suspended`.
- **Each consumer is injected with only the class it actually sounds.** World sounds →
  `WorldSfx`; operation/notification blips → `UiSfx`; `Logistics` is the single module that
  legitimately takes both. Do not reintroduce a combined injection or a "pair" convention.
- **Nothing under `game/` decides audio lifecycle.** `Game` holds no reference to `AudioEngine`
  or `Bgm`; the unlock/auto-start wiring and the volume slider live in `main.ts`.
- **BGM is asset-free by design** and stays that way (`DEVELOP/SPEC.md` §8).
- **Loop channels are lazily built** on first `setThrust`/`setRcs`. If you add another
  continuous channel, follow that shape rather than building it in `unlock()`.
