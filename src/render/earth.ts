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
import {
  texture as textureNode, mix, uv, vec2, vec3, float, uniform, exp,
  normalWorld, positionWorld, cameraPosition,
  dot, normalize, sub, clamp, smoothstep,
} from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';

import { Aurora } from './aurora';
import { SPHERE_LOD_LADDER, sphereLodLevel, SphereLodLevel } from './screen-lod';
import type { Vec3Uniform } from './tsl-types';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

// 夜側の明るさ(0 で真っ暗)。惑星光・星明かりを表す最低限の底上げ。
const NIGHT_AMBIENT = 0.04;

const ATMO_COLOR = vec3(0.36, 0.62, 0.91);
const ATMO_HAZE_TAU0 = 0.34; // 大気のもやの濃さ(視線が真上からのときの光学的厚み)

interface SurfaceMaterial {
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly earthMap: THREE.Texture;
  readonly cloudsMap: THREE.Texture;
}

// 雲・夕焼け・大気のもやを合成した地表マテリアルを組む(全LOD段で共有)。
function buildSurfaceMaterial(sunDir: Vec3Uniform): SurfaceMaterial {
  const earthMap = new THREE.TextureLoader().load(earthTextureUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  earthMap.anisotropy = 16;
  
  const cloudsMap = new THREE.TextureLoader().load(cloudsTextureUrl);
  cloudsMap.anisotropy = 16;

  // 陰影はシーンのライトではなく sunDir から自分で計算する — 他の天体と同じ規則で、
  // 描画原点がどこにあっても昼夜境界が実際の太陽方向と一致する。
  const mat = new THREE.MeshBasicNodeMaterial();

  const earthSample = textureNode(earthMap, uv());
  
  // 雲と影
  const cloudAlpha = textureNode(cloudsMap, uv()).r;
  const cloudShadowAlpha = textureNode(cloudsMap, uv().add(vec2(0.001, 0.0))).r;
  const shadowColor = mix(earthSample, earthSample.mul(0.2), cloudShadowAlpha.mul(0.8));
  
  // 夕焼けの色 (オレンジ・赤系)
  const sunsetColor = vec3(1.0, 0.4, 0.1);
  const sunDot = dot(normalWorld, sunDir);
  const sunFactor = clamp(sunDot, 0, 1);
  
  // 雲の色 (夕方になると夕焼け色に、夜側では地表と同じ暗さまで落とす)
  const cloudColorLit = mix(sunsetColor, vec3(1, 1, 1), smoothstep(-0.1, 0.2, sunDot));
  const cloudColor = mix(shadowColor, cloudColorLit, sunFactor);
  const baseColor = mix(shadowColor, cloudColor, cloudAlpha);

  // 大気のもや(aerial perspective): 視線が地平線に近いほど大気中の光路長が
  // 伸びて濃くなる。Beer-Lambert 則で haze = 1 - exp(-tau0 / cosθ)。
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const cosTheta = clamp(dot(normalWorld, viewDir), 0.05, 1);
  const haze = float(1).sub(exp(float(ATMO_HAZE_TAU0).div(cosTheta).negate()));
  
  // もやの色 (夕方になると夕焼け色に)
  const dynamicAtmoColor = mix(sunsetColor, ATMO_COLOR, smoothstep(0.0, 0.2, sunDot));
  
  const litColor = mix(baseColor, dynamicAtmoColor, haze.mul(sunFactor));
  mat.colorNode = litColor.mul(float(NIGHT_AMBIENT).add(sunFactor.mul(1 - NIGHT_AMBIENT)));

  return { material: mat, earthMap, cloudsMap };
}

// LOD段ごとの地表メッシュを、共有マテリアルで一括生成する。
function buildSurfaceMeshes(mat: THREE.MeshBasicNodeMaterial): ReadonlyMap<SphereLodLevel, THREE.Mesh> {
  const meshes = new Map<SphereLodLevel, THREE.Mesh>();
  for (const level of SPHERE_LOD_LADDER) {
    const geo = new THREE.SphereGeometry(R_EARTH, level.widthSegments, level.heightSegments);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    meshes.set(level, mesh);
  }
  return meshes;
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  setSunDir(x: number, y: number, z: number): void;
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

  const sunDir = uniform(new THREE.Vector3(1, 0, 0));

  const { material: surfaceMaterial, earthMap, cloudsMap } = buildSurfaceMaterial(sunDir);
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
    // 太陽方向ベクトルを設定する。
    setSunDir(x: number, y: number, z: number) {
      sunDir.value.set(x, y, z);
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
