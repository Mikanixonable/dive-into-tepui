// リアル調の地球: 高解像度球 + 実在の地球のテクスチャ、大気は解析的シェーディング。
// 実寸(半径 6371km)。テクスチャは実在の地球の写真 (src/assets/earth.jpg) を使用。
//
// near=2m・24bit 非対数深度バッファでは、地表 +数十〜数百km に浮かぶジオメトリは
// 水平線に近い視線ほど地表との深度差が量子化幅(δz ≈ z²/near/2^24。距離の2乗で
// 悪化する)を下回り z-fighting でちらつく。そこで「高度 ~400km 以下で深度テストされる
// ジオメトリは不透明な地球1枚だけ」という不変条件を維持し、雲は地表マテリアルの
// アルベドに焼き込み、大気の発光(近距離のもや・遠距離のリム光)は視線方向から解析的に
// 計算する(地球本体による遮蔽もレイ・スフィア交差で解析的に判定し、ハードウェア深度
// テストの精度に依存しない)。
import * as THREE from 'three/webgpu';
import { texture as textureNode, mix, uv, vec2, vec3 } from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';
import { SUN_INTENSITY } from '../game/const';
import { markLitOpaque } from './pipeline/lit-layer';

import { Aurora } from './aurora';
import { SPHERE_LOD_LADDER, sphereLodLevel, SphereLodLevel } from './screen-lod';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

// 地表テクスチャは「1 天文単位で照らされた見え方」なので、そこへ届く放射照度と Lambert の
// 1/π を戻して拡散アルベドにする(celestial-surface.ts と同じ換算)。
const ALBEDO_FROM_LIT_COLOR = Math.PI / SUN_INTENSITY;

interface SurfaceMaterial {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly earthMap: THREE.Texture;
  readonly cloudsMap: THREE.Texture;
}

// 地表のアルベド(地表テクスチャ・雲・雲影)だけを持つマテリアルを組む(全LOD段で共有)。
// 陰影・遮蔽・大気はパイプラインの仕事で、ここには入らない。
function buildSurfaceMaterial(): SurfaceMaterial {
  const earthMap = new THREE.TextureLoader().load(earthTextureUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  earthMap.anisotropy = 16;
  
  const cloudsMap = new THREE.TextureLoader().load(cloudsTextureUrl);
  cloudsMap.anisotropy = 16;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });

  const earthSample = textureNode(earthMap, uv());
  // 雲そのものと、雲を太陽方向へずらして参照した地表側の影。
  const cloudAlpha = textureNode(cloudsMap, uv()).r;
  const cloudShadowAlpha = textureNode(cloudsMap, uv().add(vec2(0.001, 0.0))).r;
  const shadowColor = mix(earthSample, earthSample.mul(0.2), cloudShadowAlpha.mul(0.8));
  mat.colorNode = mix(shadowColor, vec3(1, 1, 1), cloudAlpha).mul(ALBEDO_FROM_LIT_COLOR);

  return { material: mat, earthMap, cloudsMap };
}

// LOD段ごとの地表メッシュを、共有マテリアルで一括生成する。
function buildSurfaceMeshes(mat: THREE.MeshStandardNodeMaterial): ReadonlyMap<SphereLodLevel, THREE.Mesh> {
  const meshes = new Map<SphereLodLevel, THREE.Mesh>();
  for (const level of SPHERE_LOD_LADDER) {
    const geo = new THREE.SphereGeometry(R_EARTH, level.widthSegments, level.heightSegments);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    markLitOpaque(mesh);
    meshes.set(level, mesh);
  }
  return meshes;
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  // オーロラのカーテンを出すかどうか。
  setAuroraVisible(visible: boolean): void;
  // 見かけ直径[px]から地表メッシュのLOD段を選び、その段だけを visible にする。
  syncSurfaceLod(apparentDiameterPx: number): void;
  tick(simTime: number): void; // オーロラの明滅アニメーション
  dispose(): void; // group が保持する全 GPU 資源を解放する。
}

// 地表とオーロラをまとめた Earth を組み立てる。
export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const { material: surfaceMaterial, earthMap, cloudsMap } = buildSurfaceMaterial();
  const surfaceMeshes = buildSurfaceMeshes(surfaceMaterial);
  let activeSurfaceLevel: SphereLodLevel | null = null;
  for (const mesh of surfaceMeshes.values()) spin.add(mesh);

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
    // 見かけ直径[px]から地表LOD段を選び、その段のメッシュだけを visible にする。
    syncSurfaceLod(apparentDiameterPx: number) {
      const level = sphereLodLevel(apparentDiameterPx);
      if (level === activeSurfaceLevel) return;
      activeSurfaceLevel = level;
      for (const [meshLevel, mesh] of surfaceMeshes) mesh.visible = meshLevel === level;
    },
    // オーロラの明滅・波打ちを simTime に応じて進める。
    tick(simTime: number) {
      const phase = simTime * 0.02;
      for (const a of auroras) a.sync(phase);
    },
    // 地表LOD各段・地表マテリアルとその2枚のテクスチャ・オーロラ4層を解放する。
    dispose() {
      group.removeFromParent();
      for (const mesh of surfaceMeshes.values()) mesh.geometry.dispose();
      surfaceMaterial.dispose();
      earthMap.dispose();
      cloudsMap.dispose();
      for (const a of auroras) a.dispose();
    },
  };
}
