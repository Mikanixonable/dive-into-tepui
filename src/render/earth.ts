// リアル調の地球: 高解像度球 + 実在の地球のテクスチャ、大気は解析的シェーディング。
// 実寸(半径 6371km)。テクスチャは実在の地球の写真 (src/assets/earth.jpg) を使用。
//
// 大気(雲を含む)は過去に FrontSide/BackSide の重ねシェルとして描画していたが、
// near=2m・24bit 非対数深度バッファでは、地表 +数十〜数百km に浮かぶジオメトリは
// 水平線に近い視線ほど地表との深度差が量子化幅(δz ≈ z²/near/2^24。距離の2乗で
// 悪化する)を下回り z-fighting でちらつく。シェルの間隔や枚数をどれだけ増やしても
// この量子化そのものは解決しない。そこで「高度 ~400km 以下で深度テストされる
// ジオメトリは不透明な地球1枚だけ」という不変条件を維持し、雲は地表マテリアルの
// アルベドに焼き込み、大気の発光(近距離のもや・遠距離のリム光)はシェルを使わず
// 視線方向から解析的に計算する(地球本体による遮蔽もレイ・スフィア交差で解析的に
// 判定し、ハードウェア深度テストの精度に依存しない)。
import * as THREE from 'three/webgpu';
import {
  texture as textureNode, mix, uv, vec2, vec3, float, uniform, exp,
  normalWorld, positionWorld, cameraPosition,
  dot, max, sqrt, select, and, greaterThan, lessThan, normalize, length, sub, clamp, smoothstep,
} from 'three/tsl';
import { R_EARTH } from '../physics/orbital';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

const ATMO_COLOR = vec3(0.36, 0.62, 0.91);
// 大気のもやの濃さ(視線が真上からのときの光学的厚み)。旧・重ねシェル16枚の
// 合計不透明度(≈0.3)に見た目を合わせた値。
const ATMO_HAZE_TAU0 = 0.34;
// リム光の可視上限高度。通常飛行高度(420km)より低く保ち、カメラがリムの
// ジオメトリ内に入らないようにする(内側からだと加算合成が破綻するため)。
const ATMO_RIM_MAX_H = 340e3;
const ATMO_RIM_MIN_H = 20e3;
const ATMO_RIM_SCALE_H = 90e3;

type SunDirUniform = ReturnType<typeof uniform>;
type EarthCenterUniform = ReturnType<typeof uniform>;

function buildSurface(sunDir: SunDirUniform): THREE.Mesh {
  // インデックス付き球ジオメトリ + スムーズシェーディング。
  // 1024×768 分割で高解像度化
  const geo = new THREE.SphereGeometry(R_EARTH, 1024, 768);

  const earthMap = new THREE.TextureLoader().load(earthTextureUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  earthMap.anisotropy = 16;
  
  const cloudsMap = new THREE.TextureLoader().load(cloudsTextureUrl);
  cloudsMap.anisotropy = 16;

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.62, // 海面の太陽ハイライトがうっすら出る程度
    metalness: 0.05,
  });

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
  
  mat.colorNode = mix(baseColor, dynamicAtmoColor, haze.mul(sunFactor));

  return new THREE.Mesh(geo, mat as unknown as THREE.Material);
}

// 大気のリム光: 地球の縁だけをリング状に光らせる加算合成の1枚シェル。
// 地球本体による遮蔽はハードウェア深度テストに頼らず、レイ・スフィア交差で
// 解析的に判定する(fp32 の相対誤差は地球規模のスケールでも数m程度に収まり、
// 24bit 深度バッファのような距離依存の量子化崩れが原理的に起こらない)。
function buildAtmoRim(sunDir: SunDirUniform, earthCenter: EarthCenterUniform): THREE.Mesh {
  const geo = new THREE.SphereGeometry(R_EARTH + ATMO_RIM_MAX_H, 96, 64);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
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

  const mesh = new THREE.Mesh(geo, mat as unknown as THREE.Material);
  mesh.renderOrder = 2;
  return mesh;
}

// オーロラカーテン: 磁気(≒地理)極を囲む緯度 ~67° の波打つリング帯。
// 下端は緑、上端は赤へフェードする。
function buildAurora(sign: 1 | -1, seed: number) {
  const SEG = 160;
  const positions = new Float32Array((SEG + 1) * 2 * 3);
  const colors = new Float32Array((SEG + 1) * 2 * 3);
  const indices: number[] = [];

  const update = (phase: number) => {
    const sPhase = seed + phase; // 位相をずらして波打たせる
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * Math.PI * 2;
      // 緯度・高さをノイズ的に波打たせる(閉ループになるよう周期関数のみ)
      const latDeg =
        66 + 4.5 * Math.sin(3 * th + sPhase) + 2.2 * Math.sin(7 * th + sPhase * 2.3) + 1.1 * Math.sin(13 * th - phase);
      const lat = ((latDeg * Math.PI) / 180) * sign;
      const hTop = 480e3 + 180e3 * Math.sin(2 * th + sPhase * 1.7) + 80e3 * Math.sin(5 * th - phase * 0.8);
      const cl = Math.cos(lat);
      const dirX = cl * Math.cos(th);
      const dirY = Math.sin(lat);
      const dirZ = cl * Math.sin(th);
      const rBot = R_EARTH + 95e3;
      const rTop = R_EARTH + 95e3 + hTop;
      const iBot = i * 2 * 3;
      positions.set([dirX * rBot, dirY * rBot, dirZ * rBot], iBot);
      positions.set([dirX * rTop, dirY * rTop, dirZ * rTop], iBot + 3);
      const flick = 0.75 + 0.25 * Math.sin(9 * th + sPhase * 3.1);
      colors.set([0.1 * flick, 0.85 * flick, 0.45 * flick], iBot); // 下端: 緑
      colors.set([0.8 * flick, 0.1 * flick, 0.2 * flick], iBot + 3); // 上端: 赤
    }
  };

  update(0);
  for (let i = 0; i <= SEG; i++) {
    if (i < SEG) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return { mesh, update, geo };
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  setSunDir(x: number, y: number, z: number): void;
  tick(dt: number): void; // オーロラの明滅アニメーション、大気シェーダの地球中心uniform更新
}

export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const sunDir = uniform(new THREE.Vector3(1, 0, 0));
  const earthCenter = uniform(new THREE.Vector3(0, 0, 0));

  spin.add(buildSurface(sunDir));

  // オーロラは磁気極に固定なので自転と一緒に回す
  const auroras = [buildAurora(1, 1.3), buildAurora(-1, 4.1)];
  for (const a of auroras) spin.add(a.mesh);
  group.add(spin);

  // 大気リム光(地球中心を基準にした解析シェーディングなので自転させる必要はなく、
  // spin ではなく group 直下に置く)。
  group.add(buildAtmoRim(sunDir, earthCenter));

  let auroraPhase = 0;
  return {
    group,
    setRotation(angleRad: number) {
      spin.rotation.y = angleRad;
    },
    setSunDir(x: number, y: number, z: number) {
      (sunDir.value as THREE.Vector3).set(x, y, z);
    },
    tick(dt: number) {
      (earthCenter.value as THREE.Vector3).copy(group.position);

      // ゆっくりした明滅と波打ちアニメーション(実時間ベース)
      auroraPhase += dt;
      for (let i = 0; i < auroras.length; i++) {
        const a = auroras[i]!;
        // 頂点と色を更新して波打たせる
        a.update(auroraPhase * 0.2); // 位相の進行速度
        a.geo.attributes.position!.needsUpdate = true;
        a.geo.attributes.color!.needsUpdate = true;

        const m = a.mesh.material as THREE.MeshBasicMaterial;
        m.opacity = 0.45 + 0.2 * Math.sin(auroraPhase * 0.7 + i * 2.1) * Math.sin(auroraPhase * 0.23 + i);
      }
    },
  };
}
