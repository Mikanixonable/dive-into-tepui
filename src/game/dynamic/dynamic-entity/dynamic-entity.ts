import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import { Q_IDENTITY } from '../../../math/quat';
import type { Ray } from '../../../math/ray';
import { v3, type Vec3 } from '../../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility, type MapVisibilityPolicy } from '../../map/visibility-policy';
import type { EntitySaveDataUnion } from '../../save/save-data';
import type { OrbitingObject } from './orbiting-object';
import type { CapKind, DynamicEntityKind } from './entity-kind';
import { EntityIdAllocator } from './entity-id';
import { DynamicMotion } from '../dynamic-motion';
import { DynamicView, type DynamicViewFrame } from '../../../render/dynamic/dynamic-view';

export type DynamicMotionFactory = (owner: DynamicEntity) => DynamicMotion;
export type DynamicViewFactory = (owner: DynamicEntity) => DynamicView;

// 姿勢を持たない生成元に与える、回転・角速度なしの既定姿勢。
function identityAttitude(): Attitude {
  return { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
}

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

  // 識別、Motion、View を1体の寿命へ束ねる。factory には生成済みの owner を渡す。
  public constructor(
    state: KinematicState,
    view: DynamicView | DynamicViewFactory,
    attitude: Attitude = identityAttitude(),
    id?: string,
    motionFactory?: DynamicMotionFactory,
  ) {
    this.id = id ?? DynamicEntity.idAllocator.next();
    this.nameValue = this.id;
    this.motion = motionFactory?.(this) ?? new DynamicMotion(state, { attitude });
    this.view = typeof view === 'function' ? view(this) : view;
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

  // Entity 自身を表示入力として、同じフレームの Motion と context を View へ渡す。
  public sync(context: DynamicViewFrame): void {
    this.view.sync(this, this.motion, context);
  }

  // この個体が所有する View 資源を解放する。
  public dispose(): void {
    this.view.dispose();
  }
}
