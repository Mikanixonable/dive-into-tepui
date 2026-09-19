// 全 Entity の赤道交点を update で解き、sync でマーカーへ反映し、選択候補として公開する。
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { ProjectFn } from '../../math/projection';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { appearsOnMap, MapVisibilityPolicy } from '../map/visibility-policy';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { EquatorNodeMarkerPair, type EquatorNodeInputs } from './equator-node-marker-pair';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import type { MarkerDevice } from '../../marker/marker-device';
import type { SettingValue } from '../../settings/setting-value';
import type { ViewMode } from '../view/view-mode';

export class EquatorNodeManager {
  private readonly pairs = new Map<string, EquatorNodeMarkerPair>();
  private readonly declarations: MarkerDeclaration[] = [];
  private readonly group: MarkerSink;

  // roster の個体の赤道交点を、markers から作ったマーカー群へ置く。mapDisplay はマップの表示トグル。
  public constructor(
    private readonly roster: EntityRoster,
    markers: MarkerDevice,
    private readonly mapDisplay: SettingValue<MapDisplayToggles>,
  ) {
    this.group = markers.createGroup();
  }

  // このフレームで必要な個体だけを解き、消滅・非表示になった個体の解を失効させる。
  // navTargetId は航法ターゲットの id で、未設定なら null。view は表に出ているビュー。
  public update(
    inputs: EquatorNodeInputs, controlled: Controllable | null, navTargetId: string | null, view: ViewMode,
  ): void {
    // マップの表示設定で伏せた個体は、マップでは交点も伏せる。
    const visibilityPolicy = view === 'map'
      ? new MapVisibilityPolicy(inputs.celestialBodies, this.mapDisplay.current)
      : null;
    // roster にいる個体ごとに、交点を出すなら解き、出さないなら解を失効させる。
    const retainedIds = new Set<string>();
    for (const entity of this.roster.all()) {
      retainedIds.add(entity.id);
      const current = this.pairs.get(entity.id);
      // マップ上の現れ方と注目状態(常時表示・操作対象・航法ターゲット)から、交点を出すかを決める。
      const onMap = entity.mapKind === null || visibilityPolicy === null
        || appearsOnMap(visibilityPolicy.entity(entity.mapKind, entity === controlled));
      const visible = entity.motion.alive && onMap
        && (entity.showsEquatorNodesAlways || entity === controlled || entity.id === navTargetId);
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
      pair.pushDeclarations(
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
