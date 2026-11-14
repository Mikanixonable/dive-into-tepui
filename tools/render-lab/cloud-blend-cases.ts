import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { CloudFieldSampler } from '../../src/render/cloud/cloud-field-sampler';
import { CloudBlendState } from '../../src/render/cloud/cloud-field-sample';
import type { CaseBuilder, LabCase } from './lab-case';
import { labCamera } from './lab-case';

const CAP = {
  center: new THREE.Vector3(0, 0, 1),
  east: new THREE.Vector3(1, 0, 0),
  north: new THREE.Vector3(0, 1, 0),
  sinRadius: 1,
  cosRadius: -1,
};

function cloudTexture(cumulus: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([cumulus, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function cloudBlend(): LabCase {
  const sampler = new CloudFieldSampler();
  const blend = new CloudBlendState();
  const dim = cloudTexture(32);
  const bright = cloudTexture(224);
  const neutral = cloudTexture(0);
  sampler.bind({
    slots: [
      { cloud: dim, motion: neutral, environment: neutral },
      { cloud: bright, motion: neutral, environment: neutral },
    ],
    blend,
    cap: CAP,
  });
  const sample = sampler.sampleCloud(vec3(0, 0, 1));
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = vec3(sample.cumulus, sample.cumulus, sample.cumulus);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), material);
  plane.position.z = -20;
  return {
    objects: [plane],
    camera: labCamera(),
    syncMotion: (displayTime) => {
      blend.set(0, displayTime > 0 ? 1 : 0);
    },
    dispose: () => {
      sampler.unbind();
      dim.dispose();
      bright.dispose();
      neutral.dispose();
    },
    shots: {
      'cloud-blend-base': { view: {}, displayTime: 0 },
      'cloud-blend-updated': { view: {}, displayTime: 1 },
    },
  };
}

export const CLOUD_BLEND_CASES = {
  'cloud-blend': cloudBlend,
} satisfies Record<string, CaseBuilder>;
