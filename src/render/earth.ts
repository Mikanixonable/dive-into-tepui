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
  dot, max, sqrt, select, and, greaterThan, lessThan, normalize, length, sub, clamp, smoothstep,
} from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';
import { NIGHT_AMBIENT } from './celestial-surface';
import { Aurora } from './aurora';
import { SPHERE_LOD_LADDER, sphereLodLevel, SphereLodLevel } from './screen-lod';
import type { Vec3Uniform } from './tsl-types';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

const ATMO_COLOR = vec3(0.36, 0.62, 0.91);
const ATMO_HAZE_TAU0 = 0.34; // 大気のもやの濃さ(視線が真上からのときの光学的厚み)
// リム光の可視上限高度。通常飛行高度(420km)より低く保ち、カメラがリムの
// ジオメトリ内に入らないようにする(内側からだと加算合成が破綻するため)。
const ATMO_RIM_MAX_H = 340e3;
const ATMO_RIM_MIN_H = 20e3;
const ATMO_RIM_SCALE_H = 90e3;

// 雲・夕焼け・大気のもやを合成した地表マテリアルを組む(全LOD段で共有)。
function buildSurfaceMaterial(sunDir: Vec3Uniform): THREE.MeshBasicNodeMaterial {
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
  
  // 雲の色 (夕方になると夕焼け色に)
  const cloudColor = mix(sunsetColor, vec3(1, 1, 1), smoothstep(-0.1, 0.2, sunDot));
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

  return mat;
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

// 大気のリム光: 地球の縁だけをリング状に光らせる加算合成の1枚シェル。
// 地球本体による遮蔽はハードウェア深度テストに頼らず、レイ・スフィア交差で
// 解析的に判定する(fp32 の相対誤差は地球規模のスケールでも数m程度に収まり、
// 24bit 深度バッファのような距離依存の量子化崩れが原理的に起こらない)。
function buildAtmoRim(sunDir: Vec3Uniform, earthCenter: Vec3Uniform): THREE.Mesh {
  const geo = new THREE.SphereGeometry(R_EARTH + ATMO_RIM_MAX_H, 96, 64);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // 遮蔽は上の occluded で解析的に判定済み(ハードウェア深度テストは不要)
    side: THREE.BackSide,
  });

  const rEarth = float(R_EARTH);
  const viewDir = normalize(sub(positionWorld, cameraPosition));
  const oc = sub(cameraPosition, earthCenter);
  const b = dot(oc, viewDir);
  const cTerm = sub(dot(oc, oc), rEarth.mul(rEarth));
  const disc = sub(b.mul(b), cTerm);
  const tNear = sub(b.negate(), sqrt(max(disc, 0)));
  const distToFrag = length(sub(positionWorld, cameraPosition));
  // 1km のマージンを持たせ、交点がフラグメントよりわずかに手前でも解析的に
  // 「遮蔽なし」寄りに倒す(浮動小数点誤差でリムの縁が欠けるのを防ぐ)。
  const occluded = and(greaterThan(disc, 0), and(greaterThan(tNear, 0), lessThan(tNear, sub(distToFrag, 1e3))));
  const visible = select(occluded, float(0), float(1));

  const rFrag = length(sub(positionWorld, earthCenter));
  const excess = max(sub(rFrag, rEarth.add(ATMO_RIM_MIN_H)), 0);
  const falloff = exp(excess.div(-ATMO_RIM_SCALE_H));
  const sunDot = dot(normalWorld, sunDir);
  const sunFactor = clamp(sunDot, 0, 1);

  const sunsetColor = vec3(1.0, 0.4, 0.1);
  const dynamicAtmoColor = mix(sunsetColor, ATMO_COLOR, smoothstep(0.0, 0.2, sunDot));

  mat.colorNode = dynamicAtmoColor;
  mat.opacityNode = falloff.mul(sunFactor).mul(visible).mul(0.6);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  setSunDir(x: number, y: number, z: number): void;
  // 見かけ直径[px]から地表メッシュのLOD段を選び、その段だけを visible にする。
  syncSurfaceLod(apparentDiameterPx: number): void;
  tick(simTime: number): void; // オーロラの明滅アニメーション、大気シェーダの地球中心uniform更新
}

// 地表・オーロラ・大気リム光をまとめた Earth を組み立てる。
export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const sunDir = uniform(new THREE.Vector3(1, 0, 0));
  const earthCenter = uniform(new THREE.Vector3(0, 0, 0));

  const surfaceMeshes = buildSurfaceMeshes(buildSurfaceMaterial(sunDir));
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

  // 大気リム光(地球中心を基準にした解析シェーディングなので自転させる必要はなく、
  // spin ではなく group 直下に置く)。
  group.add(buildAtmoRim(sunDir, earthCenter));

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
    // 見かけ直径[px]から地表LOD段を選び、その段のメッシュだけを visible にする。
    syncSurfaceLod(apparentDiameterPx: number) {
      const level = sphereLodLevel(apparentDiameterPx);
      if (level === activeSurfaceLevel) return;
      activeSurfaceLevel = level;
      for (const [meshLevel, mesh] of surfaceMeshes) mesh.visible = meshLevel === level;
    },
    // 地球中心位置と、オーロラの明滅・波打ちを simTime に応じて進める。
    tick(simTime: number) {
      earthCenter.value.copy(group.position);

      // シミュレーション時間に連動した位相。
      const phase = simTime * 0.02;
      for (const a of auroras) a.sync(phase);
    },
  };
}
