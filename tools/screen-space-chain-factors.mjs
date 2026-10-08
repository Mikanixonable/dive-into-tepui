// 手順8-15の帯座標の因子の組(factors)の、setTier へ渡す欄・短い書式の読み取り・読める表示。
// 欄の名前と形は src/ 側の確定待ち。合わせるのはここ(TIER_FACTORS_FIELD と STRENGTH_KEYS)だけでよい。
export const TIER_FACTORS_FIELD = 'bandFactors';

// 短い書式のキー → [成分, 欄の名前]。キーは計画の記号 a〜d(a は照り返しだけ)。
const STRENGTH_KEYS = {
  'b.a': ['bounce', 'senderFacing'], 'b.b': ['bounce', 'receiverFacing'],
  'b.c': ['bounce', 'receiverView'], 'b.d': ['bounce', 'senderView'],
  'o.b': ['occlusion', 'receiverFacing'], 'o.c': ['occlusion', 'receiverView'], 'o.d': ['occlusion', 'senderView'],
};
const SIDES = [['bounce', 'b.', '照り返し'], ['occlusion', 'o.', '遮蔽']];

// "kb=0.6,b.d=1,o.d=1" のような書式から因子の組を作る。書かなかった強さは 0(因子なし)、kb(κ_b)は bandScale(κ_o)。
export function parseFactors(text, bandScale) {
  const factors = { bounceScale: bandScale,
    bounce: { senderFacing: 0, receiverFacing: 0, receiverView: 0, senderView: 0 },
    occlusion: { receiverFacing: 0, receiverView: 0, senderView: 0 } };
  for (const pair of text.split(',')) {
    const [key, valueText] = pair.split('=');
    const value = Number(valueText);
    if (valueText === undefined || valueText === '' || !Number.isFinite(value) || value < 0) throw new Error(`--factors: invalid entry "${pair}"`);
    if (key === 'kb') factors.bounceScale = value;
    else if (STRENGTH_KEYS[key] !== undefined) {
      const [side, name] = STRENGTH_KEYS[key];
      factors[side][name] = value;
    } else throw new Error(`--factors: unknown key "${key}" (kb, ${Object.keys(STRENGTH_KEYS).join(', ')})`);
  }
  return factors;
}

const strengthText = (s) => (s === 0.5 ? '1/2' : String(s));

// tier の因子の組の読める表示。「照り返し: a1/2 d1 κb 0.60 / 遮蔽: なし κo 0.75」。
export function factorsLabelOf(tier) {
  const factors = tier[TIER_FACTORS_FIELD];
  const sideText = ([side, prefix, title]) => {
    const used = Object.entries(STRENGTH_KEYS).filter(([key, [s, name]]) => key.startsWith(prefix) && factors?.[s][name] > 0)
      .map(([key, [s, name]]) => `${key.slice(2)}${strengthText(factors[s][name])}`);
    return `${title}: ${used.length === 0 ? 'なし' : used.join(' ')}`;
  };
  const [bounce, occlusion] = SIDES.map(sideText);
  const kappaB = factors?.bounceScale ?? tier.bandScale;
  return `${bounce} κb ${kappaB.toFixed(2)} / ${occlusion} κo ${tier.bandScale.toFixed(2)}`;
}
