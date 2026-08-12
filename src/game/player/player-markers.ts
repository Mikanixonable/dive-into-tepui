// 自機の位置・姿勢だけから決まる HUD マーカー。戦闘ビューでは軌道基準の方向マーカーと
// 機首ボアサイト、広範囲視点では自機位置マーカーを出す。
import { Attitude, qRotate } from '../../physics/attitude';
import { KinematicState, orbitAxes } from '../../physics/kinematic-state';
import { scale, v3 } from '../../physics/vec3';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { MarkerManager } from '../marker/marker-manager';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { Attractor } from '../../physics/attractor';
import type { CelestialRegistry } from '../../physics/solar-system';
import { isPositionInFocusedSystem } from '../celestial/body-visibility';
import { ACCENT } from '../theme';
import type { MapVisibility } from '../celestial/map-visibility';

// 戦闘ビュー専用のマーカー(広範囲視点ではまとめて隠す)。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PlayerMarkers {
  constructor(
    private readonly markerManager: MarkerManager,
    private readonly id: string,
  ) { }

  // currentState: 現在の自機状態(方向マーカー・ボアサイト用)。
  // displayState: スライダー位置の状態(null なら予測期間超過)、▲ マーカー用。
  // displayName は改名可能なので毎フレーム引数で受け取り、保持しない。
  sync(currentState: KinematicState, displayState: KinematicState | null, att: Attitude, alive: boolean, overviewMode: boolean, isActive: boolean, project: ProjectFn, scaleFn: ScaleFn, displayName: string, rounds = 0, _reloadTimer = 0, beltLinks = 0, muzzleSpeed = 0, focusId?: string, registry?: CelestialRegistry, attractors: readonly Attractor[] = [], visibility: MapVisibility | null = null): void {
    const selfKey = `self-${this.id}`;

    if (overviewMode) {
      if (isActive) {
        for (const key of COMBAT_KEYS) this.markerManager.hide(`${key}-${this.id}`);
      }
      if (displayState && (!registry || isPositionInFocusedSystem(registry, focusId, displayState.r, attractors))
        && (!visibility || visibility.pickable)) {
        const color = isActive ? ACCENT : undefined;
        const rotationDeg = this.markerManager.headingRotationDeg(displayState.r, displayState.v, project, scaleFn);
        this.markerManager.setPosition(
          selfKey, 'mk-self', visibility?.icon === false ? '' : ENTITY_GLYPH.ship, displayState.r, project,
          isActive && visibility?.label !== false ? displayName : '', 1, color, rotationDeg,
        );
      } else {
        this.markerManager.hide(selfKey);
      }
      return;
    }
    this.markerManager.hide(selfKey);
    
    if (isActive) {
      this.syncOrbitAxes(currentState, project);
      this.syncBoresight(currentState, att, alive, project, rounds, beltLinks, muzzleSpeed);
    }
  }

  // キーは艦ごとに一意で増え続けるため、hide ではなく remove で DOM ごと片付ける。
  dispose(): void {
    for (const key of COMBAT_KEYS) this.markerManager.remove(`${key}-${this.id}`);
    this.markerManager.remove(`self-${this.id}`);
  }

  // prograde/retrograde/normal/antinormal/radial in-out の6方向マーカーを配置する。
  private syncOrbitAxes(state: KinematicState, project: ProjectFn): void {
    const pr = state.r;
    const { pro: proDir, nrm: nrmDir, radOut: radDir } = orbitAxes(state);

    this.markerManager.setDirection(`pro-${this.id}`, 'mk-pro', DIRECTION_GLYPH.prograde, pr, proDir, project, 'PROGRADE');
    this.markerManager.setDirection(`retro-${this.id}`, 'mk-retro', DIRECTION_GLYPH.retrograde, pr, scale(proDir, -1), project, 'RETROGRADE');

    this.markerManager.setDirection(`nrm-${this.id}`, 'mk-nrm', DIRECTION_GLYPH.normal, pr, nrmDir, project, 'NORMAL');
    this.markerManager.setDirection(`anm-${this.id}`, 'mk-nrm', DIRECTION_GLYPH.antinormal, pr, scale(nrmDir, -1), project, 'ANTINORMAL');

    this.markerManager.setDirection(`radout-${this.id}`, 'mk-rad', DIRECTION_GLYPH.radialOut, pr, radDir, project, 'RADIAL OUT');
    this.markerManager.setDirection(`radin-${this.id}`, 'mk-rad', DIRECTION_GLYPH.radialIn, pr, scale(radDir, -1), project, 'RADIAL IN');
  }

  // 機首方向にボアサイトマーカーを置く。機体が死亡していれば隠す。
  private syncBoresight(state: KinematicState, att: Attitude, alive: boolean, project: ProjectFn, rounds: number, beltLinks: number, muzzleSpeed: number): void {
    if (!alive) {
      this.markerManager.hide(`bore-${this.id}`);
      return;
    }
    const fwd = qRotate(att.q, v3(0, 0, 1));
    // 中央に切り欠きを残した、細い線だけの三尖星(120度間隔)。
    // 塗りつぶしや長方形の輪郭は使わず、各アームを独立した線分として描く。
    const star = '<svg viewBox="0 0 24 24" width="48" height="48" aria-label="照準"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 9.7V2"/><path d="M12 9.7V2" transform="rotate(120 12 12)"/><path d="M12 9.7V2" transform="rotate(240 12 12)"/></g></svg>';
    const label = `AMMO ${Math.max(0, rounds)}\nBELT ${Math.max(0, beltLinks)}\n${muzzleSpeed.toFixed(0)} m/s`;
    this.markerManager.setDirection(`bore-${this.id}`, 'mk-boresight', star, state.r, fwd, project, label, 1, undefined, undefined, true, true);
  }
}
