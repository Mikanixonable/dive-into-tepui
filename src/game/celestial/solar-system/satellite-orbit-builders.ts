// 公開された衛星平均要素表の列から SatelliteOrbit を組む補助。
import { Quat } from '../../../physics/attitude';
import { keplerPeriod } from '../../../physics/elements';
import { SatelliteOrbit, satelliteOrbit } from '../../../physics/satellite-orbit';
import { IauPole, equatorBasis } from './poles';

// 親惑星の赤道面を基準面に取る衛星の二体ケプラー軌道。要素は JPL Solar System Dynamics の
// 衛星平均要素(親惑星の赤道面基準)。歳差・周期摂動は実測値を持たないので置かない。
export function equatorialSatelliteOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  planetMu: number;
  planetPole: IauPole;
}): SatelliteOrbit {
  return satelliteOrbit({
    a: p.a,
    e: p.e,
    incDeg: p.incDeg,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: keplerPeriod(p.a, p.planetMu),
    nodePeriodSec: Infinity,
    perigeePeriodSec: Infinity,
    basisToEci: equatorBasis(p.planetPole),
    lonTerms: [],
    latTerms: [],
    distTerms: [],
  });
}

const JULIAN_YEAR_DAYS = 365.25;

// JPL Solar System Dynamics の衛星平均要素表の列(周期は日、歳差周期は年)をそのまま受ける
// 衛星軌道。基準面は既定で黄道面。公転周期は a とケプラー第3法則から導かず表の値をそのまま
// 使う — 遠方の衛星の平均運動は太陽摂動で二体値からずれており、公開された実測周期の方が近い。
// Ω/ω/M0 は表から転記していないので常に 0(登録済みの全衛星と同じ)。
export function jplSatelliteOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  periodDays: number;
  nodePeriodYears: number;
  apsisPeriodYears: number;
  basisToEci?: Quat;
}): SatelliteOrbit {
  return satelliteOrbit({
    a: p.a,
    e: p.e,
    incDeg: p.incDeg,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: p.periodDays * 86400,
    nodePeriodSec: p.nodePeriodYears * JULIAN_YEAR_DAYS * 86400,
    perigeePeriodSec: p.apsisPeriodYears * JULIAN_YEAR_DAYS * 86400,
    basisToEci: p.basisToEci,
    lonTerms: [],
    latTerms: [],
    distTerms: [],
  });
}

// 型注釈ではなく satisfies で受けることで、id ごとの具体型(地球なら惑星、月なら衛星)が
