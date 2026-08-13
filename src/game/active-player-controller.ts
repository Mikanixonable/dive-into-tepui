// 操作対象艦(自機0..n隻のうちどれを操作するか)の切替・削除と、それに伴う各所有者への伝播
// (カメラ・計画エディタ・ターゲッター・航法ターゲット・マップ選択・SFX)を1箇所へ集める。
// 艦の隻数は0..n隻が一般形であり、「1隻・喪失即決着」はステージ側の特殊化(Stage.prunesDeadPlayers
// 等)にすぎない — このクラス自身はステージの種類を一切知らない。
import type { Player } from './player/player';
import type { EntityManager } from './simulation/entity-manager';
import type { CameraSystem } from './camera/camera-system';
import type { PlanEditor } from './plan/plan-editor';
import type { Targeter } from './targeter';
import type { NavTarget } from './nav-target';
import type { MapPicker } from './map-picker';
import type { Sfx } from '../audio/sfx';

export class ActivePlayerController {
  private _current: Player | null;

  constructor(
    initial: Player | null,
    private readonly entities: EntityManager,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly targeter: Targeter,
    private readonly navTarget: NavTarget,
    private readonly mapPicker: MapPicker,
    private readonly sfx: Sfx,
  ) {
    this._current = initial;
  }

  get current(): Player | null { return this._current; }

  // 操作対象艦(操作対象・追従カメラ・計画編集の対象)を差し替える。
  set(ship: Player): void {
    if (this._current === ship) return;
    this._current?.clearTransientCommands();
    this._current = ship;
    this.cameraSystem.setActivePlayer(ship);
    this.editor.setActivePlayer(ship);
    this.targeter.clearTargets();
  }

  // ship が null なら未配置状態(全滅・未収容、または操作対象の手動解除)へ戻す。
  setOrNull(ship: Player | null): void {
    if (ship) {
      this.set(ship);
      return;
    }
    this._current?.clearTransientCommands();
    this._current = null;
    this.cameraSystem.setActivePlayer(null);
    this.editor.setActivePlayer(null);
    this.sfx.setRcs(false);
  }

  // 艦を削除する。操作対象だった場合は他の生存艦へ引き継ぐか、無ければ未配置状態へ戻す。
  remove(ship: Player): void {
    const wasActive = this._current === ship;
    this.navTarget.clearIfTargeting(ship.id);
    this.mapPicker.close();
    this.cameraSystem.overviewCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this._current = null;
      this.editor.setActivePlayer(null);
    }
    this.entities.removePlayer(ship);
    if (wasActive) this.reclaimAfterLoss();
  }

  // 喪失した自機を配列・操作対象から回収する。Stage.prunesDeadPlayers を立てたステージ
  // (艦の保持数に上限があり、埋まった枠を空ける必要があるもの)からだけ呼ぶ。
  reclaimDead(): void {
    let lostActive = false;
    for (const lost of [...this.entities.players]) {
      if (lost.alive) continue;
      // remove() 側の引き継ぎを抑え、掃引が終わってから一度だけ次の艦へ渡す。
      if (this._current === lost) {
        this._current = null;
        lostActive = true;
      }
      this.remove(lost);
    }
    // 操作対象を失ったときだけ引き継ぐ。もともと操作していない状態(手動解除・未配置)は
    // プレイヤーの選択なので、勝手に艦を割り当てない。
    if (lostActive) this.reclaimAfterLoss();
  }

  private reclaimAfterLoss(): void {
    const next = this.entities.players.find((p) => p.alive) ?? null;
    if (next) this.set(next);
    else this.setOrNull(null);
  }
}
