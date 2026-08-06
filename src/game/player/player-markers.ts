// 自機の位置・姿勢だけから決まる HUD マーカー。戦闘ビューでは軌道基準の方向マーカーと
// 機首ボアサイト、広範囲視点では自機位置マーカーを出す。
import { Attitude, qRotate } from '../../physics/attitude';
import { OrbitState, orbitalAxes } from '../../physics/orbital';
import { scale, v3 } from '../../physics/vec3';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';
import * as C from '../const';

// 戦闘ビュー専用のマーカー(広範囲視点ではまとめて隠す)。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PlayerMarkers {
  constructor(private readonly markerManager: MarkerManager) { }

  // currentState: 現在の自機状態(方向マーカー・ボアサイト用)。
  // displayState: スライダー位置の状態(null なら予測期間超過)、▷ マーカー用。
  sync(currentState: OrbitState, displayState: OrbitState | null, att: Attitude, alive: boolean, overviewMode: boolean, project: ProjectFn, rounds = 0, _reloadTimer = 0): void {
    if (overviewMode) {
      for (const key of COMBAT_KEYS) this.markerManager.hide(key);
      if (displayState) this.markerManager.setPosition('self', 'mk-self', '▷', displayState.r, project, 'PLAYER');
      else this.markerManager.hide('self');
      return;
    }
    this.markerManager.hide('self');
    this.syncOrbitalDirections(currentState, project);
    this.syncBoresight(currentState, att, alive, project, rounds);
  }

  hide(): void {
    for (const key of COMBAT_KEYS) this.markerManager.hide(key);
    this.markerManager.hide('self');
  }

  // prograde/retrograde/normal/antinormal/radial in-out の6方向マーカーを配置する。
  private syncOrbitalDirections(state: OrbitState, project: ProjectFn): void {
    const pr = state.r;
    const { pro: proDir, nrm: nrmDir, radOut: radDir } = orbitalAxes(state);

    this.markerManager.setDirection('pro', 'mk-pro', '⊙', pr, proDir, project, 'PROGRADE');
    this.markerManager.setDirection('retro', 'mk-retro', '⊗', pr, scale(proDir, -1), project, 'RETROGRADE');

    this.markerManager.setDirection('nrm', 'mk-nrm', '▲', pr, nrmDir, project, 'NORMAL');
    this.markerManager.setDirection('anm', 'mk-nrm', '▽', pr, scale(nrmDir, -1), project, 'ANTINORMAL');

    this.markerManager.setDirection('radout', 'mk-rad', '◎', pr, radDir, project, 'RADIAL OUT');
    this.markerManager.setDirection('radin', 'mk-rad', '◉', pr, scale(radDir, -1), project, 'RADIAL IN');
  }

  // 機首方向にボアサイトマーカーを置く。機体が死亡していれば隠す。
  private syncBoresight(state: OrbitState, att: Attitude, alive: boolean, project: ProjectFn, rounds: number): void {
    if (!alive) {
      this.markerManager.hide('bore');
      return;
    }
    const fwd = qRotate(att.q, v3(0, 0, 1));
    // 中央に切り欠きを残した、細い線だけの三尖星(120度間隔)。
    // 塗りつぶしや長方形の輪郭は使わず、各アームを独立した線分として描く。
    const star = '<svg viewBox="0 0 24 24" width="24" height="24" aria-label="照準"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 5.2V2"/><path d="M12 5.2V2" transform="rotate(120 12 12)"/><path d="M12 5.2V2" transform="rotate(240 12 12)"/></g></svg>';
    const label = `AMMO ${Math.max(0, rounds)} · ${C.MUZZLE_SPEED.toFixed(0)} m/s`;
    this.markerManager.setDirection('bore', 'mk-boresight', star, state.r, fwd, project, label, 1, undefined, undefined, true);
  }
}
