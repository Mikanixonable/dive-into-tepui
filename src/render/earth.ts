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
// 複数層、グラデーション拡充、途切れ表現を追加。
function buildAurora(sign: 1 | -1, geomSeed: number, colorSeed: number, radiusOffset: number, latOffsetDeg: number) {
  const SEG = 160;
  const V_SEG = 3; // 4 vertices vertically: 0=bottom fade, 1=core green, 2=mid red, 3=top fade
  const positions = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);
  const colors = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);
  const indices: number[] = [];

  const update = (phase: number) => {
    const sPhase = geomSeed + phase;
    const cPhase = colorSeed + phase;
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * Math.PI * 2;
      
      // 緯度・高さをノイズ的に波打たせる(閉ループになるよう周期関数のみ)
      const latDeg = 66 + latOffsetDeg + 4.5 * Math.sin(3 * th + sPhase) + 2.2 * Math.sin(7 * th + sPhase * 2.3);
      const lat = ((latDeg * Math.PI) / 180) * sign;
      const cl = Math.cos(lat);
      const dirX = cl * Math.cos(th);
      const dirY = Math.sin(lat);
      const dirZ = cl * Math.sin(th);
      
      // 途切れや二重を表現するノイズ(強度が低い場所は暗くなる)
      const intensityNode = 0.4 + 0.6 * Math.sin(5 * th + cPhase * 0.8) + 0.4 * Math.sin(11 * th - cPhase * 1.3);
      const intensity = Math.max(0, Math.min(1, intensityNode));
      
      const hTop = 480e3 + 180e3 * Math.sin(2 * th + sPhase * 1.7);
      const alts = [95e3, 120e3, 120e3 + hTop * 0.4, 95e3 + hTop];

      // 時間による色の揺らぎ
      const flick = 0.8 + 0.2 * Math.sin(19 * th + cPhase * 4.1);
      const coreInt = intensity * flick;
      
      // 4層のグラデーション色 (加算合成なので 0 で透明)
      const c0 = [0.0, 0.1 * coreInt, 0.05 * coreInt];
      const c1 = [0.1 * coreInt, 0.9 * coreInt, 0.4 * coreInt];
      const c2 = [0.7 * coreInt, 0.15 * coreInt, 0.2 * coreInt];
      const c3 = [0.1 * coreInt, 0.01 * coreInt, 0.02 * coreInt];
      const colArr = [c0, c1, c2, c3];

      for (let j = 0; j <= V_SEG; j++) {
        const r = R_EARTH + alts[j]! + radiusOffset;
        const idx = (i * (V_SEG + 1) + j) * 3;
        positions.set([dirX * r, dirY * r, dirZ * r], idx);
        colors.set(colArr[j]!, idx);
      }
    }
  };

  update(0);
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < V_SEG; j++) {
      const a = i * (V_SEG + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (V_SEG + 1) + j;
      const d = c + 1;
      indices.push(a, b, c, c, b, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.65, // ベース不透明度(頂点カラーで変調)
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
  tick(dt: number, simTime: number): void; // オーロラの明滅アニメーション、大気シェーダの地球中心uniform更新
}

export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const sunDir = uniform(new THREE.Vector3(1, 0, 0));
  const earthCenter = uniform(new THREE.Vector3(0, 0, 0));

  spin.add(buildSurface(sunDir));

  // オーロラは磁気極に固定なので自転と一緒に回す
  const auroras = [
    buildAurora(1, 1.3, 1.3, 0, 0),
    buildAurora(1, 1.3, 2.7, 45e3, 1.5), // 北極側の2層目(形状は同じgeomSeedで平行にし交差を防ぐ、色・強度は別seed)
    buildAurora(-1, 4.1, 4.1, 0, 0),
    buildAurora(-1, 4.1, 5.5, 45e3, 1.5), // 南極側の2層目
  ];
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
    tick(_dt: number, simTime: number) {
      (earthCenter.value as THREE.Vector3).copy(group.position);

      // シミュレーション時間に連動した位相。
      // 速度を以前の1/10 (x0.02) に減速。
      auroraPhase = simTime * 0.02;
      for (let i = 0; i < auroras.length; i++) {
        const a = auroras[i]!;
        // 頂点と色を更新して波打たせる
        a.update(auroraPhase); // 内部でさらに位相をずらして適用
        a.geo.attributes.position!.needsUpdate = true;
        a.geo.attributes.color!.needsUpdate = true;

        const m = a.mesh.material as THREE.MeshBasicMaterial;
        m.opacity = 0.55 + 0.2 * Math.sin(auroraPhase * 0.7 + i * 2.1) * Math.sin(auroraPhase * 0.23 + i);
      }
    },
  };
}
