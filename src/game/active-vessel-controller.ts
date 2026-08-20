// 操作対象(0..n 機の機体のうちどれを操作するか)の切替・削除と、それに伴う各所有者への伝播
// (ターゲッター・航法ターゲット・SFX、および remove() でのカメラのフォーカス解除)を1箇所へ集める。
import type { Vessel } from './vessel/vessel';
import { hasBaseModule, hasCorePart, isCargo } from './vessel/capabilities';
import type { EntityManager } from './simulation/entity-manager';
import type { CameraSystem } from './camera/camera-system';
import type { Targeter } from './targeter';
import type { NavTarget } from './nav-target';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { Hud } from './hud/hud';

export class ActiveVesselController {
  private _current: Vessel | null;

  // 起動時の操作対象を自分で解決する。activePlayerId に一致する自艦、無ければ自艦の先頭、
  // 自艦が0機なら null。
  constructor(
    activePlayerId: string | null | undefined,
    private readonly entities: EntityManager,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly navTarget: NavTarget,
    private readonly worldSfx: WorldSfx,
    private readonly hud?: Hud,
  ) {
    this._current = entities.ownShips().find((v) => v.id === activePlayerId && hasCorePart(v))
      ?? entities.ownShips().find((v) => hasCorePart(v)) ?? null;
  }

  get current(): Vessel | null { return this._current; }
  // 操作対象(追従カメラ・計画編集の対象)を差し替える。基地でも艦艇でも扱いは同じ。
  set(vessel: Vessel): void {
    if (isCargo(vessel)) {
      this.hud?.hint(`「${vessel.name}」は貨物です。コア部品を取り付けるまで操作できません`);
      return;
    }
    if (this._current === vessel) return;
    this._current?.clearTransientCommands();
    this._current = vessel;
    this.targeter.clearTargets();
    if (hasBaseModule(vessel)) {
      this.hud?.hint(`基地「${vessel.name}」の操作モードに入りました (WASDQE: 噴射 / IJKLUO: 姿勢制御 / T: RCS減衰 / C: プログレード)`);
    }
  }

  // 操作対象が居ない間に増えた機体を、そのまま操作対象にする。既に操作中なら何もしない。
  claimIfNone(vessel: Vessel): void {
    if (this._current === null && hasCorePart(vessel)) this.set(vessel);
  }

  // vessel が null なら未操作状態(全滅・未収容、または操作対象の手動解除)へ戻す。
  setOrNull(vessel: Vessel | null): void {
    if (vessel) {
      this.set(vessel);
      return;
    }
    this._current?.clearTransientCommands();
    this._current = null;
    this.worldSfx.setRcs(false);
  }

  // 機体を削除する。操作対象だった場合は他の生存自艦へ引き継ぐか、無ければ未操作状態へ戻す。
  remove(vessel: Vessel): void {
    const wasActive = this._current === vessel;
    this.navTarget.clearIfTargeting(vessel.id);
    this.targeter.clearIfTargeting(vessel);
    this.cameraSystem.mapCamera.clearFocusIf(vessel.id);
    if (wasActive) {
      vessel.clearTransientCommands();
      this._current = null;
    }
    this.entities.removeVessel(vessel);
    if (wasActive) this.reclaimAfterLoss();
  }

  // 喪失した機体を回収・整理する。艦艇・基地・敵艦の区別なく、死んだものを取り除く。
  reclaimDead(): void {
    let lostActive = false;
    for (const lost of [...this.entities.vessels]) {
      if (lost.alive) continue;
      if (this._current === lost) {
        this._current = null;
        lostActive = true;
      }
      this.remove(lost);
    }
    if (lostActive) this.reclaimAfterLoss();
  }

  private reclaimAfterLoss(): void {
    const next = this.entities.ownShips().find((v) => v.alive && hasCorePart(v)) ?? null;
    if (next) this.set(next);
    else this.setOrNull(null);
  }
}
