// 星野の背景。視点中心に固定した球殻へ星空を貼り、露出に順応しない明るさで同期する。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { DeferredTexture } from './deferred-texture';
import { POINT_IMAGE_ANGULAR_SIZE } from './billboard';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

// 星野・天球グリッド・点像を置く殻の半径 [m]。殻は視点中心なので、半径を拡げても見え方は変わらない。
export const CELESTIAL_SHELL_RADIUS = 1.35e10;

// 殻の上へ置く点像の板の一辺 [m]。角の広がりへ殻の半径を掛けたもの。
export const POINT_IMAGE_SIZE = POINT_IMAGE_ANGULAR_SIZE * CELESTIAL_SHELL_RADIUS;

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
    // 失敗して黒く欠損することがあるため、深度テストを明示的に無効化する。
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
    // GPU 資源を解放する。mesh 自体のシーングラフからの削除は含まない。
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}
