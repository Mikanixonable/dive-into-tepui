// Fixed-layer optical-depth diagnostic for a local cloud volume. Each z slab is homogeneous in altitude;
// xy density may still vary, so the GPU evaluates its midpoint on the ray. This is intended for the small
// C9 two-layer fixture, not as the product integrator for arbitrary fine-scale fields.
import * as THREE from 'three/webgpu';
import { and, exp, float, int, max, min, select, sqrt, texture, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec4Node } from '../tsl-types';

export interface CloudOpticalRayNodes {
  // UV at startAltitudeM. UV is in the volume's normalized local-grid coordinates.
  readonly originUv: Vec2Node;
  // Local grid's physical spans. UV is dimensionless; these convert its slope back to horizontal metres.
  readonly gridSpanEastM: number;
  readonly gridSpanNorthM: number;
  // Change in normalized UV per metre of vertical altitude.
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
  requirePositiveFinite(ray.gridSpanEastM, 'gridSpanEastM');
  requirePositiveFinite(ray.gridSpanNorthM, 'gridSpanNorthM');
  return THREE.TSL.Fn(() => {
    const liquidTau = float(0).toVar();
    const iceTau = float(0).toVar();
    const horizontalEastPerAltitude = ray.uvDeltaPerAltitudeM.x.mul(ray.gridSpanEastM);
    const horizontalNorthPerAltitude = ray.uvDeltaPerAltitudeM.y.mul(ray.gridSpanNorthM);
    const pathLengthPerAltitude = sqrt(horizontalEastPerAltitude.mul(horizontalEastPerAltitude)
      .add(horizontalNorthPerAltitude.mul(horizontalNorthPerAltitude)).add(1));

    for (let layer = 0; layer < layerEdgesM.length - 1; layer += 1) {
      const segmentStart = max(ray.startAltitudeM, float(layerEdgesM[layer]!));
      const segmentEnd = min(ray.endAltitudeM, float(layerEdgesM[layer + 1]!));
      const verticalLength = max(segmentEnd.sub(segmentStart), 0);
      const midpointAltitude = segmentStart.add(segmentEnd).mul(0.5);
      const segmentStartUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(segmentStart.sub(ray.startAltitudeM)),
      );
      const segmentEndUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(segmentEnd.sub(ray.startAltitudeM)),
      );
      const sampleUv = ray.originUv.add(
        ray.uvDeltaPerAltitudeM.mul(midpointAltitude.sub(ray.startAltitudeM)),
      );
      const sample = texture(volume, sampleUv).depth(int(layer)).level(float(0));
      const opticalPathLength = verticalLength.mul(pathLengthPerAltitude);
      // For a linear ray, checking both endpoints guarantees the complete segment stays inside the UV box;
      // otherwise discard the segment instead of integrating texture edge-clamp values.
      const startInsideGrid = and(
        and(segmentStartUv.x.greaterThanEqual(0), segmentStartUv.x.lessThanEqual(1)),
        and(segmentStartUv.y.greaterThanEqual(0), segmentStartUv.y.lessThanEqual(1)),
      );
      const endInsideGrid = and(
        and(segmentEndUv.x.greaterThanEqual(0), segmentEndUv.x.lessThanEqual(1)),
        and(segmentEndUv.y.greaterThanEqual(0), segmentEndUv.y.lessThanEqual(1)),
      );
      const midpointInsideGrid = and(
        and(sampleUv.x.greaterThanEqual(0), sampleUv.x.lessThanEqual(1)),
        and(sampleUv.y.greaterThanEqual(0), sampleUv.y.lessThanEqual(1)),
      );
      const insideGrid = and(and(startInsideGrid, endInsideGrid), midpointInsideGrid);
      liquidTau.addAssign(select(insideGrid, sample.r, float(0)).mul(opticalPathLength));
      iceTau.addAssign(select(insideGrid, sample.g, float(0)).mul(opticalPathLength));
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

export function cloudRayPathLengthPerAltitude(
  eastUvPerAltitudeM: number,
  northUvPerAltitudeM: number,
  gridSpanEastM: number,
  gridSpanNorthM: number,
): number {
  requireFinite(eastUvPerAltitudeM, 'eastUvPerAltitudeM');
  requireFinite(northUvPerAltitudeM, 'northUvPerAltitudeM');
  requirePositiveFinite(gridSpanEastM, 'gridSpanEastM');
  requirePositiveFinite(gridSpanNorthM, 'gridSpanNorthM');
  return Math.hypot(eastUvPerAltitudeM * gridSpanEastM, northUvPerAltitudeM * gridSpanNorthM, 1);
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite`);
}
