// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';
import { AU } from '../physics/planet-orbit';
import { R_SUN } from '../physics/solar-system';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

// 太陽面の輝度(render/pipeline/sun-light.ts の単位)。1 天文単位での放射照度 π は太陽円盤が
// 張る立体角 π(R/d)² を通して届くので、面の輝度は (d/R)² になる。5772 K の黒体として
// σT⁴/太陽定数 を計算しても同じ 4.62e4 が出る。
export const SUN_SURFACE_RADIANCE = (AU / R_SUN) ** 2;

export interface Stars {
  readonly mesh: THREE.Mesh;
  dispose(): void;
}

// 星空の球殻メッシュを構築する。
export function createStars(): Stars {
  const geo = new THREE.SphereGeometry(STAR_SHELL_RADIUS, 64, 64);
  const texture = new THREE.TextureLoader().load(starsTextureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    depthWrite: false,
    // renderOrder -10 で最初に描くため深度テストは元々不要。殻がカメラから
    // 0.9*far の距離にあり、深度クリア値付近の量子化丸めで LESS テストが
    // 落ちて黒く抜けることがあるため明示的に無効化する。
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  // EnvironmentScene.sync が毎フレーム position をカメラ位置へ合わせる殻なので、
  // 外接球によるフラスタム判定は常に「視界内」を返し意味を持たない。
  mesh.frustumCulled = false;
  mesh.layers.set(WORLD_BACKGROUND_LAYER);
  mesh.renderOrder = -10;
  return {
    mesh,
    // ジオメトリ・マテリアル・テクスチャを解放する。mesh をシーンから外すのは呼び出し側。
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}

export interface Sun {
  readonly mesh: THREE.Mesh;
  dispose(): void;
}

// 太陽本体の球を構築する。単位球なので、実位置・実半径へ置くのは呼び出し側。
export function createSun(): Sun {
  const mesh = createSunMesh();
  return {
    mesh,
    // メッシュのジオメトリ・マテリアルを解放する。シーンから外すのは呼び出し側。
    dispose(): void {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
  };
}

// 単位球(半径1)の太陽本体。自己発光する光源そのものなので、シーンの照明を受けない
// MeshBasicMaterial で塗る。実位置・実半径へ置くのは呼び出し側(sun-view.ts)の仕事。
function createSunMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0xfff3d0).multiplyScalar(SUN_SURFACE_RADIANCE),
  });
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
