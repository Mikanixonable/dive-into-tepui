// Fixed-layer optical-depth diagnostic for a local cloud volume. Each z slab is homogeneous in altitude;
// xy density may still vary, so the GPU evaluates its midpoint on the ray. This is intended for the small
// C9 two-layer fixture, not as the product integrator for arbitrary fine-scale fields.
import * as THREE from 'three/webgpu';
import { exp, float, int, max, min, sqrt, texture, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec4Node } from '../tsl-types';

export interface CloudOpticalRayNodes {
  // UV at startAltitudeM. UV is in the volume's normalized local-grid coordinates.
  readonly originUv: Vec2Node;
  // Change in normalized UV per metre of vertical altitude. A 45-degree ray across a square 20 km grid
  // has magnitude 1 / 20_000 in the traveled horizontal axis.
  readonly uvDeltaPerAltitudeM: Vec2Node;
  // The diagnostic ray travels upward; startAltitudeM must be less than endAltitudeM.
  readonly startAltitudeM: FloatNode;
  readonly endAltitudeM: FloatNode;
}

// Integrate every discrete altitude slab of an RG32F/RG16F volume. The static JS loop emits one texture
// lookup per slab. Per phase the result is in m^-1 times metres = dimensionless optical depth.
// Output channels are liquid tau, ice tau, total tau, and exp(-total tau).
export function integrateCloudOpticalVolumeRayNode(
  volume: THREE.DataArrayTexture,
  layerEdgesM: Float32Array,
  ray: CloudOpticalRayNodes,
): Vec4Node {
  validateLayerEdges(volume, layerEdgesM);
  return THREE.TSL.Fn(() => {
    const liquidTau = float(0).toVar();
    const iceTau = float(0).toVar();
    const pathLengthPerAltitude = sqrt(
      ray.uvDeltaPerAltitudeM.x.mul(ray.uvDeltaPerAltitudeM.x)
        .add(ray.uvDeltaPerAltitudeM.y.mul(ray.uvDeltaPerAltitudeM.y)).add(1),
    );

    for (let layer = 0; layer < layerEdgesM.length - 1; layer += 1) {
      const segmentStart = max(ray.startAltitudeM, float(layerEdgesM[layer]!));
      const segmentEnd = min(ray.endAltitudeM, float(layerEdgesM[layer + 1]!));
      const verticalLength = max(segmentEnd.sub(segmentStart), 0);
      const midpointAltitude = segmentStart.add(segmentEnd).mul(0.5);
      const sampleUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(midpointAltitude.sub(ray.startAltitudeM)),
      );
      const sample = texture(volume, sampleUv).depth(int(layer)).level(float(0));
      const opticalPathLength = verticalLength.mul(pathLengthPerAltitude);
      liquidTau.addAssign(sample.r.mul(opticalPathLength));
      iceTau.addAssign(sample.g.mul(opticalPathLength));
    }

    const totalTau = liquidTau.add(iceTau);
    return vec4(liquidTau, iceTau, totalTau, exp(totalTau.negate()));
  })() as Vec4Node;
}

function validateLayerEdges(volume: THREE.DataArrayTexture, edges: Float32Array): void {
  const depth = (volume.image as { readonly depth: number }).depth;
  if (!(edges instanceof Float32Array) || edges.length !== depth + 1) {
    throw new RangeError('layerEdgesM must match the volume depth');
  }
  for (let index = 0; index < edges.length; index += 1) {
    if (!Number.isFinite(edges[index]!) || (index > 0 && edges[index]! <= edges[index - 1]!)) {
      throw new RangeError('layerEdgesM must be finite and strictly increasing');
    }
  }
}
