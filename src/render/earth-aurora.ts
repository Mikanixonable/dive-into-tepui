// 地磁気軸を中心とする楕円状オーバル。形状は固定し、細かな発光変動だけをGPUで
// 評価するため、従来の全球頂点・頂点色の毎フレーム書換えを行わない。
import * as THREE from 'three/webgpu';
import { vertexColor, clamp, dot, float, normalize, positionLocal, uniform } from 'three/tsl';
import { R_EARTH } from '../physics/solar-system';
import { CELESTIAL_QUALITY, CelestialQuality } from '../physics/celestial-quality';

export interface EarthAurora {
  readonly group: THREE.Group;
  setSunDirection(x: number, y: number, z: number): void;
  setQuality(quality: CelestialQuality): void;
  tick(displayTime: number): void;
}

const CURTAINS = 6;
const SEGMENTS = 192;
// 近年の地磁気北極に近い固定双極子軸。ゲームの長期年代では厳密IGRFではなく、
// 地理極と一致しないこと・磁気地方時へ応答することを優先する。
const MAGNETIC_AXIS = new THREE.Vector3(-0.046, 0.986, -0.160).normalize();

function basisAround(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const reference = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const a = new THREE.Vector3().crossVectors(reference, axis).normalize();
  return [a, new THREE.Vector3().crossVectors(axis, a).normalize()];
}

function buildCurtain(hemisphere: 1 | -1, layer: number, timeNode: ReturnType<typeof uniform>, sunNode: ReturnType<typeof uniform>): THREE.Mesh {
  const axis = MAGNETIC_AXIS.clone().multiplyScalar(hemisphere);
  const [a, b] = basisAround(axis);
  const rows = 4;
  const positions = new Float32Array((SEGMENTS + 1) * rows * 3);
  const colors = new Float32Array((SEGMENTS + 1) * rows * 3);
  const indices: number[] = [];
  const altitude = [92e3, 112e3, 245e3, 510e3];
  const palette = [
    new THREE.Color(0.00, 0.05, 0.018),
    new THREE.Color(0.025, 0.78, 0.24),
    new THREE.Color(0.18, 0.52, 0.36),
    new THREE.Color(0.46, 0.035, 0.10),
  ];
  for (let i = 0; i <= SEGMENTS; i++) {
    const longitude = (i / SEGMENTS) * Math.PI * 2;
    // 夜側で赤道方向へ広がる楕円オーバルと、平行な複数カーテン。
    const colatitude = THREE.MathUtils.degToRad(
      20.5 + layer * 1.15 + 3.2 * Math.cos(longitude) + 0.9 * Math.sin(longitude * 3 + layer),
    );
    const around = a.clone().multiplyScalar(Math.cos(longitude)).addScaledVector(b, Math.sin(longitude));
    const dir = axis.clone().multiplyScalar(Math.cos(colatitude)).addScaledVector(around, Math.sin(colatitude)).normalize();
    for (let row = 0; row < rows; row++) {
      const index = (i * rows + row) * 3;
      const radius = R_EARTH + altitude[row]! + layer * 18e3;
      positions.set([dir.x * radius, dir.y * radius, dir.z * radius], index);
      const c = palette[row]!;
      const layerGain = 0.72 - layer * 0.065;
      colors.set([c.r * layerGain, c.g * layerGain, c.b * layerGain], index);
    }
  }
  for (let i = 0; i < SEGMENTS; i++) for (let row = 0; row < rows - 1; row++) {
    const p = i * rows + row;
    indices.push(p, p + 1, p + rows, p + rows, p + 1, p + rows + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    opacity: 0.56,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const direction = normalize(positionLocal);
  const magneticLocalTime = clamp(float(0.62).sub(dot(direction, normalize(sunNode)).mul(0.32)), 0.28, 0.94);
  const fine = positionLocal.x.mul(1.7e-5).add(positionLocal.z.mul(2.3e-5)).add(timeNode.mul(2.7)).sin();
  const pulse = float(0.72).add(fine.mul(0.22)).add(timeNode.mul(0.71).add(layer * 1.7).sin().mul(0.08));
  material.colorNode = vertexColor().mul(magneticLocalTime.mul(pulse));
  const mesh = new THREE.Mesh(geometry, material as unknown as THREE.Material);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}

export function createEarthAurora(): EarthAurora {
  const group = new THREE.Group();
  const timeNode = uniform(0);
  const sunNode = uniform(new THREE.Vector3(1, 0, 0));
  const meshes: THREE.Mesh[] = [];
  for (let layer = 0; layer < CURTAINS / 2; layer++) for (const hemisphere of [1, -1] as const) {
      const mesh = buildCurtain(hemisphere, layer, timeNode, sunNode);
      meshes.push(mesh);
      group.add(mesh);
    }
  let quality: CelestialQuality = 'high';
  let lastUpdate = Number.NEGATIVE_INFINITY;
  return {
    group,
    setSunDirection(x, y, z) { (sunNode.value as THREE.Vector3).set(x, y, z).normalize(); },
    setQuality(next) {
      quality = next;
      const visible = CELESTIAL_QUALITY[next].auroraCurtains;
      for (let i = 0; i < meshes.length; i++) meshes[i]!.visible = i < visible;
    },
    tick(displayTime) {
      const interval = CELESTIAL_QUALITY[quality].visualUpdateInterval;
      if (Math.abs(displayTime - lastUpdate) < interval) return;
      timeNode.value = displayTime * 0.02;
      lastUpdate = displayTime;
    },
  };
}
