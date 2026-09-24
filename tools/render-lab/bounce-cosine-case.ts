// 照り返しの送り手余弦を読む較正ケース。同じ面積・距離・放射輝度の3枚の光る面と、
// それぞれに対称な白い受け手を並べ、法線だけを cos θ = 1 / 0.5 / 0 に変える。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import { EARTH_AWAY, labCamera, type CaseBuilder, type LabCase } from './lab-case';

const SOURCE_AREA_SIDE = 1;
const RECEIVER_SIDE = 2;
const SOURCE_HEIGHT = 1;
const RECEIVER_FORWARD = 1;
const PANEL_SPACING = 6;
const EMISSIVE_RADIANCE = 1.5;
const COSINES = [1, 0.5, 0] as const;
const GRAPHICS: Partial<GraphicsSettingsData> = {
  ambient: false, planetLightCount: 0, lens: false, exposureCompensation: 4,
};

function bounceCosine(): LabCase {
  const objects = new THREE.Group();
  const receiverMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const sourceMaterial = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: new THREE.Color(0x66ffff), emissiveIntensity: EMISSIVE_RADIANCE,
    roughness: 1, side: THREE.DoubleSide,
  });
  const towardReceiver = new THREE.Vector3(0, -SOURCE_HEIGHT, RECEIVER_FORWARD).normalize();
  const sideways = new THREE.Vector3(0, RECEIVER_FORWARD, SOURCE_HEIGHT).normalize();
  for (const [index, cosine] of COSINES.entries()) {
    const x = (index - 1) * PANEL_SPACING;
    const receiver = new THREE.Mesh(
      new THREE.BoxGeometry(RECEIVER_SIDE, 0.1, RECEIVER_SIDE), receiverMaterial,
    );
    receiver.position.set(x, -0.05, RECEIVER_FORWARD);
    receiver.userData.ownsGeometry = true;
    receiver.userData.ownsMaterial = index === 0;
    objects.add(receiver);

    const source = new THREE.Mesh(new THREE.PlaneGeometry(SOURCE_AREA_SIDE, SOURCE_AREA_SIDE), sourceMaterial);
    const normal = towardReceiver.clone().multiplyScalar(cosine)
      .addScaledVector(sideways, Math.sqrt(1 - cosine * cosine));
    source.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    source.position.set(x, SOURCE_HEIGHT, 0);
    source.userData.ownsGeometry = true;
    source.userData.ownsMaterial = index === 0;
    objects.add(source);
  }
  markLitOpaque(objects);

  const camera = labCamera();
  camera.position.set(0, 5, 18);
  camera.lookAt(0, 0.35, 0.5);
  camera.updateMatrixWorld();
  return {
    objects: [objects], camera, viewTarget: new THREE.Vector3(0, 0.35, 0.5),
    sunDirection: new THREE.Vector3(0, -1, 0),
    shots: {
      'bounce-cosine': { view: EARTH_AWAY, graphics: GRAPHICS },
      'bounce-cosine-diffuse': {
        view: EARTH_AWAY, graphics: GRAPHICS, debugTarget: 'diffuse',
      },
      'bounce-cosine-correction': {
        view: EARTH_AWAY, graphics: GRAPHICS, debugTarget: 'correction',
      },
      'bounce-cosine-source': {
        view: EARTH_AWAY, graphics: GRAPHICS, debugTarget: 'bounce-source',
      },
    },
  };
}

export const BOUNCE_COSINE_CASES = {
  'bounce-cosine': bounceCosine,
} as const satisfies Record<string, CaseBuilder>;
