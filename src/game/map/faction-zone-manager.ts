// 勢力の占有域を、ロスター・表示トグル・表示時刻から導出し、FactionZoneView へ同期させる。
// 域の定義と勢力の分け方は faction-occupancy.ts、描画物は render/zones/faction-zone-view.ts。
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

  public constructor(
    scene: THREE.Scene,
    private readonly roster: EntityRoster,
    private readonly celestialSystem: CelestialSystem,
  ) {
    this.zoneView.attach(scene);
  }

  // 個体が域の構成員になるときの勢力を返す。構成員にしない(種別外・表示 OFF)ときは null。
  // 数える対象は「そのクラスの軌道線表示が ON の個体」— 軌道線トグルと連動させる規定。
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

  public sync(
    view: ViewMode, active: Controllable | null, displayWindow: DisplayWindow,
    visibilityPolicy: MapVisibilityPolicy | null, camera: CameraFrame, palette: ThemePalette,
  ): void {
    // 占有域はマップビューの表示物(MAP.md「勢力の占有域」)。
    if (view !== 'map') {
      this.zoneView.sync([], [], camera.camera.quaternion);
      return;
    }
    const t = displayWindow.displayTime;
    const include = (entity: DynamicEntity): Faction | null =>
      this.factionIncluded(entity, active, visibilityPolicy);
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

  // ラグランジュ点の占有。点から一定距離(主星・副星間距離の比率)以内に構成員がいる勢力ぶん
  // だけ域を立てる — 域に入るための周回条件は無い(ラグランジュ点まわりの滞在は二体問題の
  // 閉軌道では現れない)。
  private lagrangeZones(
    t: number, include: (entity: DynamicEntity) => Faction | null,
  ): FactionLagrangeZone[] {
    const motions = this.celestialSystem.celestialMotions;
    const members: { faction: Faction; position: Vec3 }[] = [];
    for (const entity of this.roster.all()) {
      if (!entity.motion.alive) continue;
      const faction = include(entity);
      if (faction === null) continue;
      const state = entity.motion.stateAt(t);
      if (state === null) continue;
      members.push({ faction, position: state.r });
    }
    const zones: FactionLagrangeZone[] = [];
    for (const body of this.celestialSystem.entities) {
      const motion = body.motion;
      if (!(motion instanceof OrbitingMotion) || motion.def.lagrangeLabels !== true) continue;
      const points = lagrangePointNumbersOf(motion);
      if (points.length === 0) continue;
      const frame = secondaryFrameOf(motions, t, motion, t);
      if (frame === null) continue;
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

  // 帯1枚を描画宣言へ変換する。位置は描画座標、姿勢は中心天体の赤道面。
  private orbitZoneVisual(
    zone: { bodyId: string; faction: Faction; innerRadius: number; outerRadius: number },
    t: number, camera: CameraFrame, palette: ThemePalette,
  ): OrbitZoneVisual {
    const body = this.celestialSystem.celestialMotions.find((motion) => motion.id === zone.bodyId)!;
    const position = body.positionAt(t);
    const axis = body.orientationAt(t)?.axis ?? null;
    const orientation = axis === null ? null : spinOrientation(axis, 0);
    const quaternion = orientation === null
      ? new THREE.Quaternion()
      : new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    const mpp = camera.radialScale(position);
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

  public dispose(): void {
    this.zoneView.dispose();
  }
}
