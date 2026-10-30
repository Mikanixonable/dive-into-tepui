// ロケット式。推力・推進剤消費率・質量から、艦の出せる速度変化(Δv 予算)と有限燃焼の
// 時間を求める純関数群。遷移候補の実現可能性と自動操縦の燃焼時間の両方がここを見る。
// THREE/DOM 非依存。

// 有効排気速度 vₑ = F / ṁ [m/s]。ṁ=0(燃料を消費しない理想化)は数学的に無限大なので
// 呼び出し側が弾く — ここでは 0 を返さず Infinity を返して自然に扱わせる。
export function effectiveExhaustVelocity(thrustN: number, consumptionKgPerSec: number): number {
  if (consumptionKgPerSec <= 0) return Infinity;
  return thrustN / consumptionKgPerSec;
}

// Δv 予算 [m/s]: 質量 m0 の艦が推進剤 propellant を全部使い切ったとき出せる速度変化の総量。
// Δv = vₑ · ln(m₀ / m_dry)、m_dry = m₀ − propellant。
export function deltaVBudget(exhaustVel: number, m0: number, propellantKg: number): number {
  const mDry = m0 - propellantKg;
  if (!(exhaustVel > 0) || mDry <= 0 || propellantKg <= 0) return 0;
  if (!isFinite(exhaustVel)) return Infinity;
  return exhaustVel * Math.log(m0 / mDry);
}

// 有限燃焼時間 [s]: 等速推力で質量が減っていく艦が速度変化 deltaV を出すのに要する時間。
// 加速度 a(t) = F / (m₀ − ṁt) を積分すると Δv = −vₑ ln(1 − ṁΔt/m₀) で、これを Δt へ解くと
// Δt = (m₀ vₑ / F)(1 − e^(−Δv/vₑ))。
// deltaV がその推力・推進剤では出せない場合(必要質量 > m₀)は Infinity を返す。
export function burnDuration(
  m0: number,
  exhaustVel: number,
  thrustN: number,
  deltaV: number,
): number {
  if (!(deltaV > 0)) return 0;
  if (!(thrustN > 0) || !(m0 > 0)) return Infinity;
  if (!isFinite(exhaustVel) || exhaustVel <= 0) return deltaV / (thrustN / m0); // 質量不変の近似
  const exponent = -deltaV / exhaustVel;
  if (exponent < -50) return Infinity; // e^(-Δv/vₑ) → 0: m₀ 全部を使っても届かない
  return (m0 * exhaustVel / thrustN) * (1 - Math.exp(exponent));
}
