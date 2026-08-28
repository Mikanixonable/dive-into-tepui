// 右クリックの当たり判定にかける軌道線(公転軌道・船の軌道・軌道ガイド)の候補集合を1フレーム分
// 組み立てる。サンプル点列そのものは各軌道線(OrbitLine/TrajectoryLine/OrbitGuideLines)が持つので、
// ここは「いまフレームにどの軌道線が表示されているか」を集めるだけ。
import type { Ephemeris } from '../../physics/ephemeris';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import { guideSecondary } from '../../physics/orbit-guide';
import { primaryOf } from '../../physics/solar-system';
import type { Vec3 } from '../../math/vec3';
import type { DisplayWindow } from '../display-window-manager';
import type { EntityManager } from '../simulation/entity-manager';
import type { CameraSystem } from '../camera/camera-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { VisibleGuideLine } from '../celestial/orbit-guide-lines';
import type { GameEntity } from '../game-entity/game-entity';
import { OrbitCalcMethod, OrbitPickable } from './orbit-pickable';

// 当たり判定用サンプル点数。描画の適応分割ほどの精度は要らず、画面上のピクセル半径内かの判定さえ
// 通ればよいので、頂点予算より一段粗い固定値にする。
const ORBIT_PICK_SAMPLES = 128;

export class OrbitPickables {
  private readonly items: OrbitPickable[] = [];

  // このフレームの候補列。refresh の後に読む。
  get pickables(): readonly OrbitPickable[] { return this.items; }

  constructor(
    private readonly entities: EntityManager,
    private readonly celestialSystem: CelestialSystem,
    private readonly ephemeris: Ephemeris,
    private readonly cameraSystem: CameraSystem,
  ) {}

  // このフレームに表示されている軌道線の候補列を組み直す。マップ視点でなければ空にする。
  // displayWindow.frame/displayTime は船の予測線・過去線の座標系相対 → ECI 変換に使う。
  refresh(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource): void {
    this.items.length = 0;
    if (!this.cameraSystem.overviewMode) return;
    const { frame, displayTime } = displayWindow;

    for (const [id, line] of this.celestialSystem.referenceOrbitLines) {
      const points = line.samplePoints(ORBIT_PICK_SAMPLES);
      if (points.length < 2) continue;
      this.items.push({ key: `orbit-body:${id}`, kind: 'orbit-body', method: 'analytic', ownerKeys: [`body:${id}`], points });
    }

    for (const ship of this.entities.players) this.addShipOrbit('player', ship, frame, displayTime, frameAnchors);
    for (const enemy of this.entities.enemies) this.addShipOrbit('ship', enemy, frame, displayTime, frameAnchors);
    for (const base of this.entities.bases) this.addShipOrbit('base', base, frame, displayTime, frameAnchors);

    for (const guide of this.celestialSystem.orbitGuide.visibleLines(ORBIT_PICK_SAMPLES)) {
      this.items.push({
        key: `orbit-guide:${guide.key}`, kind: 'orbit-guide', method: 'guide',
        ownerKeys: this.guideOwnerKeys(guide), points: guide.points,
      });
    }
  }

  // ガイド線1本の当たり判定の所有者。地球専用参照軌道(system が無い)は系トグルの対象外
  // なので地球1つだけ、CR3BP の族・リサジューは主星・副星(・ラグランジュ点)になる。
  private guideOwnerKeys(guide: VisibleGuideLine): readonly string[] {
    if (guide.system === null) return ['body:earth'];
    const secondary = guideSecondary(guide.system);
    const primary = primaryOf(this.ephemeris.registry, secondary) ?? secondary;
    return guide.point
      ? [`body:${secondary}-l${guide.point.slice(1)}`, `body:${primary}`, `body:${secondary}`]
      : [`body:${primary}`, `body:${secondary}`];
  }

  // 船(自艦・敵・基地)1隻ぶんの軌道線を候補へ積む。表示方式(解析楕円 or 予測線・過去線)は
  // EntityLineManager が既に決めているので、ここではどちらが出ているかを読むだけ。
  private addShipOrbit(
    ownerKind: 'player' | 'ship' | 'base', entity: GameEntity,
    frame: ReferenceFrame, displayTime: number, frameAnchors: FrameAnchorSource,
  ): void {
    if (!entity.alive) return;
    let method: OrbitCalcMethod;
    let points: Vec3[];
    if (entity.relativeOrbitLine !== null) {
      method = 'analytic';
      points = [...entity.relativeOrbitLine.samplePoints(ORBIT_PICK_SAMPLES)];
    } else if (entity.orbitLine !== null) {
      method = 'analytic';
      points = [...entity.orbitLine.samplePoints(ORBIT_PICK_SAMPLES)];
    } else if (entity.predictedLine !== null || entity.actualLine !== null) {
      method = 'predicted';
      points = [
        ...(entity.actualLine?.samplePoints(ORBIT_PICK_SAMPLES, frame, displayTime, this.ephemeris, frameAnchors) ?? []),
        ...(entity.predictedLine?.samplePoints(ORBIT_PICK_SAMPLES, frame, displayTime, this.ephemeris, frameAnchors) ?? []),
      ];
    } else {
      return;
    }
    if (points.length < 2) return;
    this.items.push({
      key: `orbit-ship:${entity.id}`, kind: 'orbit-ship', method, ownerKeys: [`${ownerKind}:${entity.id}`], points,
    });
  }
}
