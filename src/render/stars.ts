// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import moonTextureUrl from '../assets/8k_moon.jpg';
import { Billboard } from './billboard';
import { CelestialSurface } from './celestial-surface';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

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
  const surface = CelestialSurface.textured(moonTextureUrl, 64, 32);
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
// MeshBasicMaterial で塗る。広範囲視点でのみ実位置・実半径に置いて使う。
function createSunMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshBasicMaterial({ color: 0xfff3d0 });
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
