// 惑星の環の annulus メッシュ。半径は天体半径を 1 とする単位で与え、天体メッシュの子として
// 付けることで表示スケールをそのまま継承する。環は軸対称なので自転位相を持たない。
import * as THREE from 'three/webgpu';

// 環の面が天体の赤道面(モデル座標の +Y が自転軸)に載るように、RingGeometry の
// 法線 +Z を +Y へ倒す角度。
const RING_TILT = -Math.PI / 2;

// 内縁から外縁への放射方向をテクスチャの u 0→1 に対応させる。
function mapRadialUv(geo: THREE.RingGeometry, innerRadius: number, outerRadius: number): void {
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - innerRadius) / (outerRadius - innerRadius), 0.5);
  }
}

// テクスチャ 1 枚に環全体を焼き込んだ環メッシュ。半径は天体半径を 1 とする単位。
export function createTexturedRing(textureUrl: string, innerRadius: number, outerRadius: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1);
  mapRadialUv(geo, innerRadius, outerRadius);
  const texture = new THREE.TextureLoader().load(textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = RING_TILT;
  mesh.frustumCulled = false;
  return mesh;
}

// 単色半透明の細環メッシュ。半径は天体半径を 1 とする単位。
export function createSolidRing(color: number, opacity: number, innerRadius: number, outerRadius: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1);
  const mat = new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = RING_TILT;
  mesh.frustumCulled = false;
  return mesh;
}
