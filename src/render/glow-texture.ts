import * as THREE from 'three';
// フラッシュ・噴射パフ・太陽ビルボードなど、加算ブレンドで光点を描く各所が共有する
// ソフトグローテクスチャ。呼ぶたびに再生成すると(特に被弾フラッシュのような高頻度発生元で)
// canvas 生成 + GPU アップロードが繰り返されるので、単一インスタンスをキャッシュして使い回す。
let glowTexture: THREE.CanvasTexture | null = null;

export function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}