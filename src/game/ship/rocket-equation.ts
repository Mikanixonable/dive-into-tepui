// ロケット方程式に基づく有限燃焼の換算式。推力 F [N]・推進剤の質量流量 ṁ [kg/s]・
// 燃焼前質量 m₀ [kg]・推進剤質量 [kg]・速度変化 Δv [m/s] の間を往復する純関数だけを持つ。

// 有効排気速度 vₑ = F/ṁ [m/s]。流量がなければ Infinity — Δv 換算では「無限の効率」として
// ゼロに潰れる側へ働く。
export function effectiveExhaustVelocity(thrustN: number, consumptionKgPerSec: number): number {
  return consumptionKgPerSec > 0 ? thrustN / consumptionKgPerSec : Infinity;
}

// 一定推力 F のもとで速度変化 deltaV を与える燃焼時間 [s]。
// 消費する推進剤 m_p = m₀(1 − e^(−Δv/vₑ)) を質量流量 ṁ = F/vₑ で割ったもの。
// deltaV ≪ vₑ では m₀·Δv/F(一定加速度の近似)へ縮退する。
export function burnDuration(m0: number, exhaustVel: number, thrustN: number, deltaV: number): number {
  if (!(thrustN > 0) || !(exhaustVel > 0) || !isFinite(exhaustVel) || !(deltaV > 0)) return 0;
  return (m0 * exhaustVel / thrustN) * (1 - Math.exp(-deltaV / exhaustVel));
}

// 燃焼前質量 m₀ と使える推進剤 propellantKg から得られる速度変化の総量 [m/s]。
// vₑ·ln(m₀/(m₀ − m_p))。推進剤が無い・vₑ が決まらないなら 0。
export function deltaVBudget(exhaustVel: number, m0: number, propellantKg: number): number {
  if (!(exhaustVel > 0) || !isFinite(exhaustVel) || propellantKg <= 0) return 0;
  const finalMass = m0 - propellantKg;
  if (!(finalMass > 0)) return 0;
  return exhaustVel * Math.log(m0 / finalMass);
}
