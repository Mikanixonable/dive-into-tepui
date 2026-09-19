import type { Ray } from '../../../math/ray';
import type { Quat } from '../../../math/quat';
import type { SerializedVec3, Vec3 } from '../../../math/vec3';
import { serializeKinematicState, type SerializedKinematicState } from '../../../physics/kinematic-state';
import { MARKER_VISIBILITY, type MapVisibility, type MapVisibilityPolicy } from '../../map/visibility-policy';
import type { OrbitingObject } from './orbiting-object';
import type { CapKind, DynamicEntityKind } from './entity-kind';
import type { SerializedDynamicEntity } from './entity-dictionary';
import type { DynamicMotion } from '../dynamic-motion';
import type { OrbitReference } from '../../orbit-reference';
import type {
  DynamicView, DynamicRenderSource, DynamicViewFrame,
} from '../../../render/dynamic/dynamic-view';

export type DynamicMotionFactory = (owner: DynamicEntity) => DynamicMotion;

// 実体の直列化に共通する項目。t・r・v は運動状態、q・w は姿勢と角速度、alive は生死。
export interface SerializedDynamicEntityFields extends SerializedKinematicState {
  readonly id: string;
  // 具象クラスのタグ。
  readonly kind:
    | 'player' | 'metal-enemy' | 'protein-enemy' | 'ammo' | 'rcs-fuel' | 'booster' | 'base' | 'bullet' | 'debris';
  readonly q: Quat;
  readonly w: SerializedVec3;
  readonly alive?: boolean;
}

// 1体ぶんの Motion と View を結び、両者に共通するゲーム上の識別と判断を持つ。
export abstract class DynamicEntity {
  public readonly id: string;
  public readonly motion: DynamicMotion;
  public readonly view: DynamicView;
  // 上限の枠とマップ上の種別(持たなければ null)と、派生 Entity が上書きする能力の旗。
  public readonly capKind: CapKind | null = null;
  public readonly mapKind: DynamicEntityKind | null = null;
  public readonly combatTarget: boolean = false;
  public readonly controllable: boolean = false;
  public readonly pickable: boolean = false;
  // 死亡した個体の除去を所有者に任せるか。
  public readonly reclaimedByOwner: boolean = false;
  // 選択の有無によらず赤道交点マーカーを出すか。
  public readonly showsEquatorNodesAlways: boolean = false;

  private nameValue: string;

  // 識別、Motion、View を1体の寿命へ束ねる。id は採番器が配った識別子で、motionFactory には id を
  // 確定させた自身を渡す。
  public constructor(motionFactory: DynamicMotionFactory, view: DynamicView, id: string) {
    this.id = id;
    this.nameValue = this.id;
    this.motion = motionFactory(this);
    this.view = view;
  }

  public get name(): string { return this.nameValue; }

  // 表示名を name に確定する。
  protected setName(name: string): void {
    this.nameValue = name;
  }

  // 種別を持たない対象は共通マーカー規則、それ以外は同フレームの policy に従う。
  public mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility {
    return this.mapKind === null ? MARKER_VISIBILITY : policy.entity(this.mapKind, this.id === viewer?.id);
  }

  // pos に置いたこの個体の判定形状へ ray が当たるか。
  public hitBodyByRay(ray: Ray, pos: Vec3): boolean {
    return this.motion.intersectsRay(ray, pos);
  }

  // 直列化した形へ変換する。
  public abstract serialize(): SerializedDynamicEntity;

  // 実体に共通する直列化の項目。kind は具象のタグ。具象の serialize() がこれへ自分の項目を足す。
  // 例外(ARCHITECTURE R12): 運動の値(状態・姿勢・生死。具象では熱・燃料・半径・慣性なども)を実体の
  // 記録へ平らに並べる。運動の記録として分けると版 4 の記録が読めなくなるので、版を上げるときに直す。
  protected serializeEntityFields<K extends SerializedDynamicEntityFields['kind']>(
    kind: K,
  ): SerializedDynamicEntityFields & { readonly kind: K } {
    const { state, att, alive } = this.motion;
    return {
      id: this.id,
      kind,
      ...serializeKinematicState(state),
      q: { ...att.q },
      w: { ...att.w },
      alive,
    };
  }

  // このフレームの表示入力。派生 Entity は自分の View が読む値を足したものを返す。
  // active はこの個体が操作対象か、orbitReference は軌道の基準として選ばれている天体。
  protected renderSource(
    _viewFrame: DynamicViewFrame, _active: boolean,
    _orbitReference: OrbitReference | undefined,
  ): DynamicRenderSource {
    const motion = this.motion;
    return {
      id: this.id,
      name: this.name,
      alive: motion.alive,
      stateAt: (t) => motion.stateAt(t),
      attitude: motion.att.q,
      // 比熱 0 の個体は熱を溜めないので、発光の表示入力は null。
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
    viewFrame: DynamicViewFrame, active: boolean, orbitReference: OrbitReference | undefined,
  ): void {
    this.view.sync(this.renderSource(viewFrame, active, orbitReference), viewFrame);
  }

  // この個体が所有する View 資源を解放する。
  public dispose(): void {
    this.view.dispose();
  }
}
