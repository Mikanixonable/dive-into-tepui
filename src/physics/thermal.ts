// 物体の熱収支を**比量(単位質量あたり)**で表す純関数。質量も半径もここには現れない —
// 弾道係数の逆数 bcInv = Cd·A/m が既に比量なので、抗力による散逸も空力加熱も比量で閉じる。
// 温度は物体を等温の1点とみなして扱う。THREE/DOM 非依存。
//
// **物体へ入る熱は、その区間に散逸した力学エネルギーを超えない。** 加熱の相関式は流れの
// 局所量から熱流束を出すだけで収支を知らないので、超えないことは受け取る側で保証する。

// ステファン・ボルツマン定数 [W/m²/K⁴]。
export const STEFAN_BOLTZMANN = 5.670374419e-8;

// 抗力が散らす力学的パワー [W/kg]。density は大気密度 [kg/m³]、airspeed は対気速さ [m/s]、
// bcInv は弾道係数の逆数 Cd·A/m [m²/kg]。
export function dragDissipation(density: number, airspeed: number, bcInv: number): number {
  return 0.5 * density * airspeed * airspeed * airspeed * bcInv;
}

// 一様な密度の球とみなしたときのよどみ点の曲率半径 [m]。bcInv = Cd·A/m に A = πR²、
// m = (4/3)πR³ρ を入れると R = 3·Cd/(4·ρ·bcInv) が残る — 形は bcInv が既に運んでいるので、
// 材質の密度 bulkDensity [kg/m³] を足すだけで曲率半径が決まる。
export function sphereNoseRadius(bcInv: number, dragCoefficient: number, bulkDensity: number): number {
  return (3 * dragCoefficient) / (4 * bulkDensity * bcInv);
}

// よどみ点の対流加熱が物体へ入れる比パワー [W/kg]。熱流束は Sutton–Graves の相関式
// q̇ = k·√(ρ/Rn)·s³ [W/m²] で、sgConst は大気の組成で決まる定数 [kg^0.5/m]、noseRadius は
// よどみ点の曲率半径 [m]、absorbAreaPerMass はそれを受ける面積の比 [m²/kg]。
//
// **抗力の散逸で頭打ちにする。** 相関式は熱流束を局所量だけから出すので、薄い大気では
// 抗力が奪った以上の熱を入れうる(比は 1/√ρ で増える)。
export function aeroHeating(
  density: number,
  airspeed: number,
  bcInv: number,
  sgConst: number,
  noseRadius: number,
  absorbAreaPerMass: number,
): number {
  const dissipation = dragDissipation(density, airspeed, bcInv);
  if (!(dissipation > 0) || !(noseRadius > 0)) return 0;
  const flux = sgConst * Math.sqrt(density / noseRadius) * airspeed * airspeed * airspeed;
  return Math.min(flux * absorbAreaPerMass, dissipation);
}

// 放射で捨てる比パワー [W/kg]。温度が環境温度 envTemp より高ければ正、低ければ負(暖まる)。
// radiatingAreaPerMass は輻射面積の比 [m²/kg]。
//
// dt のあいだに捨てる量は、環境温度との差を埋めるところで頭打ちにする — 放熱は温度を環境
// 温度へ近づけるだけで、通り越させることはできない。頭打ちに触れるのは刻みが比熱に対して
// 既に広すぎるときだけだが、外すとそこで T⁴ が段どうしで増幅し合い、1歩で発散する。
export function radiativeCooling(
  temperature: number,
  envTemp: number,
  emissivity: number,
  radiatingAreaPerMass: number,
  specificHeat: number,
  dt: number,
): number {
  const t2 = temperature * temperature;
  const e2 = envTemp * envTemp;
  const power = emissivity * STEFAN_BOLTZMANN * radiatingAreaPerMass * (t2 * t2 - e2 * e2);
  if (!(specificHeat > 0) || !(dt > 0)) return power;
  // 温度差をちょうど埋めるパワー。符号は power と揃うので、絶対値の小さいほうを採ればよい。
  const toEquilibrium = ((temperature - envTemp) * specificHeat) / dt;
  return power > 0 ? Math.min(power, toEquilibrium) : Math.max(power, toEquilibrium);
}

// 正味の比パワー netPower [W/kg] で温度を dt だけ進めた値 [K]。
// specificHeat = 0 は熱を蓄えない物体を表し、温度は動かない。
export function stepTemperature(
  temperature: number, netPower: number, specificHeat: number, dt: number,
): number {
  if (!(specificHeat > 0)) return temperature;
  return temperature + (netPower / specificHeat) * dt;
}
