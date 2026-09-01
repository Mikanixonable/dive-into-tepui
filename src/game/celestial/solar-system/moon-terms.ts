// 月の軌道の黄経・黄緯・動径にかかる周期摂動項。
import { PerturbationTerm } from '../../../physics/satellite-orbit';

const D2R = Math.PI / 180;

// 月の周期摂動項(出典: Jean Meeus『Astronomical Algorithms』第47章 Table 47.A/47.B、
// Brown の月理論の切り詰め)。**黄経で 0.01°(≒70 km)を超える項までを採用**した — 黄経は
// 14項、動径は同じ引数の行のうち Σr 欄が空(係数0)の1行を除いた13項、黄緯は7項。
// 引数 d/m/mp/f は Meeus の基本角 D(太陽からの平均離角)/M(太陽の平均近点角)/
// M'(月の平均近点角)/F(月の昇交点からの緯度引数)そのままの整数倍係数。**中心差に相当する
// mp のみの行((0,0,1,0) sin M' 6.288774°・(0,0,2,0)・(0,0,3,0) というその高調波も含む —
// これらは e のべき級数として二体ケプラー解の中心差展開と一致するため二重計上になる)と、
// 黄緯の主傾斜に相当する f のみの行((0,0,0,1) sin F 5.128122°)は、この表から意図的に
// 除外している**(`satellite-orbit.test.ts` の該当テストがこの除外を機械的に検査する)。
export const MOON_LON_TERMS: readonly PerturbationTerm[] = [
  { d: 2, m: 0, mp: -1, f: 0, amp: 1274027e-6 * D2R }, // 出差 evection
  { d: 2, m: 0, mp: 0, f: 0, amp: 658314e-6 * D2R }, // 二均差 variation
  { d: 0, m: 1, mp: 0, f: 0, amp: -185116e-6 * D2R }, // 年差 annual equation
  { d: 2, m: 0, mp: -2, f: 0, amp: 58793e-6 * D2R },
  { d: 2, m: -1, mp: -1, f: 0, amp: 57066e-6 * D2R },
  { d: 2, m: 0, mp: 1, f: 0, amp: 53322e-6 * D2R },
  { d: 2, m: -1, mp: 0, f: 0, amp: 45758e-6 * D2R },
  { d: 0, m: 1, mp: -1, f: 0, amp: -40923e-6 * D2R },
  { d: 1, m: 0, mp: 0, f: 0, amp: -34720e-6 * D2R }, // 視差不等 parallactic inequality
  { d: 0, m: 1, mp: 1, f: 0, amp: -30383e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: -2, amp: 15327e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: 2, amp: -12528e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: -2, amp: 10980e-6 * D2R },
  { d: 4, m: 0, mp: -1, f: 0, amp: 10675e-6 * D2R },
];

export const MOON_LAT_TERMS: readonly PerturbationTerm[] = [
  { d: 0, m: 0, mp: 1, f: 1, amp: 280602e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: -1, amp: 277693e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: -1, amp: 173237e-6 * D2R },
  { d: 2, m: 0, mp: -1, f: 1, amp: 55413e-6 * D2R },
  { d: 2, m: 0, mp: -1, f: -1, amp: 46271e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: 1, amp: 32573e-6 * D2R },
  { d: 0, m: 0, mp: 2, f: 1, amp: 17198e-6 * D2R },
];

// 動径補正は Meeus の表の値が既に [0.001 km] = [m] 単位なので、そのまま m として使える。
// (0,0,1,2) は Meeus の表で Σr 欄が空(係数0)のため、この表には含めない。
export const MOON_DIST_TERMS: readonly PerturbationTerm[] = [
  { d: 2, m: 0, mp: -1, f: 0, amp: -3699111 },
  { d: 2, m: 0, mp: 0, f: 0, amp: -2955968 },
  { d: 0, m: 1, mp: 0, f: 0, amp: 48888 },
  { d: 2, m: 0, mp: -2, f: 0, amp: 246158 },
  { d: 2, m: -1, mp: -1, f: 0, amp: -152138 },
  { d: 2, m: 0, mp: 1, f: 0, amp: -170733 },
  { d: 2, m: -1, mp: 0, f: 0, amp: -204586 },
  { d: 0, m: 1, mp: -1, f: 0, amp: -129620 },
  { d: 1, m: 0, mp: 0, f: 0, amp: 108743 },
  { d: 0, m: 1, mp: 1, f: 0, amp: 104755 },
  { d: 2, m: 0, mp: 0, f: -2, amp: 10321 },
  { d: 0, m: 0, mp: 1, f: -2, amp: 79661 },
  { d: 4, m: 0, mp: -1, f: 0, amp: -34782 },
];
