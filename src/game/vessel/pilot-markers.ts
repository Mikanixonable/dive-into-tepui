// 自機の位置・姿勢だけから決まる HUD マーカー。戦闘ビューでは軌道基準の方向マーカーと
// 機首ボアサイト、広範囲視点では自機位置マーカーを出す。
import { Attitude, qRotate } from '../../physics/attitude';
import { KinematicState, orbitAxes } from '../../physics/kinematic-state';
import { scale, v3, type Vec3 } from '../../physics/vec3';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { MarkerManager } from '../marker/marker-manager';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { Attractor } from '../../physics/attractor';
import type { CelestialRegistry } from '../../physics/solar-system';
import * as C from '../const';
import { isPositionInFocusedSystem } from '../celestial/body-visibility';
import { findNearestPlanet } from '../celestial/planet-distance';
import type { MapVisibility } from '../celestial/map-visibility';
import { isOccluded } from '../../physics/occlusion';
import type { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';

import type { Vessel } from './vessel';
import { vesselMarkerSvg } from './hp-marker-svg';

// 戦闘ビュー専用のマーカー(広範囲視点ではまとめて隠す)。
const COMBAT_KEYS = ['pro', 'retro', 'nrm', 'anm', 'radout', 'radin', 'bore'] as const;

export class PilotMarkers {
  constructor(
    private readonly markerManager: MarkerManager,
    private readonly id: string,
    private readonly owner?: Vessel,
  ) { }

  // currentState: 現在の自機状態(方向マーカー・ボアサイト用)。
  // displayState: スライダー位置の状態(null なら予測期間超過)、▲ マーカー用。
  // 表示名は改名可能なので毎フレーム引数で受け取り、保持しない。
  sync(
    currentState: KinematicState, displayState: KinematicState | null, att: Attitude,
    overviewMode: boolean, isActive: boolean, cameraPos: Vec3, project: ProjectFn, scaleFn: ScaleFn,
    name: string, rounds = 0, _reloadTimer = 0, beltLinks = 0, muzzleSpeed = 0, focusId?: string,
    registry?: CelestialRegistry, attractors: readonly Attractor[] = [], visibility: MapVisibility | null = null,
    frame?: ReferenceFrame, displayTime?: number, ephemeris?: Ephemeris,
  ): void {
    const selfKey = `self-${this.id}`;
    const nearbyLabelKey = `${selfKey}-planet-label`;

    if (overviewMode) {
      if (isActive) {
        for (const key of COMBAT_KEYS) this.markerManager.hide(`${key}-${this.id}`);
      }
      if (displayState && (!registry || isPositionInFocusedSystem(registry, focusId, displayState.r, attractors))
        && (!visibility || visibility.pickable)) {
        const color = isActive ? 'var(--accent)' : undefined;
        const nearestPlanet = registry === undefined ? undefined : findNearestPlanet(displayState.r, registry, attractors);
        const nearPlanet = nearestPlanet !== undefined
          && nearestPlanet !== null && nearestPlanet.distance <= C.MAP_PLANET_SHIP_LABEL_END;
        const fadedOpacity = nearPlanet
          ? Math.max(0, Math.min(1, (C.MAP_PLANET_SHIP_LABEL_END - nearestPlanet.distance)
            / (C.MAP_PLANET_SHIP_LABEL_END - C.MAP_PLANET_SHIP_LABEL_START)))
          : 1;
        if (nearestPlanet !== undefined && nearestPlanet !== null && nearestPlanet.distance > C.MAP_PLANET_SHIP_LABEL_END) {
          this.markerManager.hide(selfKey);
          const planetOccluded = isOccluded(cameraPos, nearestPlanet.attractor.state.r, attractors);
          if (visibility?.label !== false && !planetOccluded) {
            this.markerManager.setPosition(
              nearbyLabelKey, 'mk-planet-nearby-label', '', nearestPlanet.attractor.state.r, project,
              `${ENTITY_GLYPH.ship}${name}`, 1, color,
            );
          } else if (visibility?.label !== false) {
            this.markerManager.fadeOut(nearbyLabelKey);
          } else {
            this.markerManager.hide(nearbyLabelKey);
          }
        } else {
          this.markerManager.hide(nearbyLabelKey);
          const shipOccluded = isOccluded(cameraPos, displayState.r, attractors);
          if (fadedOpacity > 0 && !shipOccluded) {
            const rotationDeg = this.markerManager.headingRotationDeg(displayState.r, displayState.v, project, scaleFn, attractors, frame, displayTime, ephemeris);
            const sym = visibility?.icon === false
              ? ''
              : this.owner
                ? vesselMarkerSvg(!!this.owner.baseState, this.owner.hp, this.owner.maxHp, this.owner.name, overviewMode, false)
                : ENTITY_GLYPH.ship;
            const symMarkup = overviewMode && !!this.owner;
            this.markerManager.setPosition(
              selfKey, 'mk-self', sym, displayState.r, project,
              isActive && visibility?.label !== false ? name : '', fadedOpacity, color, rotationDeg,
              symMarkup,
            );
          } else if (fadedOpacity > 0 && shipOccluded) {
            this.markerManager.fadeOut(selfKey);
          } else {
            this.markerManager.hide(selfKey);
          }
        }
      } else {
        this.markerManager.hide(selfKey);
        this.markerManager.hide(nearbyLabelKey);
      }
      return;
    }
    this.markerManager.hide(selfKey);

    // 姿勢基準の方向マーカー・ボアサイトは操縦を行う機体だけの概念。基地はここまで来ない。
    if (isActive && !this.owner?.baseState) {
      this.syncOrbitAxes(currentState, project);
      this.syncBoresight(currentState, att, project, rounds, beltLinks, muzzleSpeed);
    }
  }

  // キーは艦ごとに一意で増え続けるため、hide ではなく remove で DOM ごと片付ける。
  dispose(): void {
    for (const key of COMBAT_KEYS) this.markerManager.remove(`${key}-${this.id}`);
    this.markerManager.remove(`self-${this.id}`);
    this.markerManager.remove(`self-${this.id}-planet-label`);
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
