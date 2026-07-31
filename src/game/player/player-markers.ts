// 自機の位置・姿勢だけから決まる HUD マーカー。戦闘ビューでは軌道基準の方向マーカーと
// 機首ボアサイト、広範囲視点では自機位置マーカーを出す。
import { Attitude, qRotate } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import { cross, scale, v3 } from '../../physics/vec3';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';

// 戦闘ビュー専用のマーカー(広範囲視点ではまとめて隠す)。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PlayerMarkers {
  constructor(private readonly markerManager: MarkerManager) { }

  // currentState: 現在の自機状態(方向マーカー・ボアサイト用)。
  // displayState: スライダー位置の状態(null なら予測期間超過)、▷ マーカー用。
  sync(currentState: OrbitState, displayState: OrbitState | null, att: Attitude, alive: boolean, overviewMode: boolean, project: ProjectFn): void {
    if (overviewMode) {
      for (const key of COMBAT_KEYS) this.markerManager.hide(key);
      if (displayState) this.markerManager.setPosition('self', 'mk-self', '▷', displayState.r, project, 'PLAYER');
      else this.markerManager.hide('self');
      return;
    }
    this.markerManager.hide('self');
    this.syncOrbitalDirections(currentState, project);
    this.syncBoresight(currentState, att, alive, project);
  }

  private syncOrbitalDirections(state: OrbitState, project: ProjectFn): void {
    const pr = state.r;
    const proDir = state.v;
    const nrmDir = cross(pr, state.v);
    const radDir = cross(proDir, nrmDir);

    this.markerManager.setDirection('pro', 'mk-pro', '⊙', pr, proDir, project, 'PROGRADE');
    this.markerManager.setDirection('retro', 'mk-retro', '⊗', pr, scale(proDir, -1), project, 'RETROGRADE');

    this.markerManager.setDirection('nrm', 'mk-nrm', '▲', pr, nrmDir, project, 'NORMAL');
    this.markerManager.setDirection('anm', 'mk-nrm', '▽', pr, scale(nrmDir, -1), project, 'ANTINORMAL');

    this.markerManager.setDirection('radout', 'mk-rad', '◎', pr, radDir, project, 'RADIAL OUT');
    this.markerManager.setDirection('radin', 'mk-rad', '◉', pr, scale(radDir, -1), project, 'RADIAL IN');
  }

  private syncBoresight(state: OrbitState, att: Attitude, alive: boolean, project: ProjectFn): void {
    if (!alive) {
      this.markerManager.hide('bore');
      return;
    }
    const fwd = qRotate(att.q, v3(0, 0, 1));
    this.markerManager.setDirection('bore', 'mk-boresight', '┼', state.r, fwd, project);
  }
}
