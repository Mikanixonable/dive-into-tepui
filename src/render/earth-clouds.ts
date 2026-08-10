// 地球表面シェーダ内で評価する二層雲。
// 雲用の近接シェルは作らない。地表メッシュ上で低層/高層の密度をサンプルし、
// 雲頂照明と太陽方向に沿った球面投影で地表への影を求める。
import * as THREE from 'three/webgpu';
import {
  clamp,
  dot,
  float,
  max,
  normalize,
  positionLocal,
  sqrt,
  texture as textureNode,
  uniform,
  vec2,
  vec3,
  smoothstep,
} from 'three/tsl';
import {
  CLOUD_LAYER_PARAMETERS,
  EARTH_CLOUD_RADIUS,
  HIGH_CLOUD_ALTITUDE,
  LOW_CLOUD_ALTITUDE,
  CloudLayer,
  cloudPhaseAt,
} from '../physics/earth-clouds';

type TslFloatNode = ReturnType<typeof float>;
type TslVec2Node = ReturnType<typeof vec2>;

export interface EarthCloudNodes {
  readonly lowDensity: TslFloatNode;
  readonly highDensity: TslFloatNode;
  readonly cover: TslFloatNode;
  readonly shadow: TslFloatNode;
  /** 雲頂の直射光 + 環境光。高層雲は低層雲で弱く自己遮蔽する。 */
  readonly topLight: TslFloatNode;
  readonly setTime: (timeSeconds: number) => void;
}

interface CloudPhaseUniforms {
  readonly longitude: ReturnType<typeof uniform>;
  readonly deformation: ReturnType<typeof uniform>;
}

const TWO_PI = Math.PI * 2;

function phaseUniforms(layer: CloudLayer): CloudPhaseUniforms {
  const phase = cloudPhaseAt(0, layer);
  return {
    longitude: uniform(phase.longitudeOffset),
    deformation: uniform(phase.deformationPhase),
  };
}

function sphereUv(direction: ReturnType<typeof vec3>, phase: CloudPhaseUniforms, layer: CloudLayer): TslVec2Node {
  const p = CLOUD_LAYER_PARAMETERS[layer];
  // SphereGeometry のUVと同じ向きにし、経度端はRepeatWrappingで接続する。
  const u0 = direction.z.atan2(direction.x.negate()).div(TWO_PI);
  const v0 = direction.y.clamp(-1, 1).acos().div(Math.PI);
  const latitude = v0.mul(2).sub(1);
  const deformation = latitude.mul(Math.PI * 2 * 2.2)
    .add(phase.deformation)
    .sin()
    .mul(p.deformationAmplitude);
  const u = u0.sub(0.5).mul(p.longitudinalScale).add(0.5)
    .add(phase.longitude)
    .fract();
  const v = latitude.mul(p.latitudinalScale).mul(0.5).add(0.5).add(deformation).clamp(0, 1);
  return vec2(u, v);
}

function sampleDensity(
  map: THREE.Texture,
  direction: ReturnType<typeof vec3>,
  phase: CloudPhaseUniforms,
  layer: CloudLayer,
): TslFloatNode {
  const sample = textureNode(map, sphereUv(normalize(direction), phase, layer)).r;
  // 8K cloud mapの中間グレーを空として扱い、薄い縁をなだらかに残す。
  return smoothstep(layer === 'low' ? 0.36 : 0.42, layer === 'low' ? 0.68 : 0.74, sample);
}

function projectedCloudDirection(
  surfaceDirection: ReturnType<typeof vec3>,
  sunDirection: ReturnType<typeof vec3>,
  altitude: number,
): ReturnType<typeof vec3> {
  const origin = surfaceDirection.mul(EARTH_CLOUD_RADIUS);
  const b = dot(origin, sunDirection);
  const cloudRadius = EARTH_CLOUD_RADIUS + altitude;
  const discriminant = b.mul(b).add(cloudRadius * cloudRadius - EARTH_CLOUD_RADIUS * EARTH_CLOUD_RADIUS);
  const distance = b.negate().add(sqrt(max(discriminant, 0)));
  return normalize(origin.add(sunDirection.mul(distance)));
}

/** 地球 surface mesh のローカル太陽方向を受け取る。 */
export function createEarthCloudNodes(
  cloudsMap: THREE.Texture,
  cloudSunDirection: ReturnType<typeof uniform>,
): EarthCloudNodes {
  // 経度はRepeatWrappingで連続にする。緯度側はclampするため極域で縁を複製しない。
  cloudsMap.wrapS = THREE.RepeatWrapping;
  cloudsMap.wrapT = THREE.ClampToEdgeWrapping;
  cloudsMap.anisotropy = Math.max(cloudsMap.anisotropy, 8);

  const lowPhase = phaseUniforms('low');
  const highPhase = phaseUniforms('high');
  const localDirection = normalize(positionLocal);
  const sun = normalize(cloudSunDirection);

  const lowDensity = sampleDensity(cloudsMap, localDirection, lowPhase, 'low');
  const highDensity = sampleDensity(cloudsMap, localDirection, highPhase, 'high');

  // 雲影は「固定UVを横へずらす」のではなく、各地表点から太陽方向へ進み、
  // 低層/高層球と交わった方向の雲密度を読む。これにより太陽高度で影の距離が変わる。
  const lowShadowDirection = projectedCloudDirection(localDirection, sun, LOW_CLOUD_ALTITUDE);
  const highShadowDirection = projectedCloudDirection(localDirection, sun, HIGH_CLOUD_ALTITUDE);
  const lowShadow = sampleDensity(cloudsMap, lowShadowDirection, lowPhase, 'low');
  const highShadow = sampleDensity(cloudsMap, highShadowDirection, highPhase, 'high');
  const shadow = clamp(lowShadow.mul(0.62).add(highShadow.mul(0.42)), 0, 0.84);

  // 低層雲の影を高層雲の直射光へ少しだけ反映する。雲を真っ黒な板にはしない。
  // 雲頂自身の法線で照明する。影投影点を使うと夜側から地球内部を貫通して昼側を
  // 参照してしまう。高度ぶんだけ地平線下の太陽を許し、薄明後は直射を遮る。
  const cloudSunAltitude = dot(localDirection, sun);
  const lowTopLight = float(0.018).add(smoothstep(-0.025, 0.08, cloudSunAltitude).mul(0.982));
  const highTopLight = float(0.024).add(smoothstep(-0.056, 0.08, cloudSunAltitude).mul(0.976))
    .mul(float(1).sub(lowDensity.mul(0.28)));
  const topLight = lowTopLight.mul(0.72).add(highTopLight.mul(0.46));

  // 雲が地表を完全に隠す量。高層雲は薄く、二重合成時の白飛びを避ける。
  const cover = clamp(lowDensity.mul(0.72).add(highDensity.mul(0.46)), 0, 0.9);

  return {
    lowDensity,
    highDensity,
    cover,
    shadow,
    topLight,
    setTime(timeSeconds: number) {
      const low = cloudPhaseAt(timeSeconds, 'low');
      const high = cloudPhaseAt(timeSeconds, 'high');
      lowPhase.longitude.value = low.longitudeOffset;
      lowPhase.deformation.value = low.deformationPhase;
      highPhase.longitude.value = high.longitudeOffset;
      highPhase.deformation.value = high.deformationPhase;
    },
  };
}
