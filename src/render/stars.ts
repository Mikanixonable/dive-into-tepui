// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';

const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない
const SUN_DISTANCE = 4.2e7;

export function createStars(count = 2200): THREE.Mesh {
  const positions = new Float32Array(count * 9);
  const colors = new Float32Array(count * 9);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // 一様な球面分布
    const z = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    const dir = new THREE.Vector3(s * Math.cos(phi), s * Math.sin(phi), z);
    const center = dir.clone().multiplyScalar(STAR_SHELL_RADIUS);

    // 接平面内の正三角形
    const t1 = new THREE.Vector3(0, 1, 0).cross(dir);
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = dir.clone().cross(t1).normalize();
    const rot = Math.random() * Math.PI * 2;
    const a1 = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot));
    const a2 = dir.clone().cross(a1).normalize();

    const size = (0.5 + Math.pow(Math.random(), 2.5) * 2.0) * 5e4;
    const v0 = center.clone().addScaledVector(a1, size);
    const v1 = center.clone().addScaledVector(a1, -0.5 * size).addScaledVector(a2, 0.87 * size);
    const v2 = center.clone().addScaledVector(a1, -0.5 * size).addScaledVector(a2, -0.87 * size);

    positions.set([v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z], i * 9);

    // 白〜青〜暖色の色温度バリエーション
    const temp = Math.random();
    const bright = 0.35 + Math.pow(Math.random(), 2) * 0.65;
    if (temp < 0.2) c.setRGB(0.72, 0.82, 1.0);
    else if (temp < 0.85) c.setRGB(1.0, 1.0, 1.0);
    else c.setRGB(1.0, 0.85, 0.65);
    c.multiplyScalar(bright);
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], i * 9 + k * 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true, // 加算合成を有効化するため明示
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide, // 三角形の向きはランダムなので両面描画
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export function makeGlowTexture(size = 128): THREE.CanvasTexture {
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
  return new THREE.CanvasTexture(canvas);
}

export interface Sun {
  mesh: THREE.Mesh;
  dir: THREE.Vector3; // ワールド(ECI)での太陽方向(単位)
}

export function createSun(glow: THREE.Texture): Sun {
  const dir = new THREE.Vector3(0.82, 0.28, 0.5).normalize();
  const mat = new THREE.MeshBasicMaterial({
    map: glow,
    color: 0xfff3d0,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // 実太陽の視直径(約0.53°)よりやや大きめ + ハロー
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4e6, 2.4e6), mat);
  mesh.position.copy(dir).multiplyScalar(SUN_DISTANCE);
  mesh.frustumCulled = false;
  mesh.renderOrder = -9;
  return { mesh, dir };
}
