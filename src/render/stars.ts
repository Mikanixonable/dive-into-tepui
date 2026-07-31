// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import moonTextureUrl from '../assets/8k_moon.jpg';
import { Billboard } from './billboard';

const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない
export const SUN_DISTANCE = 4.2e7; // 太陽ビルボードの表示距離(方向のみ実天体暦に従う)
export const MOON_VIS_DIST = 4.5e7; // 月メッシュの表示距離(角直径は実距離から毎フレーム換算)
// 実太陽の視直径(約0.53°)よりやや大きめ + ハロー分
export const SUN_VISUAL_SIZE = 2.4e6;

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

export interface Sun {
  billboard: Billboard;
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
  // 潮汐固定(自転周期 = 公転周期)なので、地球側へ常に同じ面を向ける。その向き付けは
  // 毎フレーム EnvironmentScene.syncSkyBodies が lookAt で行うため、ここでは自転を
  // 与えず向きの定まっていないメッシュを返す。
  return mesh;
}

export function createSun(): Sun {
  return { billboard: new Billboard(0xfff3d0, -9) };
}
