// 星系の天体について答える面。どの天体がどこに居て、何と呼ばれ、どの系に属するかを返す。
// 天体の見た目(CelestialEntity)も描画資源も持たないので、この面で受ける側は THREE も
// 描画パイプラインも引かない。
import type { CelestialMotions } from '../../physics/celestial-motion';
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { TdbJulianDate } from '../../physics/time';
import type { Vec3 } from '../../math/vec3';
import type { ReferenceFrames } from './reference-frames';

export interface CelestialBodies extends CelestialMotions {
  // simTime=0 が指す絶対時刻。
  readonly epoch: TdbJulianDate;
  // 座標系の同一性(同じ対に同じ参照)と、天体でない基準の解決。
  readonly frames: ReferenceFrames;

  // 天体 id の表示名。未登録の id はそのまま返す。
  nameOf(id: string): string;
  has(id: string): boolean;
  // 天体 id の運動。未登録の id を渡すと例外になる。
  motionOf(id: string): CelestialBody;
  // 天体 id の、pivot で厳密に引いた値から時刻 t へ外挿した ECI 位置・速度。
  stateAt(id: string, pivot: number, t?: number): KinematicState;
  // ECI の点 r から見た恒星方向の単位ベクトル。
  sunDirFrom(r: Vec3, t: number): Vec3;

  // 天体 id の主天体。未登録なら undefined、主天体を持たなければ null。
  bodyParentId(id: string): string | null | undefined;
  ancestorsOf(focusId: string): readonly string[];
  sameSystemIds(focusId: string | undefined): ReadonlySet<string>;
  chainFrom(id: string): readonly string[];
  membersFrom(chain: readonly string[]): readonly string[];
  systemMembersAt(cameraPos: Vec3, pivot: number): readonly string[];
  isPositionInFocusedSystem(focusId: string | undefined, position: Vec3, pivot: number): boolean;
}
