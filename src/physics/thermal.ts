// 物体の熱収支を**比量(単位質量あたり)**で表す純関数。質量も半径もここには現れない —
// 弾道係数の逆数 bcInv = Cd·A/m が既に比量なので、抗力による散逸も空力加熱も比量で閉じる。
// 温度は物体全体の平均と、局所的に過熱した部分が平均からどれだけ高いかの2つで表す。
// THREE/DOM 非依存。
//
// **大気から入る熱は、その区間に散逸した力学エネルギーを超えない。** 加熱の相関式は流れの
// 局所量から熱流束を出すだけで収支を知らないので、超えないことは受け取る側で保証する。
// 太陽光は力学エネルギーの散逸ではないため、この上限制限は適用されない。

// ステファン・ボルツマン定数 [W/m²/K⁴]。
export const STEFAN_BOLTZMANN = 5.670374419e-8;

// 抗力により散逸する力学的仕事率 [W/kg]。density は大気密度 [kg/m³]、airspeed は対気速さ [m/s]、
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
// **抗力の散逸量を上限とする。** 相関式は熱流束を局所量だけから算出するため、薄い大気では
// 抗力による散逸エネルギーを上回る熱量を算出しうる(比率は 1/√ρ で増大する)。
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

// 太陽光が正対する面へ当たる放射照度 [W/m²]。radiantIntensity は恒星の放射強度 [W/sr]、sunDist は
// 恒星までの距離 [m]、sunlit は日照率 0..1。
export function sunlightIrradiance(radiantIntensity: number, sunDist: number, sunlit: number): number {
  if (!(sunDist > 0) || sunlit <= 0) return 0;
  return (radiantIntensity / (sunDist * sunDist)) * sunlit;
}

// 太陽光が物体へ入れる比パワー [W/kg]。radiantIntensity は恒星の放射強度 [W/sr]、sunDist は恒星
// までの距離 [m]、sunlit は日照率 0..1、absorbAreaPerMass はそれを受ける面積の比 [m²/kg](吸収率を
// 織り込んだ実効値)。
//
// **空力加熱と異なり、散逸による上限制限は行わない。** 上限制限は抗力により散逸した力学エネルギーとの収支に
// 基づくものであり、太陽光は力学エネルギーの散逸ではない — 入射量そのものが上限となる。
export function solarHeating(
  radiantIntensity: number, sunDist: number, sunlit: number, absorbAreaPerMass: number,
): number {
  return sunlightIrradiance(radiantIntensity, sunDist, sunlit) * absorbAreaPerMass;
}

// 放射で捨てる比パワー [W/kg]。温度が環境温度 envTemp より高ければ正、低ければ負(暖まる)。
// radiatingAreaPerMass は輻射面積の比 [m²/kg]。
//
// dt の間に放出する熱量は、環境温度との平衡に達する量で制限する — 放熱は物体温度を環境
// 温度へ漸近させるのみで、超過させることはできない。この上限に達するのは時間刻みが比熱に対して
// 過大な場合のみだが、制限がないとステップ間で T⁴ の増幅ループが生じ、1ステップで発散する。
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

// 局所的に過熱した部分が平均より高い温度差 deviation [K] を、dt だけ薄めた値 [K]。
// temperature は物体の平均温度、他は radiativeCooling と同じ比量。
//
// 高温部は低温部より放射率が高いため、温度差自体が放射冷却により減衰・消失していく。減衰速度は
// 放射冷却を温度で微分した 4εσ(A/m)T³/c で、これを減衰係数として指数関数的に積分する。
// **線形減算を行ってはならない** — 時間刻みが比熱に対して過大だと符号が反転し、温度差が振動増幅する。
export function stepThermalDeviation(
  deviation: number,
  temperature: number,
  emissivity: number,
  radiatingAreaPerMass: number,
  specificHeat: number,
  dt: number,
): number {
  if (!(specificHeat > 0) || !(dt > 0) || temperature <= 0) return deviation;
  const t3 = temperature * temperature * temperature;
  const rate = (4 * emissivity * STEFAN_BOLTZMANN * radiatingAreaPerMass * t3) / specificHeat;
  return deviation * Math.exp(-rate * dt);
}

// 正味の比パワー netPower [W/kg] で温度を dt だけ進めた値 [K]。
// specificHeat = 0 は熱を蓄えない物体を表し、温度は動かない。
export function stepTemperature(
  temperature: number, netPower: number, specificHeat: number, dt: number,
): number {
  if (!(specificHeat > 0)) return temperature;
  return temperature + (netPower / specificHeat) * dt;
}
