// 自機の姿勢だけから決まる戦闘ビュー専用 HUD マーカー(軌道基準の方向マーカーと機首ボアサイト)。
// マップ上の自機位置マーカーは他の船と同じく Targeter → GroupedMarkers が描く。
import { Attitude } from '../../physics/attitude';
import { qRotate } from '../../math/quat';
import type { View } from '../view/view';
import { KinematicState, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import { scale, sub, v3 } from '../../math/vec3';
import type { OrbitReference } from '../orbit-reference';
import type { ProjectFn } from '../camera/camera-system';
import type { MarkerManager } from '../marker/marker-manager';
import { DIRECTION_GLYPH } from '../marker/marker-identity';

// 戦闘ビュー専用のマーカー。マップビューではまとめて隠す。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PlayerMarkers {
  constructor(
    private readonly markerManager: MarkerManager,
    private readonly id: string,
  ) { }

  // 戦闘ビューかつ操作対象のときだけ軌道軸・ボアサイトを出す。マップビューでは既存の
  // 戦闘ビュー用マーカーを片付けるだけで、自機位置マーカー自体は描かない。
  sync(
    currentState: KinematicState, att: Attitude, view: View, isActive: boolean, project: ProjectFn,
    rounds = 0, beltLinks = 0, muzzleSpeed = 0, orbitRef?: OrbitReference,
  ): void {
    if (view === 'map') {
      if (isActive) for (const key of COMBAT_KEYS) this.markerManager.hide(`${key}-${this.id}`);
      return;
    }
    if (!isActive) return;
    this.syncOrbitAxes(currentState, project, orbitRef);
    this.syncBoresight(currentState, att, project, rounds, beltLinks, muzzleSpeed);
  }

  // キーは艦ごとに一意で増え続けるため、hide ではなく remove で DOM ごと片付ける。
  dispose(): void {
    for (const key of COMBAT_KEYS) this.markerManager.remove(`${key}-${this.id}`);
  }

  // prograde/retrograde/normal/antinormal/radial in-out の6方向マーカーを配置する。
  // 方向は orbitRef が指す基準(未指定なら ECI = 地球基準)に対する相対 r/v から求める——
  // マーカーの設置位置(pr)は常に艦の絶対位置のまま変わらない。
  private syncOrbitAxes(state: KinematicState, project: ProjectFn, orbitRef?: OrbitReference): void {
    const pr = state.r;
    const relState = orbitRef
      ? kinematicState<'eci'>(state.t, sub(state.r, orbitRef.state.r), sub(state.v, orbitRef.state.v))
      : state;
    const { pro: proDir, nrm: nrmDir, radOut: radDir } = orbitAxes(relState);

    this.markerManager.setDirection(`pro-${this.id}`, 'mk-pro', DIRECTION_GLYPH.prograde, pr, proDir, project, 'PROGRADE');
    this.markerManager.setDirection(`retro-${this.id}`, 'mk-retro', DIRECTION_GLYPH.retrograde, pr, scale(proDir, -1), project, 'RETROGRADE');

    this.markerManager.setDirection(`nrm-${this.id}`, 'mk-nrm', DIRECTION_GLYPH.normal, pr, nrmDir, project, 'NORMAL');
    this.markerManager.setDirection(`anm-${this.id}`, 'mk-nrm', DIRECTION_GLYPH.antinormal, pr, scale(nrmDir, -1), project, 'ANTINORMAL');

    this.markerManager.setDirection(`radout-${this.id}`, 'mk-rad', DIRECTION_GLYPH.radialOut, pr, radDir, project, 'RADIAL OUT');
    this.markerManager.setDirection(`radin-${this.id}`, 'mk-rad', DIRECTION_GLYPH.radialIn, pr, scale(radDir, -1), project, 'RADIAL IN');
  }

  // 機首方向にボアサイトマーカーを置く。
  private syncBoresight(state: KinematicState, att: Attitude, project: ProjectFn, rounds: number, beltLinks: number, muzzleSpeed: number): void {
    const fwd = qRotate(att.q, v3(0, 0, 1));
    // 中央に切り欠きを残した、細い線だけの三尖星(120度間隔)。
    // 塗りつぶしや長方形の輪郭は使わず、各アームを独立した線分として描く。
    const star = '<svg viewBox="0 0 24 24" width="48" height="48" aria-label="照準"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 9.7V2"/><path d="M12 9.7V2" transform="rotate(120 12 12)"/><path d="M12 9.7V2" transform="rotate(240 12 12)"/></g></svg>';
    const label = `AMMO ${Math.max(0, rounds)}\nBELT ${Math.max(0, beltLinks)}\n${muzzleSpeed.toFixed(0)} m/s`;
    this.markerManager.setDirection(`bore-${this.id}`, 'mk-boresight', star, state.r, fwd, project, label, 1, undefined, undefined, true, true);
  }
}
