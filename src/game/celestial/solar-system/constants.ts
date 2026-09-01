// 太陽系の天体が共有する物理定数。値の出典は各行のコメント。

// 万有引力定数 [m^3/(kg・s^2)]。MU_* は測定された GM を直接持つ値なのでこれで割り直さないこと —
// GM が測定されておらず質量から導く天体だけがこれを使う。
export const GRAVITATIONAL_CONSTANT = 6.6743e-11;

export const MU_SUN = 1.32712440018e20; // [m^3/s^2]
export const R_SUN = 6.957e8; // [m]
export const MU_MOON = 4.9048695e12;
export const R_MOON = 1.7374e6;
export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]
// 衛星を抱える惑星の重力定数 [m^3/s^2]。衛星の平均運動をケプラー第3法則で出すのに要るため、
// 惑星本体の定義と衛星の軌道が同じ1つの値を読む。
export const MU_MARS = 4.282837e13;
export const MU_JUPITER = 1.26686534e17;
export const MU_SATURN = 3.7931187e16;
export const MU_NEPTUNE = 6.836529e15;

// 2次の重力場係数(いずれも非正規化)。正規化係数を収録した外部データで更新する際は換算が要る。
export const J2_EARTH = 1.08262668e-3;
// GRAIL による測定値。基準半径 1738.0 km は月の表面半径 R_MOON とは別の量なので分けて持つ。
export const J2_MOON = 203.3e-6;
export const C22_MOON = 22.4e-6;
export const R_MOON_GRAVITY = 1.7380e6; // [m]
// 月の赤道が黄道に対して傾く角(カッシーニ第2法則)。
export const MOON_OBLIQUITY = 1.543 * (Math.PI / 180); // [rad]
