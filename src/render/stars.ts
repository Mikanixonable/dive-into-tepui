// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { Billboard } from './billboard';
import { CelestialSurface } from './celestial-surface';
import { textureOf } from './celestial-textures';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';
import { AU } from '../physics/planet-orbit';
import { R_SUN } from '../physics/solar-system';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない
// 恒星のグローの一辺を実半径の何倍にするか。肉眼で見た太陽は視直径そのものより大きく滲む。
export const STAR_GLOW_SIZE_RATIO = 12.3;

// 太陽面の輝度(render/pipeline/sun-light.ts の単位)。1 天文単位での放射照度 π は太陽円盤が
// 張る立体角 π(R/d)² を通して届くので、面の輝度は (d/R)² になる。5772 K の黒体として
// σT⁴/太陽定数 を計算しても同じ 4.62e4 が出る。
export const SUN_SURFACE_RADIANCE = (AU / R_SUN) ** 2;
// グローの輝度。太陽円盤の放射束を、円盤より広いスプライト面へ広げ直したもの — グローは
// 光を増やす演出ではなく、目やレンズの中で同じ光が滲む現象を表す。
export const SUN_GLOW_RADIANCE = SUN_SURFACE_RADIANCE * Math.PI / (4 * STAR_GLOW_SIZE_RATIO ** 2);

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
  readonly billboard: Billboard;
  readonly mesh: THREE.Mesh;
  dispose(): void;
}

// 月の表面。テクスチャの経度原点がモデルの本初子午線(+Z)と揃うようジオメトリを回す。
export function createMoon(): CelestialSurface {
  const moon = textureOf('moon')!;
  const surface = CelestialSurface.textured(moon.url, moon.albedoScale, 64, 32);
  surface.mesh.geometry.rotateY(-Math.PI / 2);
  return surface;
}

export function createSun(): Sun {
  const billboard = new Billboard(0xfff3d0, -9);
  const mesh = createSunMesh();
  return {
    billboard,
    mesh,
    // billboard とメッシュのジオメトリ・マテリアルを解放する。両方をシーンから外すのは呼び出し側。
    dispose(): void {
      billboard.dispose();
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
