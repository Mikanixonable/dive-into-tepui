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
  mix, vec3, float, uniform, exp,
  positionLocal, positionWorld, cameraPosition,
  modelNormalMatrix,
  dot, normalize, sub, clamp, smoothstep,
} from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';
import { NIGHT_AMBIENT } from './celestial-surface';
import { createEarthSurfaceNodes } from './celestial-material';
import { createEarthAtmosphere } from './earth-atmosphere';
import { createEarthAurora } from './earth-aurora';
import { CelestialQuality } from '../physics/celestial-quality';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

const ATMO_COLOR = vec3(0.36, 0.62, 0.91);
const ATMO_HAZE_TAU0 = 0.34; // 大気のもやの濃さ(視線が真上からのときの光学的厚み)
// リム光の可視上限高度。通常飛行高度(420km)より低く保ち、カメラがリムの
// ジオメトリ内に入らないようにする(内側からだと加算合成が破綻するため)。

type SunDirUniform = ReturnType<typeof uniform>;

// 雲・夕焼け・大気のもやを合成した地表メッシュを組む。
interface EarthSurface {
  readonly mesh: THREE.Mesh;
  readonly setSeasonalTime: (timeSeconds: number) => void;
}

function buildSurface(sunDir: SunDirUniform, cloudSunDir: SunDirUniform): EarthSurface {
  // インデックス付き球ジオメトリ + スムーズシェーディング。
  // 1024×768 分割で高解像度化
  const geo = new THREE.SphereGeometry(R_EARTH, 512, 384);

  const earthMap = new THREE.TextureLoader().load(earthTextureUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  earthMap.anisotropy = 16;
  
  const cloudsMap = new THREE.TextureLoader().load(cloudsTextureUrl);
  cloudsMap.anisotropy = 16;

  // 陰影はシーンのライトではなく sunDir から自分で計算する — 他の天体と同じ規則で、
  // 描画原点がどこにあっても昼夜境界が実際の太陽方向と一致する。
  const mat = new THREE.MeshBasicNodeMaterial();

  const surfaceNodes = createEarthSurfaceNodes(earthMap, cloudsMap, cloudSunDir);
  const earthSample = surfaceNodes.baseColor;
  // MeshBasicNodeMaterialはr169でnormalNodeを照明へ使わないため、地形法線を
  // model normal matrixでworldへ移し、以後の手書きBRDFへ明示的に接続する。
  const shadingNormal = normalize(modelNormalMatrix.mul(surfaceNodes.terrainNormal));

  // 雲影は太陽方向に沿って雲層へ投影した密度から求める。地表の直射光だけを
  // 減衰させ、夜側の最低環境光は残す。
  const cloudGroundTransmission = float(1).sub(surfaceNodes.clouds.shadow.mul(0.82));
  
  // 夕焼けの色 (オレンジ・赤系)
  const sunsetColor = vec3(1.0, 0.4, 0.1);
  const sunDot = dot(shadingNormal, sunDir);
  const sunFactor = clamp(sunDot, 0, 1);
  
  // 大気のもや(aerial perspective): 視線が地平線に近いほど大気中の光路長が
  // 伸びて濃くなる。Beer-Lambert 則で haze = 1 - exp(-tau0 / cosθ)。
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const cosTheta = clamp(dot(shadingNormal, viewDir), 0.05, 1);
  const haze = float(1).sub(exp(float(ATMO_HAZE_TAU0).div(cosTheta).negate()));

  // 雲頂は地表が夜へ入った後も太陽を受ける。太陽と視線が近いときの
  // 粒子前方散乱を簡易HG近似で加え、低い太陽高度の雲頂を消し切らない。
  const forward = clamp(dot(sunDir, viewDir), 0, 1);
  const forwardScatter = float(0.82).add(forward.mul(forward).mul(0.42));
  const cloudColor = vec3(0.86, 0.9, 0.97)
    .mul(surfaceNodes.clouds.topLight.mul(forwardScatter));
  const groundLighting = float(NIGHT_AMBIENT).add(
    sunFactor.mul(cloudGroundTransmission).mul(1 - NIGHT_AMBIENT),
  );
  // 海はSchlick Fresnelと細かな波面法線で太陽のglintを作る。陸は植生の
  // 後方散乱と雪氷の広い鏡面を弱く加え、全材質を同じLambert球にしない。
  const halfDir = normalize(sunDir.add(viewDir));
  const localWave = vec3(
    positionLocal.x.mul(2.1e-5).add(positionLocal.z.mul(1.3e-5)).sin(),
    positionLocal.y.mul(1.7e-5).cos(),
    positionLocal.z.mul(2.4e-5).sub(positionLocal.x.mul(0.9e-5)).sin(),
  ).mul(0.055);
  const worldWave = modelNormalMatrix.mul(localWave);
  const waterNormal = normalize(shadingNormal.add(worldWave.mul(surfaceNodes.oceanMask)));
  const waterNdotV = clamp(dot(waterNormal, viewDir), 0, 1);
  const fresnel = float(0.0204).add(float(0.9796).mul(float(1).sub(waterNdotV).pow(5)));
  const sunGlint = clamp(dot(waterNormal, halfDir), 0, 1).pow(420)
    .mul(sunFactor).mul(7.5);
  const oceanReflection = vec3(0.24, 0.42, 0.72).mul(fresnel.mul(0.6))
    .add(vec3(1.0, 0.91, 0.72).mul(sunGlint));
  const vegetationBackscatter = clamp(dot(viewDir, sunDir), 0, 1).pow(5)
    .mul(surfaceNodes.vegetationMask).mul(0.12);
  const iceSheen = clamp(dot(shadingNormal, halfDir), 0, 1).pow(48)
    .mul(surfaceNodes.iceMask).mul(0.55);
  const directGround = earthSample.mul(groundLighting)
    .add(oceanReflection.mul(surfaceNodes.oceanMask))
    .add(earthSample.mul(vegetationBackscatter))
    .add(vec3(0.75, 0.86, 1.0).mul(iceSheen));
  const baseColor = mix(directGround, cloudColor, surfaceNodes.clouds.cover);
  
  // もやの色 (夕方になると夕焼け色に)
  const dynamicAtmoColor = mix(sunsetColor, ATMO_COLOR, smoothstep(0.0, 0.2, sunDot));
  
  // 地表が夜へ入った後も、高高度を通る光路はしばらく照らされる。
  const twilightVisibility = smoothstep(-0.18, 0.08, sunDot);
  const litColor = mix(baseColor, dynamicAtmoColor, haze.mul(twilightVisibility));
  mat.colorNode = litColor;

  return {
    mesh: new THREE.Mesh(geo, mat as unknown as THREE.Material),
    setSeasonalTime: surfaceNodes.setSeasonalTime,
  };
}


export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  setSunDir(x: number, y: number, z: number): void;
  tick(simTime: number): void; // オーロラの明滅アニメーション、大気シェーダの地球中心uniform更新
  setQuality(quality: CelestialQuality): void;
}

// 地表・オーロラ・大気リム光をまとめた Earth を組み立てる。
export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();

  const sunDir = uniform(new THREE.Vector3(1, 0, 0));
  // 雲サンプルは地球表面のbody-fixed local座標で行うため、worldの太陽方向とは別に
  // 自転の逆変換後の方向を渡す。地表のLambert陰影は従来どおりworld方向を使う。
  const cloudSunDir = uniform(new THREE.Vector3(1, 0, 0));
  const earthCenter = uniform(new THREE.Vector3(0, 0, 0));

  const surface = buildSurface(sunDir, cloudSunDir);
  spin.add(surface.mesh);

  const aurora = createEarthAurora();
  spin.add(aurora.group);
  group.add(spin);

  // 大気リム光(地球中心を基準にした解析シェーディングなので自転させる必要はなく、
  // spin ではなく group 直下に置く)。
  group.add(createEarthAtmosphere(sunDir, earthCenter).mesh);

  let rotationAngle = 0;
  let worldSun = new THREE.Vector3(1, 0, 0);
  const updateCloudSunDir = () => {
    const c = Math.cos(rotationAngle);
    const s = Math.sin(rotationAngle);
    // local = Ry(-rotation) * world
    const localSun = cloudSunDir.value as THREE.Vector3;
    localSun.set(
      c * worldSun.x - s * worldSun.z,
      worldSun.y,
      s * worldSun.x + c * worldSun.z,
    ).normalize();
    aurora.setSunDirection(localSun.x, localSun.y, localSun.z);
  };
  return {
    group,
    // 自転角(ラジアン)を設定する。
    setRotation(angleRad: number) {
      rotationAngle = angleRad;
      spin.rotation.y = angleRad;
      updateCloudSunDir();
    },
    // 太陽方向ベクトルを設定する。
    setSunDir(x: number, y: number, z: number) {
      worldSun = new THREE.Vector3(x, y, z).normalize();
      (sunDir.value as THREE.Vector3).copy(worldSun);
      updateCloudSunDir();
    },
    // 地球中心位置と、オーロラの明滅・波打ちを simTime に応じて進める。
    tick(simTime: number) {
      (earthCenter.value as THREE.Vector3).copy(group.position);

      surface.setSeasonalTime(simTime);
      aurora.tick(simTime);
    },
    setQuality(quality) { aurora.setQuality(quality); },
  };
}
