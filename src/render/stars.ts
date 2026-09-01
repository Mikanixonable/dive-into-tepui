// 星野の背景。WebGPU のポイントプリミティブは 1px 固定のため、星は小さな三角形をまとめた
// 単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

// 広範囲視点で星野・天球グリッドを置く殻の半径 [m]。マップカメラの near もこの殻に収まるよう
// 決まる。
export const CELESTIAL_SHELL_RADIUS = 1.35e10;

// 星殻・天球グリッドへ掛ける倍率。広範囲視点では CELESTIAL_SHELL_RADIUS まで拡げる
// (far は視距離に連動して毎フレーム変わるので、殻の拡大率はそこから独立させる)。
export function celestialShellScale(overviewMode: boolean): number {
  return overviewMode ? CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS : 1.0;
}

export interface Stars {
  readonly mesh: THREE.Mesh;
  // 順応ぶんを打ち消す倍率を材質色へ掛ける。星殻は実写写真をそのまま貼ったもので物理的な
  // 輝度の目盛りに載っていないため、どこから見ても同じ明るさで写らなければならない。
  setFixedBrightnessScale(scale: number): void;
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
  // CelestialSystem.sync が毎フレーム position をカメラ位置へ合わせる殻なので、
  // 外接球によるフラスタム判定は常に「視界内」を返し意味を持たない。
  mesh.frustumCulled = false;
  mesh.layers.set(WORLD_BACKGROUND_LAYER);
  mesh.renderOrder = -10;
  return {
    mesh,
    setFixedBrightnessScale(scale: number): void {
      mat.color.setScalar(scale);
    },
    // ジオメトリ・マテリアル・テクスチャを解放する。mesh をシーンから外すのは呼び出し側。
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}
