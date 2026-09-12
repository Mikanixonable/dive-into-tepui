// 星系の天体を id で引く索引。天体の表示名・主天体・所属する系・時刻ごとの ECI 状態と、
// 座標系の解決役を答える。1フレームぶんの積分が読む役割別の一覧もここが答える。
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { TdbJulianDate } from '../../physics/time';
import type { Vec3 } from '../../math/vec3';
import type { CelestialClass } from './celestial-entity/celestial-entity-def';
import type { ReferenceFrames } from './reference-frames';

// 1フレームの積分が読む天体を、役割ごとの一覧として答える顔ぶれ。重力・接触判定・抗力は
// 個体ではなくこの一覧に対して回る。並びは天体の宣言順で、時刻ごとの解決は天体1体が畳む。
export interface FrameCelestialBodies {
  // 全登録天体。中心天体は原点に静止。
  readonly celestialMotions: readonly CelestialBody[];
  // mu が 0 でない天体。
  readonly gravityMotions: readonly CelestialBody[];
  // 大気を持つ天体。
  readonly atmosphereMotions: readonly CelestialBody[];
}

export interface CelestialBodies extends FrameCelestialBodies {
  // simTime=0 が指す絶対時刻。
  readonly epoch: TdbJulianDate;
  // 座標系の同一性(同じ対に同じ参照)と、天体でない基準の解決。
  readonly frames: ReferenceFrames;

  // 天体 id の表示名。未登録の id はそのまま返す。
  nameOf(id: string): string;
  // 天体 id が登録されているか。
  has(id: string): boolean;
  // 天体 id の運動。未登録の id を渡すと例外になる。
  motionOf(id: string): CelestialBody;
  // 天体 id の運動。未登録の id では null。id が登録済みだと言い切れないときはこちらを使う。
  findMotion(id: string): CelestialBody | null;
  // 天体 id の分類。未登録の id では null。
  bodyClassOf(id: string): CelestialClass | null;
  // 主星の天体 id。恒星を持たない星系では null。
  readonly starId: string | null;
  // ECI の原点に静止している天体の id。
  readonly originId: string;
  // 天体 id の、pivot で厳密に引いた値から時刻 t へ外挿した ECI 位置・速度。
  stateAt(id: string, pivot: number, t?: number): KinematicState;
  // ECI の点 r から見た恒星方向の単位ベクトル。
  sunDirFrom(r: Vec3, t: number): Vec3;

  // 天体 id の主天体。未登録なら undefined、主天体を持たなければ null。
  bodyParentId(id: string): string | null | undefined;
  // focusId から主星まで遡った先祖の id(近い順)。focusId 自身は含まない。
  ancestorsOf(focusId: string): readonly string[];
  // focusId と同じ系に属する天体の id。focusId を省くと空集合。
  sameSystemIds(focusId: string | undefined): ReadonlySet<string>;
  // id から主星までの系の鎖(内側から外側の順)。系に属さない id では空。
  chainFrom(id: string): readonly string[];
  // 鎖の各段に属する天体の id をまとめたもの。重複は畳む。
  membersFrom(chain: readonly string[]): readonly string[];
  // カメラ位置がいる系の成員の id。pivot は天体位置を厳密に引く時刻。
  systemMembersAt(cameraPos: Vec3, pivot: number): readonly string[];
  // position が focusId の系の内側にあるか。focusId を省くと常に true。
  isPositionInFocusedSystem(focusId: string | undefined, position: Vec3, pivot: number): boolean;
}
