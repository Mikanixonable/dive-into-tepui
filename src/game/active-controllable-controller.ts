// 操作対象（自機船 0..n 隻、および基地）の切替・削除と、それに伴う各所有者への伝播
// (航法ターゲット・SFX、および remove() でのカメラのフォーカス解除)を1箇所へ集める。
import type { Player } from './player/player';
import type { Base } from './game-entity/base';
import type { Controllable } from './game-entity/controllable';
import type { EntityManager } from './simulation/entity-manager';
import type { CameraSystem } from './camera/camera-system';
import type { NavTarget } from './nav-target';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { Hud } from './hud/hud';

export class ActiveControllableController {
  private _current: Player | null;
  private _controlledBase: Base | null = null;

  // 起動時の操作対象艦を自分で解決する。activePlayerId に一致する艦、無ければ entities.players
  // の先頭、艦が0隻なら null。
  constructor(
    activePlayerId: string | null | undefined,
    private readonly entities: EntityManager,
    private readonly cameraSystem: CameraSystem,
    private readonly navTarget: NavTarget,
    private readonly worldSfx: WorldSfx,
    private readonly hud?: Hud,
  ) {
    this._current = entities.players.find((p) => p.id === activePlayerId) ?? entities.players[0] ?? null;
  }

  get current(): Player | null { return this._current; }
  get controlledBase(): Base | null { return this._controlledBase; }

  get currentControllable(): Controllable | null {
    return this._controlledBase ?? this._current;
  }

  // 基地の操作モードを切り替える。基地が非 null の場合、自機船の操作対象は自動解除される。
  setBase(base: Base | null): void {
    if (this._controlledBase === base) return;
    if (this._controlledBase) {
      this._controlledBase.clearTransientCommands();
    }
    this._controlledBase = base;
    if (base) {
      this.setOrNull(null);
      this.hud?.hint(`基地「${base.name}」の操作モードに入りました (WASDQE: 噴射 / IJKLUO: 姿勢制御 / T: RCS減衰 / C: プログレード)`);
    } else {
      this.hud?.hint('基地の操作を解除しました');
    }
  }

  // 操作対象艦(操作対象・追従カメラ・計画編集の対象)を差し替える。
  set(ship: Player): void {
    if (this._controlledBase !== null) {
      this.setBase(null);
    }
    if (this._current === ship) return;
    this._current?.clearTransientCommands();
    this._current = ship;
    this.navTarget.clear();
  }

  // 操作対象が居ない間に増えた艦を、そのまま操作対象にする。既に操作中の艦があれば何もしない。
  claimIfNone(ship: Player): void {
    if (this._current === null && this._controlledBase === null) this.set(ship);
  }

  // ship が null なら未配置状態(全滅・未収容、または操作対象の手動解除)へ戻す。
  setOrNull(ship: Player | null): void {
    if (ship) {
      this.set(ship);
      return;
    }
    this._current?.clearTransientCommands();
    this._current = null;
    this.worldSfx.setRcs(false);
  }

  // 艦を削除する。操作対象だった場合は他の生存艦へ引き継ぐか、無ければ未配置状態へ戻す。
  remove(ship: Player): void {
    const wasActive = this._current === ship;
    this.navTarget.clearIfTargeting(ship.id);
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this._current = null;
    }
    this.entities.removePlayer(ship);
    if (wasActive) this.reclaimAfterLoss();
  }

  // 喪失した自機および基地を回収・整理する。
  reclaimDead(): void {
    if (this._controlledBase && !this._controlledBase.alive) {
      this.setBase(null);
    }
    let lostActive = false;
    for (const lost of [...this.entities.players]) {
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
    const next = this.entities.players.find((p) => p.alive) ?? null;
    if (next) this.set(next);
    else this.setOrNull(null);
  }
}

// 別名エクスポート（旧型名との互換性確保）
export type ActivePlayerController = ActiveControllableController;
