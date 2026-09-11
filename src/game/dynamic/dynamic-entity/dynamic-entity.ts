import type { Ray } from '../../../math/ray';
import type { Vec3 } from '../../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility, type MapVisibilityPolicy } from '../../map/visibility-policy';
import type { EntitySaveDataUnion } from '../../save/save-data';
import type { OrbitingObject } from './orbiting-object';
import type { CapKind, DynamicEntityKind } from './entity-kind';
import { EntityIdAllocator } from './entity-id';
import type { DynamicMotion } from '../dynamic-motion';
import type { OrbitReference } from '../../orbit-reference';
import type {
  DynamicView, DynamicRenderSource, DynamicViewFrame,
} from '../../../render/dynamic/dynamic-view';

export type DynamicMotionFactory = (owner: DynamicEntity) => DynamicMotion;

// 1体ぶんの Motion と View を結び、両者に共通するゲーム上の識別と判断だけを持つ。
export class DynamicEntity {
  private static readonly idAllocator = new EntityIdAllocator('entity-');

  public readonly id: string;
  public readonly motion: DynamicMotion;
  public readonly view: DynamicView;
  public readonly capKind: CapKind | null = null;
  public readonly mapKind: DynamicEntityKind | null = null;
  public readonly combatTarget: boolean = false;
  public readonly controllable: boolean = false;
  public readonly pickable: boolean = false;
  public readonly reclaimedByOwner: boolean = false;
  public readonly showsEquatorNodesAlways: boolean = false;
  // マップで予測軌跡を表示するか。表示設定の正本は描画資源を持つ View の外へ置く。
  public trajectoryLineVisible = false;

  private nameValue: string;

  // 識別、Motion、View を1体の寿命へ束ねる。motionFactory には id を確定させた owner を渡す。
  // id を省くと基底の採番で発番する。
  public constructor(motionFactory: DynamicMotionFactory, view: DynamicView, id?: string) {
    this.id = id ?? DynamicEntity.idAllocator.next();
    this.nameValue = this.id;
    this.motion = motionFactory(this);
    this.view = view;
  }

  public get name(): string { return this.nameValue; }

  // 派生 Entity だけが表示名を確定できる。
  protected setName(name: string): void {
    this.nameValue = name;
  }

  // 種別を持たない対象は共通マーカー規則、それ以外は同フレームの policy に従う。
  public mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility {
    return this.mapKind === null ? MARKER_VISIBILITY : policy.entity(this.mapKind, this.id === viewer?.id);
  }

  // View の形状ではなく Motion の判定形状へ ray を問い合わせる。
  public hitBodyByRay(ray: Ray, pos: Vec3): boolean {
    return this.motion.intersectsRay(ray, pos);
  }

  // 永続化しない基底 Entity は null を返す。
  public serialize(): EntitySaveDataUnion | null {
    return null;
  }

  // このフレームの表示入力。派生 Entity は自分の View が読む値を足したものを返す。
  // visible はこのフレームに本体を出すか、active はこの個体が操作対象か、
  // orbitReference は軌道の基準として選ばれている天体。
  protected renderSource(
    _viewFrame: DynamicViewFrame, visible: boolean, _active: boolean,
    _orbitReference: OrbitReference | undefined,
  ): DynamicRenderSource {
    const motion = this.motion;
    return {
      id: this.id,
      name: this.name,
      visible,
      alive: motion.alive,
      stateAt: (t) => motion.stateAt(t),
      attitude: motion.att.q,
      // 比熱を持たない個体は熱を溜めないので、発光の表示入力そのものを持たせない。
      thermal: motion.specificHeat > 0
        ? {
          temperature: motion.temperature,
          deviation: motion.thermalDeviation,
          emissivity: motion.emissivity,
        }
        : null,
    };
  }

  // このフレームの表示入力を組み立てて View へ渡す。
  public sync(
    viewFrame: DynamicViewFrame, visible: boolean, active: boolean,
    orbitReference: OrbitReference | undefined,
  ): void {
    this.view.sync(this.renderSource(viewFrame, visible, active, orbitReference), viewFrame);
  }

  // この個体が所有する View 資源を解放する。
  public dispose(): void {
    this.view.dispose();
  }
}
