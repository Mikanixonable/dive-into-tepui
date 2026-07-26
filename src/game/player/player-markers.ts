// 自機の位置・姿勢だけから決まる HUD マーカー。戦闘ビューでは軌道基準の方向マーカー
// (Navball の代わり)と機首ボアサイト、広範囲視点では自機位置マーカーを出す。
// Player が所有し、Player.syncPlayer から呼ばれる。
import { Attitude, qRotate } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import { cross, scale, v3 } from '../../physics/vec3';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';

// 戦闘ビュー専用のマーカー(広範囲視点ではまとめて隠す)。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PlayerMarkers {
  constructor(private readonly markerManager: MarkerManager) { }

  sync(state: OrbitState, att: Attitude, alive: boolean, overviewMode: boolean, project: ProjectFn): void {
    if (overviewMode) {
      for (const key of COMBAT_KEYS) this.markerManager.hide(key);
      this.markerManager.setPosition('self', 'mk-self', '▷', state.r, project, 'PLAYER');
      return;
    }
    this.markerManager.hide('self');
    this.syncOrbitalDirections(state, project);
    this.syncBoresight(state, att, alive, project);
  }

  // 方向マーカーは自機の軌道基準フレームを表すので、自機位置を原点として setDirection に渡す。
  // ラベルにキー名は載せない — 戦闘ビューの並進は機体基準で、この6方向に対応するキーは無い
  // (対応するのはマップモードの Δv 編集キーで、そちらでは方向マーカーを出さない)。
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
