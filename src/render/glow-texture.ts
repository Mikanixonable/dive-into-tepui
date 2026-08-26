import * as THREE from 'three/webgpu';
// フラッシュ・噴射パフ・太陽ビルボードなど、加算ブレンドで光点を描く各所が共有する
// ソフトグローテクスチャ。呼ぶたびに再生成すると(特に被弾フラッシュのような高頻度発生元で)
// canvas 生成 + GPU アップロードが繰り返されるので、単一インスタンスをキャッシュして使い回す。
let glowTexture: THREE.CanvasTexture | null = null;
// getGlowTexture() が生成のついでに測る、テクスチャ全面の平均不透明度。
let glowAlphaMean = 0;

// グローテクスチャの平均不透明度。加算合成での寄与は「板の面積 × この平均」に比例するので、
// **総光量を決めてから板の明るさを逆算する側**がこれを要る。実際の画素から測るので、
// グラデーションを描き変えても値が付いてくる。
export function glowMeanAlpha(): number {
  getGlowTexture();
  return glowAlphaMean;
}

// キャッシュ済みならそれを返し、なければ生成してキャッシュする。
export function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // 中心が不透明・周辺が透明な放射グラデーションを敷く
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  let alphaSum = 0;
  for (let i = 3; i < pixels.length; i += 4) alphaSum += pixels[i]!;
  glowAlphaMean = alphaSum / (255 * size * size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}