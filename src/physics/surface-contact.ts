// 天体の表面との接触。ある区間を渡る球が、渡された天体のうちどれに最初に触れるかを1体選ぶ。
// 触れたあとどうなるか(跳ね返る / 経路を打ち切る)は呼び出し側が決める。
//
// 天体を相手にするので天体の運動を読むが、**依存はこの向きだけ**である — 重力のモジュールは
// 何が何を引くかにだけ答え、何が何に触れたかには答えない。
import { ContactGeometry, sphereContactGeometry } from './collision-response';
import { KinematicState } from './kinematic-state';
import type { CelestialBody } from './celestial-body';
import type { Attitude } from './attitude';
import {
  compoundCylinderSphereContact,
  sweptCompoundCylinderSphereContact,
  type CompoundCylinderShape,
} from './compound-cylinder-contact';

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

// 区間内で最初に触れた天体と、その接触の幾何。
interface SurfaceContact {
  readonly body: CelestialBody;
  readonly geometry: ContactGeometry;
}

// 区間 [prev, next] を渡る半径 radius の球が、bodies のうち最初に触れる天体。触れなければ null。
// 触れ合ったとみなす距離は天体の表面半径に radius を足したもので、天体の側も pivot で厳密に
// 引いた値から区間の両端へ外挿して動く。区間を持たない(prev と next が同じ瞬間の)入力は
// 掃引が定まらないので、区間終端の重なりだけを見る。
export function firstSurfaceContact(
  prev: KinematicState,
  next: KinematicState,
  radius: number,
  bodies: readonly CelestialBody[],
  pivot: number,
  shape: CompoundCylinderShape | null = null,
  prevAtt?: Attitude,
  att?: Attitude,
): SurfaceContact | null {
  const swept = prev.t < next.t;
  let earliest: SurfaceContact | null = null;
  // 跨いだのか、区間の終端で重なっているだけなのかは幾何の側が決める。ここはどちらの場合も
  // 同じ toi で比べて1体に絞るだけで、区別は幾何を受け取った呼び出し側が付ける。
  for (const body of bodies) {
    const bodyNext = body.stateAt(pivot, next.t);
    const bodyPrev = swept ? body.stateAt(pivot, prev.t) : bodyNext;
    let geometry: ContactGeometry | null;
    if (shape !== null) {
      // compound を宣言した参加者は外接球へ戻さない。古い試験用参加者が姿勢を持たない
      // 場合だけ単位姿勢とし、形状の空間を接触として扱う偽陽性を避ける。
      const endRotation = att?.q ?? IDENTITY_ROTATION;
      const startPose = { position: prev.r, rotation: prevAtt?.q ?? endRotation };
      const endPose = { position: next.r, rotation: endRotation };
      const sweepHit = swept
        ? sweptCompoundCylinderSphereContact(
          shape, startPose, endPose, bodyPrev.r, bodyNext.r, body.def.radius)
        : null;
      if (sweepHit !== null) {
        // swept hit の depth は接触時刻の局所値なので、終端のめり込みだけを
        // 終端 pose で求める。normal / point / moduleId は最初の hit のものを保つ。
        const endHit = compoundCylinderSphereContact(shape, endPose, bodyNext.r, body.def.radius);
        geometry = {
          normal: sweepHit.normal,
          toi: sweepHit.toi,
          pushOut: endHit?.depth ?? 0,
          contactPoint: sweepHit.point,
          moduleIdA: sweepHit.moduleIdA,
          moduleIdB: null,
        };
      } else {
        const endHit = compoundCylinderSphereContact(shape, endPose, bodyNext.r, body.def.radius);
        geometry = endHit === null ? null : {
          normal: endHit.normal,
          toi: 1,
          pushOut: endHit.depth,
          contactPoint: endHit.point,
          moduleIdA: endHit.moduleIdA,
          moduleIdB: null,
        };
      }
    } else {
      geometry = sphereContactGeometry(
        { state: next, radius },
        { state: bodyNext, radius: body.def.radius },
        swept ? prev : undefined,
        swept ? bodyPrev : undefined,
      );
    }
    if (geometry === null) continue;
    if (earliest === null || geometry.toi < earliest.geometry.toi) earliest = { body, geometry };
  }
  return earliest;
}
