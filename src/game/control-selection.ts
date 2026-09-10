// 操作対象(自機船 0..n 隻と基地のうち、ちょうど1つ)の選択と、それに伴う各所有者への伝播
// (航法ターゲット・SFX、および remove() でのカメラのフォーカス解除)を1箇所へ集める。
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { CameraSystem } from './camera/camera-system';
import type { NavTarget } from './nav-target';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { Notifier } from '../hud/notifier';

export class ControlSelection {
  private _current: Controllable | null;

  // 起動時の操作対象を自分で解決する。savedId に一致するもの、無ければ生存中の先頭、
  // 操作できるものが1つも無ければ null。
  constructor(
    savedId: string | null | undefined,
    private readonly dynamicSystem: DynamicSystem,
    private readonly cameraSystem: CameraSystem,
    private readonly navTarget: NavTarget,
    private readonly worldSfx: WorldSfx,
    private readonly notifier?: Notifier,
  ) {
    const candidates = dynamicSystem.controllables;
    this._current = candidates.find((c) => c.id === savedId)
      ?? candidates.find((c) => c.motion.alive)
      ?? null;
  }

  get current(): Controllable | null { return this._current; }

  // 操作対象(操作・追従カメラ・計画編集の対象)を差し替える。
  select(target: Controllable): void {
    if (this._current === target) return;
    this._current?.clearTransientCommands();
    this._current = target;
    this.navTarget.clear();
    if (target.controlHint !== null) this.notifier?.hint(target.controlHint);
  }

  // 未操作状態(全滅、または操作対象の手動解除)へ戻す。
  clear(): void {
    if (this._current === null) return;
    this._current.clearTransientCommands();
    this._current = null;
    this.worldSfx.setRcs(false);
  }

  // 操作対象を手で外す。外れたときだけ案内を出す(全滅による喪失とは別の経路)。
  release(target: Controllable): void {
    if (this._current !== target) return;
    this.clear();
    if (target.releaseHint !== null) this.notifier?.hint(target.releaseHint);
  }

  // 操作対象が居ない間に増えたものを、そのまま操作対象にする。既に居れば何もしない。
  claimIfNone(target: Controllable): void {
    if (this._current === null) this.select(target);
  }

  // 世界から取り除く。操作対象だった場合は他の生存個体へ引き継ぐか、無ければ未操作へ戻す。
  remove(target: Controllable): void {
    const wasActive = this._current === target;
    this.navTarget.clearIfTargeting(target.id);
    this.cameraSystem.mapCamera.clearFocusIf(target.id);
    if (wasActive) {
      target.clearTransientCommands();
      this._current = null;
    }
    this.dynamicSystem.remove(target);
    if (wasActive) this.reclaimAfterLoss();
  }

  // 喪失した操作対象候補を回収・整理する。
  reclaimDead(): void {
    let lostActive = false;
    // remove() が顔ぶれを触るので、走査は開始時の並びの写しに対して行う。
    for (const lost of [...this.dynamicSystem.controllables]) {
      if (lost.motion.alive) continue;
      if (this._current === lost) {
        this._current = null;
        lostActive = true;
      }
      this.remove(lost);
    }
    if (lostActive) this.reclaimAfterLoss();
  }

  // 操作対象を失った直後に呼ぶ。他に生存しているものがあれば引き継ぎ、無ければ未操作へ戻す。
  private reclaimAfterLoss(): void {
    const next = this.dynamicSystem.controllables.find((c) => c.motion.alive) ?? null;
    if (next) this.select(next);
    else this.clear();
  }
}
