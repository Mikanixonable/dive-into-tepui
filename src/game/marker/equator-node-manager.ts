// 全 Entity の赤道交点を update で解き、sync で DOM へ反映し、選択候補として公開する。
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { ProjectFn } from '../../math/projection';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { EquatorNodeMarkerPair, type EquatorNodeInputs } from './equator-node-marker-pair';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';

export class EquatorNodeManager {
  private readonly pairs = new Map<string, EquatorNodeMarkerPair>();
  private readonly declarations: MarkerDeclaration[] = [];

  public constructor(
    private readonly roster: EntityRoster,
    private readonly group: MarkerSink,
  ) {}

  // このフレームで必要な個体だけを解き、消滅・非表示になった個体の解を失効させる。
  public update(
    inputs: EquatorNodeInputs, controlled: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    // roster の現行 id を記録し、走査後に消滅した個体の DOM 資源を回収する。
    const retainedIds = new Set<string>();
    for (const entity of this.roster.all()) {
      retainedIds.add(entity.id);
      const current = this.pairs.get(entity.id);
      // 表示理由を View に持たせず、ここで category と読者状態を一度だけ判定する。
      const categoryVisible = entity.mapKind === null || visibilityPolicy === null
        || visibilityPolicy.entity(entity.mapKind, entity === controlled).category;
      const visible = entity.motion.alive && categoryVisible
        && (entity.showsEquatorNodesAlways || entity === controlled || entity.motion.navTargetReader);
      if (!visible) {
        current?.retire();
        continue;
      }
      const pair = current ?? new EquatorNodeMarkerPair(entity.id);
      if (current === undefined) this.pairs.set(entity.id, pair);
      pair.update(entity.motion, entity.name, inputs);
    }
    // 非表示個体は再利用のため残すが、roster から消えた個体は捨てる。
    for (const id of this.pairs.keys()) {
      if (!retainedIds.has(id)) this.pairs.delete(id);
    }
  }

  // 現在解が有効な交点を、マップの選択候補として返す。
  public get pickables(): readonly ObjectPickable[] {
    return [...this.pairs.values()].flatMap((pair) => pair.pickables());
  }

  // update で確定した交点を、このフレームのカメラと時刻表示設定へ同期する。
  public sync(
    project: ProjectFn, cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
    celestialBodiesPivot: number, occludeByBodies: boolean, timeLabel: TimeLabelSetting,
    nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    for (const pair of this.pairs.values()) {
      pair.declarations(
        declarations, project, cameraPos, celestialBodies, celestialBodiesPivot,
        occludeByBodies, timeLabel,
      );
    }
    this.group.sync(declarations, nowMs);
  }

  // 所有する交点マーカーを取り除く。
  public dispose(): void {
    this.pairs.clear();
    this.group.dispose();
  }
}
