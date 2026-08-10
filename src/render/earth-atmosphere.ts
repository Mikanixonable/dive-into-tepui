// 地球大気の宇宙視点レンダリング。複数の透明シェルは使わず、単一の外殻上で
// カメラレイの最近接高度から接線柱密度を近似する。地表側の aerial perspective と
// 同じ Rayleigh/Mie 係数を使い、地表から宇宙まで連続した薄明を作る。
import * as THREE from 'three/webgpu';
import {
  and,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  greaterThan,
  length,
  lessThan,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  select,
  smoothstep,
  sqrt,
  sub,
  uniform,
  vec3,
} from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';

// 可視上端。密度は100kmより上でほぼゼロだが、薄い青い接線光を滑らかに消す余白を持つ。
export const EARTH_ATMOSPHERE_TOP = 180e3;

type UniformNode = ReturnType<typeof uniform>;

export interface EarthAtmosphere {
  readonly mesh: THREE.Mesh;
}

export function createEarthAtmosphere(sunDirection: UniformNode, earthCenter: UniformNode): EarthAtmosphere {
  const atmosphereRadius = R_EARTH + EARTH_ATMOSPHERE_TOP;
  const geo = new THREE.SphereGeometry(atmosphereRadius, 128, 80);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });

  const ray = normalize(sub(positionWorld, cameraPosition));
  const cameraFromCenter = sub(cameraPosition, earthCenter);
  const projection = dot(cameraFromCenter, ray);
  const closest = sub(cameraFromCenter, ray.mul(projection));
  const impactRadius = length(closest);
  const tangentHeight = max(impactRadius.sub(R_EARTH), 0);

  // 接線光路の近似。Rayleighは約8km、エアロゾルは約1.2kmのスケールハイト。
  const rayleighDensity = exp(tangentHeight.div(-8e3));
  const mieDensity = exp(tangentHeight.div(-1.2e3));
  const rayleighColumn = rayleighDensity.mul(3.2);
  const mieColumn = mieDensity.mul(0.48);

  const tangentNormal = normalize(closest);
  const sunAltitude = dot(tangentNormal, sunDirection);
  const dayVisibility = smoothstep(-0.22, 0.06, sunAltitude);
  const twilight = smoothstep(-0.24, -0.015, sunAltitude)
    .mul(float(1).sub(smoothstep(-0.015, 0.14, sunAltitude)));

  const viewToCamera = ray.negate();
  const cosScatter = clamp(dot(sunDirection, viewToCamera), -1, 1);
  const cos2 = cosScatter.mul(cosScatter);
  const rayleighPhase = float(0.75).mul(float(1).add(cos2));
  // g=0.76 のHGを定数整理した近似。太陽近傍のMie前方散乱を強める。
  const mieDenominator = float(1.5776).sub(cosScatter.mul(1.52));
  const miePhase = float(0.4224).div(mieDenominator.mul(sqrt(mieDenominator)));

  const betaR = vec3(0.24, 0.48, 1.0);
  const betaM = vec3(1.0, 0.78, 0.58);
  const sunset = vec3(1.0, 0.19, 0.025);
  const scatterColor = betaR.mul(rayleighColumn).mul(rayleighPhase)
    .add(betaM.mul(mieColumn).mul(miePhase));
  const opticalDepth = rayleighColumn.add(mieColumn);
  const alpha = float(1).sub(exp(opticalDepth.negate()))
    .mul(dayVisibility.add(twilight.mul(0.72)))
    .mul(float(1).sub(smoothstep(0, EARTH_ATMOSPHERE_TOP, tangentHeight)));
  const spectralColor = mix(scatterColor, sunset.mul(rayleighColumn.add(mieColumn)), twilight);

  // 地球本体に遮られる外殻の裏側を解析的に除く。
  const b = projection;
  const c = dot(cameraFromCenter, cameraFromCenter).sub(R_EARTH * R_EARTH);
  const discriminant = b.mul(b).sub(c);
  const nearHit = b.negate().sub(sqrt(max(discriminant, 0)));
  const fragmentDistance = length(sub(positionWorld, cameraPosition));
  const occluded = and(
    greaterThan(discriminant, 0),
    and(greaterThan(nearHit, 0), lessThan(nearHit, fragmentDistance.sub(1e3))),
  );
  const visible = select(occluded, float(0), float(1));

  mat.colorNode = spectralColor;
  mat.opacityNode = min(alpha.mul(visible), 0.92);
  const mesh = new THREE.Mesh(geo, mat as unknown as THREE.Material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh };
}
