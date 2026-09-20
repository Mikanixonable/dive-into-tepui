// 天体表面との接触判定。指定区間を移動する球体または複合形状が、渡された天体群の中で
// 最初に接触する天体およびその接触幾何情報を判定する。
//
// 天体を相手にするので天体の運動を読むが、**依存はこの向きだけ**である — 重力のモジュールは
// 何が何を引くかにだけ答え、何が何に触れたかには答えない。
import { type ContactGeometry, sphereContactGeometry } from './collision-response';
import type { KinematicState } from './kinematic-state';
import type { CelestialBody } from './celestial-body';
import type { Attitude } from './attitude';
import { sweptSphereContact } from './sphere-contact';
import {
  sweptCompoundSphereContact,
  type CompoundSphereShape,
} from './compound-sphere-contact';
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

export type SurfaceBodyStateAt = (
  body: CelestialBody, pivot: number, time: number,
) => KinematicState;

function defaultBodyStateAt(body: CelestialBody, pivot: number, time: number): KinematicState {
  return body.stateAt(pivot, time);
}

function boundingSphereMayContact(
  objectPrev: KinematicState,
  objectNext: KinematicState,
  bodyPrev: KinematicState,
  bodyNext: KinematicState,
  objectRadius: number,
  bodyRadius: number,
): boolean {
  const contact = sweptSphereContact(
    objectPrev, objectNext, bodyPrev, bodyNext, objectRadius + bodyRadius,
  );
  return contact !== null && (contact.startsInside || contact.crossing !== null);
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
  surfaceShape: CompoundSphereShape | null = null,
  bodyStateAt: SurfaceBodyStateAt = defaultBodyStateAt,
): SurfaceContact | null {
  const swept = prev.t < next.t;
  let earliest: SurfaceContact | null = null;
  // 区間内の通過か終端での重なりかにかかわらず、接触時刻（toi）が最小となる天体を1体特定する。
  for (const body of bodies) {
    const bodyNext = bodyStateAt(body, pivot, next.t);
    const bodyPrev = swept ? bodyStateAt(body, pivot, prev.t) : bodyNext;
    let geometry: ContactGeometry | null;
    if (shape !== null) {
      const mayContact = surfaceShape !== null
        ? sweptCompoundSphereContact(
          surfaceShape, prev, next, bodyPrev, bodyNext, body.def.radius,
        ) !== null
        : boundingSphereMayContact(
          prev, next, bodyPrev, bodyNext, radius, body.def.radius,
        );
      if (!mayContact) continue;
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
