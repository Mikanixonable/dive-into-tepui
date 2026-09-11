// 右クリックの当たり判定にかける線の候補集合を1フレーム分組み立てる。サンプル点列そのものは
// 各描画クラス(EllipseLine/TrajectoryLine/TargetRelativeLine/OrbitGuideView)が持つので、
// ここは「いまフレームにどの線が表示されているか」を集めるだけ — マップ視点でなければ空になる。
import { guideSecondary } from '../../physics/orbit-guide';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialSystem } from '../celestial/celestial-system';
import { lagrangeId, type LagrangePointNumber } from '../celestial/lagrange-id';
import type { VisibleGuideLine } from '../../render/celestial/orbit-guide/orbit-guide-view';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { isCombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { LinePickable } from './line-pickable';

// 当たり判定用サンプル点数。描画の適応分割ほどの精度は要らず、画面上のピクセル半径内かの判定さえ
// 通ればよいので、頂点予算より一段粗い固定値にする。
const ORBIT_PICK_SAMPLES = 128;

export class LinePickables {
  private readonly items: LinePickable[] = [];

  // このフレームの候補列。refresh の後に読む。
  public get pickables(): readonly LinePickable[] { return this.items; }

  public constructor(
    private readonly roster: EntityRoster,
    private readonly celestialSystem: CelestialSystem,
  ) {}

  // 候補列を空にする(軌道線が表示されないビューで呼ぶ)。
  public clear(): void {
    this.items.length = 0;
  }

  // このフレームに表示されている軌道線の候補列を組み直す。
  public refresh(): void {
    // 天体参照線・Entity 線・ガイド線の順で、各所有元が公開する点列だけを読む。
    this.items.length = 0;

    for (const { id, points } of this.celestialSystem.referenceOrbitSamples(ORBIT_PICK_SAMPLES)) {
      this.items.push({ key: `orbit-body:${id}`, kind: 'orbit-body', method: 'analytic', ownerKeys: [id], points });
    }

    // EntityLineManager がこのフレームに同期した線だけがサンプルを返す。
    for (const ship of this.roster.all().filter(isCombatTarget)) {
      this.addShipOrbit(ship);
    }

    for (const guide of this.celestialSystem.orbitGuideSamples(ORBIT_PICK_SAMPLES)) {
      this.items.push({
        key: `orbit-guide:${guide.key}`, kind: 'orbit-guide', method: 'guide',
        ownerKeys: this.guideOwnerKeys(guide), points: guide.points,
      });
    }
  }

  // ガイド線1本の当たり判定の所有者。地球専用参照軌道(system が無い)は系トグルの対象外
  // なので地球1つだけ、CR3BP の族・リサジューは主星・副星(・ラグランジュ点)になる。
  private guideOwnerKeys(guide: VisibleGuideLine): readonly string[] {
    if (guide.system === null) return ['earth'];
    const secondary = guideSecondary(guide.system);
    const primary = this.celestialSystem.entityOf(secondary).motion.primary?.id ?? secondary;
    if (guide.point === null) return [primary, secondary];
    const pointId = lagrangeId(secondary, Number(guide.point.slice(1)) as LagrangePointNumber);
    return [pointId, primary, secondary];
  }

  // 船(自艦・敵・基地)1隻ぶんの軌道線を候補へ積む。表示方式(解析楕円 or 予測線・過去線)は
  // EntityLineManager が既に決めているので、ここではどちらが出ているかを読むだけ。
  private addShipOrbit(entity: DynamicEntity): void {
    if (!entity.motion.alive) return;
    const sample = entity.view.lineSamples(ORBIT_PICK_SAMPLES);
    if (sample === null || sample.points.length < 2) return;
    this.items.push({
      key: `orbit-ship:${entity.id}`, kind: 'orbit-ship', method: sample.method,
      ownerKeys: [entity.id], points: sample.points,
    });
  }
}
