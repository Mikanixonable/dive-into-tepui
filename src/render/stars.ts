// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import moonTextureUrl from '../assets/8k_moon.jpg';

const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない
export const SUN_DISTANCE = 4.2e7; // 太陽ビルボードの表示距離(方向のみ実天体暦に従う)
export const MOON_VIS_DIST = 4.5e7; // 月メッシュの表示距離(角直径は実距離から毎フレーム換算)

export function createStars(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(STAR_SHELL_RADIUS, 64, 64);
  const texture = new THREE.TextureLoader().load(starsTextureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    depthWrite: false,
  });
  
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  
  // 天の北極を+Y(ゲーム内の北極)に合わせるための回転(テクスチャの向き次第で調整)
  // 8k_stars.jpg が equirectangular (緯度経度) で中心が銀河中心などの場合、
  // +Y軸を上にするにはデフォルトのままで良いことが多い
  
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

// 月: 単位球(半径1)を生成し、表示側で位置・スケールを毎フレーム設定する。
// 太陽の DirectionalLight で照らされるので月相(満ち欠け)が自然に出る。
export function createMoon(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 64, 32);
  geo.rotateY(-Math.PI / 2);
  const texture = new THREE.TextureLoader().load(moonTextureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  // 地球側に常に同じ面を向ける(自転周期と公転周期が同期している)
  // 今回はゲーム上の座標系(ECI)で特別な自転を与えなくても常に同じ面が見えるか?
  // 常に原点(地球)を向くようにするには毎フレーム lookAt(0,0,0) を呼ぶか、
  // とりあえず初期状態のままとする(元のコードでも固定メッシュ)
  return mesh;
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
