// 軌道要素・軌道要素アイコンの表示基準(自動/地球/月/航法ターゲット)の選択と解決。
// 選択状態そのものを持ち、モードに応じて基準天体・対象の状態(KinematicState)を解決する。
import { CelestialBody, strongestAttractor } from '../physics/celestial-body';
import type { Ephemeris } from '../physics/ephemeris';
import { KinematicState } from '../physics/kinematic-state';
import type { Vec3 } from '../physics/vec3';
import type { NavTarget } from './nav-target';
import type { EntityManager } from './simulation/entity-manager';

export type OrbitReferenceMode = 'auto' | 'earth' | 'moon' | 'target';

export interface OrbitReference {
  readonly id: string;
  readonly state: KinematicState;
  readonly hasMass: boolean; // false なら重力中心ではなく、apsis/傾斜角/周期は意味を持たない
  readonly attractor: CelestialBody | null; // hasMass のときだけ非null。mu/radius を要る軌道要素解決に使う
}

// 常に strongestAttractor で基準を選ぶ(切替不可の場面向け)。プロパティウィンドウの
// 「軌道」欄など、常設パネルの基準選択とは独立に軌道要素を出す場所が使う。
export function autoOrbitReference(r: Vec3, celestialBodies: readonly CelestialBody[]): OrbitReference {
  const center = strongestAttractor(r, celestialBodies);
  return { id: center.id, state: center.state, hasMass: true, attractor: center };
}

export class OrbitReferenceSelector {
  private mode: OrbitReferenceMode = 'auto';

  get selectedMode(): OrbitReferenceMode {
    return this.mode;
  }

  setMode(mode: OrbitReferenceMode): void {
    this.mode = mode;
  }

  // r 位置のエンティティに対する現在の基準を解決する。地球・月が登録に無い、または航法
  // ターゲットが未設定・解決不能なときは自動選択(strongestAttractor)へフォールバックする。
  resolve(
    r: Vec3, celestialBodies: readonly CelestialBody[], navTarget: NavTarget, entities: EntityManager,
    ephemeris: Ephemeris, t: number,
  ): OrbitReference {
    if (this.mode === 'earth' || this.mode === 'moon') {
      const found = celestialBodies.find((a) => a.id === this.mode);
      if (found) return { id: found.id, state: found.state, hasMass: true, attractor: found };
    } else if (this.mode === 'target') {
      const resolved = navTarget.resolveState(entities, ephemeris, celestialBodies, t);
      if (resolved) return resolved;
    }
    return autoOrbitReference(r, celestialBodies);
  }
}
