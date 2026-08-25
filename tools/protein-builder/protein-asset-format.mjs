// タンパク質アセットの整形出力。キーと小さなメタデータ配列は1行ずつ保って差分を読めるようにし、
// 座標や添字のような大きな配列は1行へ畳む。閾値の 32 はその区別を与えるだけの値である。
const INLINE_ARRAY_LENGTH_THRESHOLD = 32;

function isInlinablePrimitive(value) {
  return value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}

function shouldInlineArray(value) {
  return Array.isArray(value) && value.length > INLINE_ARRAY_LENGTH_THRESHOLD && value.every(isInlinablePrimitive);
}

function serializeValue(value, indent) {
  if (shouldInlineArray(value)) return `[${value.map((element) => JSON.stringify(element)).join(',')}]`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const innerIndent = `${indent}  `;
    const items = value.map((element) => `${innerIndent}${serializeValue(element, innerIndent)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const innerIndent = `${indent}  `;
    const items = keys.map((key) => `${innerIndent}${JSON.stringify(key)}: ${serializeValue(value[key], innerIndent)}`);
    return `{\n${items.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

export function serializeProteinAsset(value) {
  return `${serializeValue(value, '')}\n`;
}
