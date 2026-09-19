// 軌道要素・軌道要素アイコンの表示基準の解決。選ばれた基準の選び方(自動/地球/月/航法ターゲット)に
// 応じて、基準天体・対象の状態(KinematicState)を解く。
import { strongestAttractor } from '../physics/attractor';
import type { CelestialBodies } from './celestial/celestial-bodies';
import { KinematicState } from '../physics/kinematic-state';
import type { Vec3 } from '../math/vec3';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { NavTargetPresenter } from './nav-target-presenter';
import type { EntityRoster } from './dynamic/entity-roster';
import type { CelestialBody } from '../physics/celestial-body';
import type { OrbitReferenceMode } from './viewer/orbit-reference-selection';

export interface OrbitReference {
  readonly id: string;
  readonly state: KinematicState;
  readonly hasMass: boolean; // false なら重力中心ではなく、apsis/傾斜角/周期は意味を持たない
  readonly attractor: CelestialBody | null; // hasMass のときだけ非null。mu/radius を要る軌道要素解決に使う
  readonly entity: DynamicEntity | null; // hasMass=false かつ対象が艦・基地のときだけ非null
  // 自動選択(auto)ではなく、地球・月・ターゲットのいずれかに明示的に固定されているか。
  // 固定中は、各エンティティの軌道線もこの基準に従う(自身にとっての strongestAttractor を
  // 使わない)。ターゲット未設定・解決不能で自動選択にフォールバックした場合は false。
  readonly fixed: boolean;
}

// エンティティ1体の軌道線を何基準で描くか(ORBIT.md「軌道線(3D描画)の基準天体は、戦闘ビューと
// マップビューで扱いが異なる」)。center が null なら、その瞬間最も強く引いている天体を中心にする。
type OrbitLineBasis =
  | { readonly kind: 'ellipse'; readonly center: CelestialBody | null }
  | { readonly kind: 'relative'; readonly target: DynamicEntity }
  | { readonly kind: 'none' };

// fixed / hasMass / attractor / entity の組み合わせを解くのはここだけにする。
export function orbitLineBasisOf(ref: OrbitReference | undefined, self: DynamicEntity): OrbitLineBasis {
  if (ref === undefined || !ref.fixed) return { kind: 'ellipse', center: null };
  if (ref.hasMass) return { kind: 'ellipse', center: ref.attractor };
  if (ref.entity !== null && ref.entity !== self) return { kind: 'relative', target: ref.entity };
  return { kind: 'none' };
}

// 常に strongestAttractor で基準を選ぶ(切替不可の場面向け)。プロパティウィンドウの
// 「軌道」欄など、常設パネルの基準選択とは独立に軌道要素を出す場所が使う。
export function autoOrbitReference(
  r: Vec3, attractors: readonly CelestialBody[], pivot: number,
): OrbitReference {
  const center = strongestAttractor(r, attractors, pivot);
  return {
    id: center.id, state: center.stateAt(pivot), hasMass: true, attractor: center,
    entity: null, fixed: false,
  };
}

// 選び方 mode での、r 位置のエンティティに対する基準を解決する。地球・月が登録に無い、または航法
// ターゲットが未設定・解決不能なときは自動選択(strongestAttractor)へフォールバックする。
export function resolveOrbitReference(
  mode: OrbitReferenceMode, r: Vec3, attractors: readonly CelestialBody[], navTarget: NavTargetPresenter,
  roster: EntityRoster, celestialBodies: CelestialBodies, t: number,
): OrbitReference {
  // 地球・月に固定する選び方では、選び方の名前がそのまま天体 id になる。
  if (mode === 'earth' || mode === 'moon') {
    const found = celestialBodies.findMotion(mode);
    if (found !== null) {
      return {
        id: found.id, state: found.stateAt(t), hasMass: true, attractor: found,
        entity: null, fixed: true,
      };
    }
  } else if (mode === 'target') {
    const resolved = navTarget.resolveState(roster, celestialBodies, attractors, t);
    if (resolved) return resolved;
  }
  // 'auto' と、固定先を解けなかった場合。
  return autoOrbitReference(r, attractors, t);
}
