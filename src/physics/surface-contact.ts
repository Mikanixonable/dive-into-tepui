// 天体の表面との接触。ある区間を渡る球が、渡された天体のうちどれに最初に触れるかを1体選ぶ。
// 触れたあとどうなるか(跳ね返る / 経路を打ち切る)は呼び出し側が決める。
//
// 天体を相手にするので天体の運動を読むが、**依存はこの向きだけ**である — 重力のモジュールは
// 何が何を引くかにだけ答え、何が何に触れたかには答えない。
import type { CelestialMotion } from './celestial-motion';
import { ContactGeometry, sphereContactGeometry } from './collision-response';
import { KinematicState } from './kinematic-state';

// 区間内で最初に触れた天体と、その接触の幾何。
interface SurfaceContact {
  readonly body: CelestialMotion;
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
  bodies: readonly CelestialMotion[],
  pivot: number,
): SurfaceContact | null {
  const swept = prev.t < next.t;
  let earliest: SurfaceContact | null = null;
  // 跨いだのか、区間の終端で重なっているだけなのかは幾何の側が決める。ここはどちらの場合も
  // 同じ toi で比べて1体に絞るだけで、区別は幾何を受け取った呼び出し側が付ける。
  for (const body of bodies) {
    const geometry = sphereContactGeometry(
      { state: next, radius },
      { state: body.stateAt(pivot, next.t), radius: body.def.radius },
      swept ? prev : undefined,
      swept ? body.stateAt(pivot, prev.t) : undefined,
    );
    if (geometry === null) continue;
    if (earliest === null || geometry.toi < earliest.geometry.toi) earliest = { body, geometry };
  }
  return earliest;
}
