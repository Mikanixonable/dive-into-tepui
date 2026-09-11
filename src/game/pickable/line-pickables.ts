// 右クリックの当たり判定にかける線の候補集合を、いま表示されている線から1フレーム分組み立てる。
import { guideSecondary } from '../../physics/orbit-guide';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialSystem } from '../celestial/celestial-system';
import { lagrangeId, type LagrangePointNumber } from '../celestial/lagrange-id';
import type { VisibleGuideLine } from '../../render/celestial/orbit-guide/orbit-guide-view';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { isCombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { LinePickable } from './line-pickable';

// 線1本あたりの当たり判定用サンプル点数。ピクセル半径内かの判定に足りる粗さで固定する。
const ORBIT_PICK_SAMPLES = 128;

export class LinePickables {
  private readonly items: LinePickable[] = [];

  // このフレームの候補列。refresh の後に読む。
  public get pickables(): readonly LinePickable[] { return this.items; }

  public constructor(
    private readonly roster: EntityRoster,
    private readonly celestialSystem: CelestialSystem,
  ) {}

  // 候補列を空にする。軌道線を出さないフレームで refresh の代わりに呼ぶ。
  public clear(): void {
    this.items.length = 0;
  }

  // このフレームに表示されている軌道線の候補列を組み直す。
  public refresh(): void {
    // 天体参照線・船の線・ガイド線の順に、各所有元が公開する点列を積む。
    this.items.length = 0;

    for (const { id, points } of this.celestialSystem.referenceOrbitSamples(ORBIT_PICK_SAMPLES)) {
      this.items.push({ key: `orbit-body:${id}`, kind: 'orbit-body', method: 'analytic', ownerKeys: [id], points });
    }

    // 船の線は、このフレームに表示されているもの。
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

  // ガイド線1本の所属先。system を持たない地球専用参照軌道は地球、CR3BP の族・リサジューは
  // (ラグランジュ点・)主星・副星。
  private guideOwnerKeys(guide: VisibleGuideLine): readonly string[] {
    if (guide.system === null) return ['earth'];
    const secondary = guideSecondary(guide.system);
    const primary = this.celestialSystem.entityOf(secondary).motion.primary?.id ?? secondary;
    if (guide.point === null) return [primary, secondary];
    const pointId = lagrangeId(secondary, Number(guide.point.slice(1)) as LagrangePointNumber);
    return [pointId, primary, secondary];
  }

  // 船(自艦・敵・基地)1隻ぶんの、いま表示されている軌道線を候補へ積む。
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
