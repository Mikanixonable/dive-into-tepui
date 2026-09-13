// 星野の背景。WebGPU のポイントプリミティブは 1px 固定のため、星は小さな三角形をまとめた
// 単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { DeferredTexture } from './deferred-texture';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

// 星野・天球グリッドを置く殻の半径 [m]。殻は視点中心なので、半径を拡げても見え方は変わらない。
export const CELESTIAL_SHELL_RADIUS = 1.35e10;

// 星殻・天球グリッドへ掛ける倍率。far は視距離に連動して毎フレーム変わるので、
// 殻の拡大率はそこから独立させる。
export const CELESTIAL_SHELL_SCALE = CELESTIAL_SHELL_RADIUS / STAR_SHELL_RADIUS;

// 露出に順応しない表示物へ掛ける明るさ係数の供給元。照明がこのフレームの露出を確定させた後に
// 読むと、そのフレームの値になる。
export interface FixedBrightness {
  readonly fixedBrightnessScale: number;
}

export interface Stars {
  readonly mesh: THREE.Mesh;
  // このフレームの星野へ合わせる。同じフレームの照明の sync を済ませてから呼ぶ。
  sync(visible: boolean): void;
  dispose(): void;
}

// 星空の球殻メッシュを構築する。brightness はこの殻へ掛ける明るさ係数の供給元。
export function createStars(brightness: FixedBrightness): Stars {
  const geo = new THREE.SphereGeometry(STAR_SHELL_RADIUS, 64, 64);
  const texture = new DeferredTexture(starsTextureUrl, THREE.SRGBColorSpace);
  texture.request();

  const mat = new THREE.MeshBasicMaterial({
    map: texture.texture,
    side: THREE.BackSide,
    depthWrite: false,
    // 殻がカメラから 0.9*far の距離にあり、深度クリア値付近の量子化丸めで LESS テストが
    // 落ちて黒く抜けることがあるため、深度テストを明示的に無効化する。
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  // 視点中心に置かれる殻なので、外接球によるフラスタム判定は常に「視界内」を返し意味を持たない。
  mesh.frustumCulled = false;
  mesh.layers.set(WORLD_BACKGROUND_LAYER);
  // 描画原点(= カメラ)に固定した殻なので、位置と倍率はフレームによらない。
  mesh.scale.setScalar(CELESTIAL_SHELL_SCALE);
  return {
    mesh,
    sync(visible: boolean): void {
      mesh.visible = visible;
      // 順応ぶんを打ち消す倍率を材質色へ掛ける。星殻は実写写真をそのまま貼ったもので物理的な
      // 輝度の目盛りに載っていないため、どこから見ても同じ明るさで写らなければならない。
      mat.color.setScalar(brightness.fixedBrightnessScale);
    },
    // ジオメトリ・マテリアル・テクスチャを解放する。mesh をシーンから外すのは呼び出し側。
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}
