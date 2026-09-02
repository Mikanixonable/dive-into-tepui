// 惑星の IAU 自転極と、衛星の軌道要素が基準面に取る回転。
import { Quat } from '../../../math/quat';
import { equatorBasisToEci } from '../../../physics/body-orientation';
import { raDecToEci } from '../../../physics/ecliptic';
import { PoleModel } from '../../../physics/celestial-body-def';

export type IauPole = Extract<PoleModel, { readonly kind: 'iau' }>;

// 衛星を抱える惑星の自転軸。衛星の軌道要素はこの軸が張る赤道面の上で与えるため、
// 惑星本体の pole と衛星の基準面が同じ1つの定義を読む。
export const MARS_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 317.269202, ra1DegPerCentury: -0.10927547,
  dec0Deg: 54.432516, dec1DegPerCentury: -0.05827105,
  w0Deg: 176.049863, wRateDegPerDay: 350.891982443297,
};
export const JUPITER_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 268.056595, ra1DegPerCentury: -0.006499,
  dec0Deg: 64.495303, dec1DegPerCentury: 0.002413,
  w0Deg: 284.95, wRateDegPerDay: 870.536,
};
export const SATURN_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 40.589, ra1DegPerCentury: -0.036,
  dec0Deg: 83.537, dec1DegPerCentury: -0.004,
  w0Deg: 38.9, wRateDegPerDay: 810.7939024,
};
export const NEPTUNE_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 299.36, ra1DegPerCentury: 0.0,
  dec0Deg: 43.46, dec1DegPerCentury: 0.0,
  w0Deg: 249.978, wRateDegPerDay: 541.1397757,
};
// 天王星は自転軸が黄道に対し 97.8° 横倒しになっている。ここで求まる equatorBasis は
// 天王星の赤道面基準であって黄道面基準ではないので、以下の衛星の傾斜角を黄道基準の値と
// 読み替えないこと(横倒しの軸まわりでは両者が大きく異なる)。
export const URANUS_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 257.311, ra1DegPerCentury: 0.0,
  dec0Deg: -15.175, dec1DegPerCentury: 0.0,
  w0Deg: 203.81, wRateDegPerDay: -501.1600928,
};
export const PLUTO_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 132.993, ra1DegPerCentury: 0.0,
  dec0Deg: -6.163, dec1DegPerCentury: 0.0,
  w0Deg: 302.695, wRateDegPerDay: 56.3625225,
};

// 赤経・赤緯で与えた極が張る面を基準面とする回転。
function poleBasis(raDeg: number, decDeg: number): Quat {
  return equatorBasisToEci(raDecToEci(raDeg, decDeg));
}

// 惑星の赤道面を基準面とする回転。極の一次項は世紀あたり 0.11° 以下なので元期の極で固定する
// (「衛星の軌道面が親の赤道面に対して静止している」という近似そのものが、内側衛星の
// ラプラス面 ≈ 惑星赤道面という近似と同程度の粗さで、極のこの緩やかな動きはその中に埋もれる)。
// **IAU の「北極」は太陽系の不変面の北側にある方の極という定義で、自転角運動量の向きではない** —
// 逆行自転する天体(自転位相 W が減る = wRateDegPerDay < 0。天王星・金星)では両者が反対を向く。
// 規則衛星は親の自転と同じ向きに公転するので、基準面の極には角運動量の側を取る必要がある。
export function equatorBasis(pole: IauPole): Quat {
  const retrograde = pole.wRateDegPerDay < 0;
  return retrograde
    ? poleBasis(pole.ra0Deg + 180, -pole.dec0Deg)
    : poleBasis(pole.ra0Deg, pole.dec0Deg);
}

// 木星系・土星系の衛星の基準面である局所ラプラス面の極(出典: JPL Solar System Dynamics
// 衛星平均要素表)。ラプラス面は「衛星の昇交点歳差が平均的に含まれる面」で、内側では扁平
// 摂動が効いて親の赤道面に近く、外側では太陽潮汐が効いて親の公転面に近づく — 親の自転極から
// 導けないので、表が公開する極をそのまま持つ。この2系では親の IAU 自転極と 0.04° しか違わない。
export const JUPITER_LAPLACE_BASIS = poleBasis(268.1, 64.5);
export const SATURN_LAPLACE_BASIS = poleBasis(40.6, 83.5);
