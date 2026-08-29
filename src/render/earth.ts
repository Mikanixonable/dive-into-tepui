// リアル調の地球: 実寸(半径 6371km)の高解像度球へ実写テクスチャを貼った地表と、
// 磁極を囲むオーロラ。雲は別のシェルとしてではなく地表のアルベドへ焼き込む — 高度
// 数十〜数百km に浮かぶジオメトリは、水平線に近い視線では地表との深度差が量子化幅を
// 下回ってちらつくため。
import * as THREE from 'three/webgpu';
import { texture as textureNode, mix, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { FloatUniform } from './tsl-types';
import { shapeAxes } from '../physics/celestial-body-def';
import { EARTH } from '../physics/solar-system/earth-system';
import { R_EARTH_EQ } from '../physics/solar-system/constants';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

// 地球は地表・雲・雲影を1つのアルベドへ合成するので、テクスチャ2枚と合成後の倍率を
// 1組で持つ。平均輝度 0.3104 は合成後の式で測った値で、A_B=0.306 との比が倍率。
// averageHue も合成後の式で測った色み(Rec.709 輝度 1 の線形 RGB)。
export const EARTH_TEXTURES = {
  surfaceUrl: earthTextureUrl,
  cloudsUrl: cloudsTextureUrl,
  albedoScale: 0.9858,
  bondAlbedo: 0.306,
  averageHue: [0.9695, 0.9937, 1.1519],
} as const;
import { CelestialSurface } from './celestial-surface';
import { BodyGraticule } from './body-graticule';
import { EarthCoastline } from './earth-coastline';

import { Aurora } from './aurora';

interface SurfaceMaterial {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly earthMap: THREE.Texture;
  readonly cloudsMap: THREE.Texture;
  // 雲と雲影の濃さに掛かる 0..1。0 で雲の無い地表になる。
  readonly cloudAmount: FloatUniform;
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

  const cloudAmount = uniform(1);
  const earthSample = textureNode(earthMap, uv());
  // 雲そのものと、雲を太陽方向へずらして参照した地表側の影。
  const cloudAlpha = textureNode(cloudsMap, uv()).r.mul(cloudAmount);
  const cloudShadowAlpha = textureNode(cloudsMap, uv().add(vec2(0.001, 0.0))).r.mul(cloudAmount);
  const shadowColor = mix(earthSample, earthSample.mul(0.2), cloudShadowAlpha.mul(0.8));
  mat.colorNode = mix(shadowColor, vec3(1, 1, 1), cloudAlpha).mul(EARTH_TEXTURES.albedoScale);

  return { material: mat, earthMap, cloudsMap, cloudAmount };
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  // 経緯度グリッドを出すかどうか。
  setGraticuleVisible(visible: boolean): void;
  // 海岸線(模式図スタイル用)を出すかどうか。
  setCoastlineVisible(visible: boolean): void;
  // オーロラのカーテンを出すかどうか。
  setAuroraVisible(visible: boolean): void;
  // 地表へ合成する雲と、雲が地表へ落とす影を出すかどうか。
  setCloudsVisible(visible: boolean): void;
  // 見かけ直径[px]に応じた地表メッシュのLOD段を選ぶ。
  syncSurfaceLod(apparentDiameterPx: number): void;
  tick(simTime: number): void; // オーロラの明滅アニメーション
  dispose(): void; // group が保持する全 GPU 資源を解放する。
}

// 地表とオーロラをまとめた Earth を組み立てる。
export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const { material: surfaceMaterial, earthMap, cloudsMap, cloudAmount } = buildSurfaceMaterial();
  const surface = CelestialSurface.withMaterial(surfaceMaterial);
  // 実半径への拡大は地表だけへ掛ける — オーロラは実寸 [m] の頂点を持つので、spin ごと
  // 拡大すると地球半径倍に膨らむ。他の惑星と同じ shapeAxes 経由で扁平を反映する。
  const surfaceScale = new THREE.Group();
  const axes = shapeAxes(R_EARTH_EQ, EARTH.shape);
  surfaceScale.scale.set(axes.x, axes.y, axes.z);
  surface.addTo(surfaceScale);
  const graticule = new BodyGraticule();
  graticule.addTo(surfaceScale);
  const coastline = new EarthCoastline();
  coastline.addTo(surfaceScale);
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
    setGraticuleVisible(visible: boolean) {
      graticule.setVisible(visible);
    },
    setCoastlineVisible(visible: boolean) {
      coastline.setVisible(visible);
    },
    setAuroraVisible(visible: boolean) {
      for (const a of auroras) a.mesh.visible = visible;
    },
    setCloudsVisible(visible: boolean) {
      cloudAmount.value = visible ? 1 : 0;
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
      graticule.dispose();
      coastline.dispose();
      earthMap.dispose();
      cloudsMap.dispose();
      for (const a of auroras) a.dispose();
    },
  };
}
