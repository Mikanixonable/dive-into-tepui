// 右クリックの当たり判定にかける線の候補集合を1フレーム分組み立てる。サンプル点列そのものは
// 各描画クラス(EllipseLine/TrajectoryLine/TargetRelativeLine/OrbitGuideLines)が持つので、
// ここは「いまフレームにどの線が表示されているか」を集めるだけ — マップ視点でなければ空になる。
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import { guideSecondary } from '../../physics/orbit-guide';
import type { Vec3 } from '../../math/vec3';
import type { DisplayWindow } from '../display-window-manager';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { CameraSystem } from '../camera/camera-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { VisibleGuideLine } from '../celestial/orbit-guide/orbit-guide-lines';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { LineCalcMethod, LinePickable } from './line-pickable';

// 当たり判定用サンプル点数。描画の適応分割ほどの精度は要らず、画面上のピクセル半径内かの判定さえ
// 通ればよいので、頂点予算より一段粗い固定値にする。
const ORBIT_PICK_SAMPLES = 128;

export class LinePickables {
  private readonly items: LinePickable[] = [];

  // このフレームの候補列。refresh の後に読む。
  get pickables(): readonly LinePickable[] { return this.items; }

  constructor(
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly cameraSystem: CameraSystem,
  ) {}

  // このフレームに表示されている軌道線の候補列を組み直す。マップ視点でなければ空にする。
  // displayWindow.frame/displayTime は船の予測線・過去線の座標系相対 → ECI 変換に使う。
  refresh(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource): void {
    this.items.length = 0;
    if (!this.cameraSystem.overviewMode) return;
    const { frame, displayTime } = displayWindow;

    for (const { id, line } of this.celestialSystem.referenceEllipseLines) {
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
    const primary = this.celestialSystem.entityOf(secondary).motion.primary?.id ?? secondary;
    return guide.point
      ? [`body:${secondary}-l${guide.point.slice(1)}`, `body:${primary}`, `body:${secondary}`]
      : [`body:${primary}`, `body:${secondary}`];
  }

  // 船(自艦・敵・基地)1隻ぶんの軌道線を候補へ積む。表示方式(解析楕円 or 予測線・過去線)は
  // EntityLineManager が既に決めているので、ここではどちらが出ているかを読むだけ。
  private addShipOrbit(
    ownerKind: 'player' | 'ship' | 'base', entity: DynamicEntity,
    frame: ReferenceFrame, displayTime: number, frameAnchors: FrameAnchorSource,
  ): void {
    if (!entity.alive) return;
    let method: LineCalcMethod;
    let points: Vec3[];
    if (entity.targetRelativeLine !== null) {
      method = 'analytic';
      points = [...entity.targetRelativeLine.samplePoints(ORBIT_PICK_SAMPLES)];
    } else if (entity.ellipseLine !== null) {
      method = 'analytic';
      points = [...entity.ellipseLine.samplePoints(ORBIT_PICK_SAMPLES)];
    } else if (entity.predictedLine !== null || entity.actualLine !== null) {
      method = 'predicted';
      const frames = this.celestialSystem.frames;
      points = [
        ...(entity.actualLine?.samplePoints(ORBIT_PICK_SAMPLES, frame, displayTime, frames, frameAnchors) ?? []),
        ...(entity.predictedLine?.samplePoints(ORBIT_PICK_SAMPLES, frame, displayTime, frames, frameAnchors) ?? []),
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
