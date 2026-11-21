// 勢力の占有域を表示条件と表示時刻から導出し、描画へ同期する。
import * as THREE from 'three/webgpu';
import { len, sub, type Vec3 } from '../../math/vec3';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { lagrangePointsOf, secondaryFrameOf } from '../../physics/lagrange';
import { spinOrientation } from '../../physics/body-orientation';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { FactionZoneView, type OrbitZoneVisual } from '../../render/zones/faction-zone-view';
import type { ThemePalette } from '../../theme';
import { lagrangeId, lagrangePointNumbersOf } from '../celestial/lagrange-id';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { isModularShip } from '../ship/modular-ship';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DisplayWindow } from '../display-window-manager';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { MapVisibilityPolicy } from './visibility-policy';
import type { ViewMode } from '../view/view-mode';
import {
  type Faction, type FactionLagrangeZone, factionLagrangeZones, factionOf,
  factionOrbitZones, LAGRANGE_ZONE_RADIUS_RATIO,
} from './faction-occupancy';

export class FactionZoneManager {
  private readonly zoneView = new FactionZoneView();

  // 天体系・個体群を参照し、占有域の表示を組み立てる。
  public constructor(
    scene: THREE.Scene,
    private readonly roster: EntityRoster,
    private readonly celestialSystem: CelestialSystem,
  ) {
    this.zoneView.attach(scene);
  }

  // 軌道表示の可否を反映した個体の勢力を返す。
  private factionIncluded(
    entity: DynamicEntity, active: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): Faction | null {
    const faction = factionOf(entity);
    if (faction === 'enemy') {
      return (visibilityPolicy?.entity('enemy').orbit ?? true) ? 'enemy' : null;
    }
    if (faction === 'friendly') {
      const kind = isModularShip(entity) && entity.capabilities.role === 'base' ? 'base' : 'player';
      return (visibilityPolicy?.entity(kind, entity === active).orbit ?? true) ? 'friendly' : null;
    }
    return null;
  }

  // ビューと表示時刻に合う占有域を描画へ反映する。
  public sync(
    view: ViewMode, active: Controllable | null, displayWindow: DisplayWindow,
    visibilityPolicy: MapVisibilityPolicy | null, camera: CameraFrame, palette: ThemePalette,
  ): void {
    // 現在のビューと表示時刻に合う領域を決める。
    if (view !== 'map') {
      this.zoneView.sync([], [], camera.camera.quaternion);
      return;
    }
    const t = displayWindow.displayTime;
    const include = (entity: DynamicEntity): Faction | null =>
      this.factionIncluded(entity, active, visibilityPolicy);
    // 軌道帯と点パッドを個体の現在位置から組み立てる。
    const orbitZones = factionOrbitZones(
      this.roster.all(), this.celestialSystem.gravityMotions, t, include);
    const padZones = this.lagrangeZones(t, include);
    this.zoneView.sync(
      orbitZones.map((zone) => this.orbitZoneVisual(zone, t, camera, palette)),
      padZones.map((zone) => ({
        key: `${zone.pointId}:${zone.faction}`,
        color: zone.faction === 'enemy' ? palette.error : palette.info,
        position: camera.floatingOrigin.RtoThreeV3(zone.position),
        radius: zone.radius,
      })),
      camera.camera.quaternion,
    );
  }

  // 表示時刻の個体位置から、ラグランジュ点の占有域を導出する。
  private lagrangeZones(
    t: number, include: (entity: DynamicEntity) => Faction | null,
  ): FactionLagrangeZone[] {
    const motions = this.celestialSystem.celestialMotions;
    const members: { faction: Faction; position: Vec3 }[] = [];
    // 占有判定に使う個体位置を表示時刻へ揃える。
    for (const entity of this.roster.all()) {
      if (!entity.motion.alive) continue;
      const faction = include(entity);
      if (faction === null) continue;
      const state = entity.motion.stateAt(t);
      if (state === null) continue;
      members.push({ faction, position: state.r });
    }
    const zones: FactionLagrangeZone[] = [];
    // ラグランジュ点を持つ公転系を判定対象にする。
    for (const body of this.celestialSystem.entities) {
      const motion = body.motion;
      if (!(motion instanceof OrbitingMotion) || motion.def.lagrangeLabels !== true) continue;
      const points = lagrangePointNumbersOf(motion);
      if (points.length === 0) continue;
      const frame = secondaryFrameOf(motions, t, motion, t);
      if (frame === null) continue;
      // 点の配置と判定半径を、この公転系の幾何へ対応させる。
      const solved = lagrangePointsOf(frame);
      const separation = len(sub(frame.secondaryState.r, frame.primaryState.r));
      const radius = separation * LAGRANGE_ZONE_RADIUS_RATIO;
      const candidates = points.map((n) => ({
        id: lagrangeId(body.id, n), position: solved[`L${n}`], radius,
      }));
      zones.push(...factionLagrangeZones(members, candidates));
    }
    return zones;
  }

  // 天体の表示位置・赤道面・カメラ縮尺に合わせた軌道帯の宣言を返す。
  private orbitZoneVisual(
    zone: { bodyId: string; faction: Faction; innerRadius: number; outerRadius: number },
    t: number, camera: CameraFrame, palette: ThemePalette,
  ): OrbitZoneVisual {
    // 帯の位置と姿勢は表示時刻の天体状態へ合わせる。
    const body = this.celestialSystem.celestialMotions.find((motion) => motion.id === zone.bodyId)!;
    const position = body.positionAt(t);
    const axis = body.orientationAt(t)?.axis ?? null;
    const orientation = axis === null ? null : spinOrientation(axis, 0);
    const quaternion = orientation === null
      ? new THREE.Quaternion()
      : new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    const mpp = camera.radialScale(position);
    // 画面上の帯幅をカメラの縮尺へ合わせる。
    return {
      key: `${zone.bodyId}:${zone.faction}`,
      color: zone.faction === 'enemy' ? palette.error : palette.info,
      innerRadius: zone.innerRadius,
      outerRadius: zone.outerRadius,
      position: camera.floatingOrigin.RtoThreeV3(position),
      quaternion,
      bodyRadius: body.def.radius,
      widthPx: (zone.outerRadius - zone.innerRadius) / mpp,
    };
  }

  // 占有域が保持する描画資源を解放する。
  public dispose(): void {
    this.zoneView.dispose();
  }
}
