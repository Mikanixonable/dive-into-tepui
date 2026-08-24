// リアル調の地球: 実寸(半径 6371km)の高解像度球へ実写テクスチャを貼った地表と、
// 磁極を囲むオーロラ。雲は別のシェルとしてではなく地表のアルベドへ焼き込む — 高度
// 数十〜数百km に浮かぶジオメトリは、水平線に近い視線では地表との深度差が量子化幅を
// 下回ってちらつくため。
import * as THREE from 'three/webgpu';
import { texture as textureNode, mix, uv, vec2, vec3 } from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';
import { EARTH_TEXTURES } from './celestial-textures';
import { CelestialSurface } from './celestial-surface';

import { Aurora } from './aurora';

interface SurfaceMaterial {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly earthMap: THREE.Texture;
  readonly cloudsMap: THREE.Texture;
}

// 地表のアルベド(地表テクスチャ・雲・雲影)だけを持つマテリアルを組む(全LOD段で共有)。
// 陰影・遮蔽・大気はパイプラインの仕事で、ここには入らない。
function buildSurfaceMaterial(): SurfaceMaterial {
  const earthMap = new THREE.TextureLoader().load(EARTH_TEXTURES.surfaceUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  earthMap.anisotropy = 16;
  
  const cloudsMap = new THREE.TextureLoader().load(EARTH_TEXTURES.cloudsUrl);
  cloudsMap.anisotropy = 16;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });

  const earthSample = textureNode(earthMap, uv());
  // 雲そのものと、雲を太陽方向へずらして参照した地表側の影。
  const cloudAlpha = textureNode(cloudsMap, uv()).r;
  const cloudShadowAlpha = textureNode(cloudsMap, uv().add(vec2(0.001, 0.0))).r;
  const shadowColor = mix(earthSample, earthSample.mul(0.2), cloudShadowAlpha.mul(0.8));
  mat.colorNode = mix(shadowColor, vec3(1, 1, 1), cloudAlpha).mul(EARTH_TEXTURES.albedoScale);

  return { material: mat, earthMap, cloudsMap };
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  // オーロラのカーテンを出すかどうか。
  setAuroraVisible(visible: boolean): void;
  // 見かけ直径[px]に応じた地表メッシュのLOD段を選ぶ。
  syncSurfaceLod(apparentDiameterPx: number): void;
  tick(simTime: number): void; // オーロラの明滅アニメーション
  dispose(): void; // group が保持する全 GPU 資源を解放する。
}

// 地表とオーロラをまとめた Earth を組み立てる。
export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const { material: surfaceMaterial, earthMap, cloudsMap } = buildSurfaceMaterial();
  const surface = CelestialSurface.withMaterial(surfaceMaterial);
  // 実半径への拡大は地表だけへ掛ける — オーロラは実寸 [m] の頂点を持つので、spin ごと
  // 拡大すると地球半径倍に膨らむ。
  const surfaceScale = new THREE.Group();
  surfaceScale.scale.setScalar(R_EARTH);
  surface.addTo(surfaceScale);
  spin.add(surfaceScale);

  // オーロラは磁気極に固定なので自転と一緒に回す
  const auroras = [
    new Aurora(1, 1.3, 1.3, 0, 0, 0),
    new Aurora(1, 1.3, 2.7, 45e3, 1.5, 1),
    new Aurora(-1, 4.1, 4.1, 0, 0, 2),
    new Aurora(-1, 4.1, 5.5, 45e3, 1.5, 3),
  ];
  for (const a of auroras) spin.add(a.mesh);
  group.add(spin);

  return {
    group,
    // 自転角(ラジアン)を設定する。
    setRotation(angleRad: number) {
      spin.rotation.y = angleRad;
    },
    setAuroraVisible(visible: boolean) {
      for (const a of auroras) a.mesh.visible = visible;
    },
    // 見かけ直径[px]から地表LOD段を選ぶ。
    syncSurfaceLod(apparentDiameterPx: number) {
      surface.syncLod(apparentDiameterPx);
    },
    // オーロラの明滅・波打ちを simTime に応じて進める。
    tick(simTime: number) {
      const phase = simTime * 0.02;
      for (const a of auroras) a.sync(phase);
    },
    // 地表とそのマテリアル・2枚のテクスチャ・オーロラ4層を解放する。
    dispose() {
      group.removeFromParent();
      surface.dispose();
      earthMap.dispose();
      cloudsMap.dispose();
      for (const a of auroras) a.dispose();
    },
  };
}
