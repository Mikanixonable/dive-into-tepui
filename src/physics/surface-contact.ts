// 天体の表面との接触。ある区間を渡る球が、渡された天体のうちどれに最初に触れるかを1体選ぶ。
// 触れたあとどうなるか(跳ね返る / 経路を打ち切る)は呼び出し側が決める。
//
// 天体を相手にするので Attractor を読むが、**依存はこの向きだけ**である — 重力のモジュールは
// 何が何を引くかにだけ答え、何が何に触れたかには答えない。
import { Attractor, attractorStateAt } from './attractor';
import { ContactGeometry, sphereContactGeometry } from './collision-response';
import { KinematicState } from './kinematic-state';

// 区間内で最初に触れた天体と、その接触の幾何。
export interface SurfaceContact {
  readonly body: Attractor;
  readonly geometry: ContactGeometry;
}

// 区間 [prev, next] を渡る半径 radius の球が、bodies のうち最初に触れる天体。触れなければ null。
// 触れ合ったとみなす距離は天体の表面半径に radius を足したもので、天体の側もその区間ぶん動く。
// 区間を持たない(prev と next が同じ瞬間の)入力は掃引が定まらないので、区間終端の重なりだけを見る。
export function firstSurfaceContact(
  prev: KinematicState,
  next: KinematicState,
  radius: number,
  bodies: readonly Attractor[],
): SurfaceContact | null {
  const swept = prev.t < next.t;
  let earliest: SurfaceContact | null = null;
  for (const body of bodies) {
    const geometry = sphereContactGeometry(
      { state: next, radius },
      { state: attractorStateAt(body, next.t), radius: body.radius },
      swept ? prev : undefined,
      swept ? attractorStateAt(body, prev.t) : undefined,
    );
    if (geometry === null) continue;
    if (earliest === null || geometry.toi < earliest.geometry.toi) earliest = { body, geometry };
  }
  return earliest;
}
