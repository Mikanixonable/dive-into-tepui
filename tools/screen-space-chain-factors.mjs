// 手順8-15の帯座標の式の表示。tier の bandFactors は 8-15 で切り替えの口を閉じる前の記録にだけ残り、古い run のラベルを
// 出すために読む。
export const TIER_FACTORS_FIELD = 'bandFactors';

// src の走査に固定で入っている因子(band-split.ts の SENDER_VIEW_EXPONENT と receiverViewMultiplier の写し)。撮影の条件の
// fixedFactors に記録する。components は掛かる成分。
// 因子 d: 送り手の法線と送り手→カメラの内積 n_s·v_s の exponent 乗で割る。
// 因子 c: 受け手の法線と受け手→カメラの内積 cos ε の exponent 乗を、弱めずに掛ける。
export const FIXED_FACTORS = {
  senderView: { exponent: 0.5, components: ['bounce', 'occlusion'] },
  receiverView: { exponent: 1, components: ['bounce', 'occlusion'] },
};

const SIDES = [['bounce', '照り返し'], ['occlusion', '遮蔽']];

const numberText = (value) => String(Number(value.toFixed(3)));

// 掛ける因子(a、旧い記録の c)。s = 1 は cos、s = 1/2 は (1 + cos)/2、それ以外は (1 − s) + s·cos。0 は因子なし。
function multiplierText(s, cosine) {
  if (!(s > 0)) return null;
  if (s === 1) return cosine;
  if (s === 0.5) return `(1+${cosine})/2`;
  return `(${numberText(1 - s)}+${numberText(s)}${cosine})`;
}

// 掛ける因子 a = (1 − s) + s·(cos θ)^p。p = 1・s < 1 はオフセット o = (1 − s)/s の形 (cos θ + o)/(1 + o)。
// o は 1/2・3/4・1 なら分数(1 は (1+cos θ)/2)、それ以外は小数 3 桁。s = 1・p ≠ 1 は冪の形。
function senderFacingText(s, p) {
  if (!(s > 0)) return null;
  const cosine = 'cos θ';
  if (p === 1) {
    if (s === 1) return cosine;
    const o = (1 - s) / s;
    const fraction = [[0.5, '1/2', '(3/2)'], [0.75, '3/4', '(7/4)'], [1, null, null]].find(([value]) => Math.abs(o - value) < 1e-3);
    if (fraction === undefined) return `(${cosine}+${numberText(o)})/${numberText(1 + o)}`;
    return fraction[1] === null ? `(1+${cosine})/2` : `(${cosine}+${fraction[1]})/${fraction[2]}`;
  }
  const power = p === 0.5 ? '√cos θ' : `(${cosine})^${numberText(p)}`;
  return s === 1 ? power : `(${numberText(1 - s)}+${numberText(s)}${power})`;
}

// 割る因子(b・d)。s = 1 は cos、s = 1/2 は √、それ以外は cos^s。0 は因子なし。
function divisorText(s, cosine, product = false) {
  if (!(s > 0)) return null;
  if (s === 1) return product ? `(${cosine})` : cosine;
  if (s === 0.5) return `√${product ? `(${cosine})` : cosine}`;
  return `${product ? `(${cosine})` : cosine}^${numberText(s)}`;
}

// 旧い記録は bandFactors の senderView(強さ)に、新しい記録は fixedFactors に d を持つ。
function senderViewExponentOf(side, bandFactors, fixedFactors) {
  const fixed = fixedFactors?.senderView;
  if (fixed !== undefined) return fixed.components.includes(side) ? fixed.exponent : 0;
  return bandFactors?.[side]?.senderView ?? 0;
}

// 固定の因子 c の、成分 side での冪。掛かっていなければ 0。
function fixedReceiverViewExponentOf(side, fixedFactors) {
  const fixed = fixedFactors?.receiverView;
  return fixed?.components.includes(side) ? fixed.exponent : 0;
}

// cos ε の冪 p の表記。
function cosEpsilonText(p) {
  return p === 1 ? 'cos ε' : p === 0.5 ? '√cos ε' : `(cos ε)^${numberText(p)}`;
}

// tier の帯座標の式。「照り返し: log₂(0.699ρ·(1+cos ε)/2 ÷ √(n_s·v_s)) / 遮蔽: log₂(0.904ρ·(1+cos ε)/2 ÷ √(n_s·v_s))」。
// a = cos θ(光線と送り手)、b = cos φ(光線と受け手)、c = cos ε(受け手と視線)、d = n_s·v_s。fixedFactors は条件の記録。
export function factorsLabelOf(tier, fixedFactors = undefined) {
  const factors = tier[TIER_FACTORS_FIELD];
  const sideText = ([side, title]) => {
    const kappa = side === 'bounce' ? factors?.bounceScale ?? tier.bandScale : tier.bandScale;
    const strengths = factors?.[side] ?? {};
    const fixedExponent = fixedReceiverViewExponentOf(side, fixedFactors);
    const multipliers = [senderFacingText(strengths.senderFacing, factors?.senderFacingExponent ?? 1),
      fixedExponent > 0 ? cosEpsilonText(fixedExponent)
        : multiplierText(strengths.receiverView, cosEpsilonText(factors?.receiverViewExponent ?? 1))]
      .filter((text) => text !== null);
    const divisors = [divisorText(strengths.receiverFacing, 'cos φ'),
      divisorText(senderViewExponentOf(side, factors, fixedFactors), 'n_s·v_s', true)].filter((text) => text !== null);
    return `${title}: log₂(${[`${numberText(kappa)}ρ`, ...multipliers].join('·')}${divisors.map((text) => ` ÷ ${text}`).join('')})`;
  };
  return SIDES.map(sideText).join(' / ');
}
