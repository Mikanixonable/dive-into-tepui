// 大気積分へ挿入する雲殻の交差・順序・合成を所有する。大気の密度積分や地平線の幾何は持たず、
// AtmosphereIntegrator(旧 AtmosphereLayer)から天体空間の幾何と太陽輝度だけを契約として受け取る。
import { If, and, float, greaterThan, lessThan, mix, normalize, step, vec3 } from 'three/tsl';
import {
  CloudAtmosphereRenderer, type CloudShellSample, type CloudSpecies,
} from './cloud-atmosphere-renderer';
import type { BoolNode, FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

export interface AtmosphereCloudRay {
  readonly toOrigin: Vec3Node;
  readonly unitDir: Vec3Node;
  readonly unitsPerMeter: FloatNode;
  readonly alongRay: FloatNode;
  readonly perpSq: FloatNode;
}

export interface AtmosphereCloudCrossings {
  readonly entry: FloatNode;
  readonly exit: FloatNode;
  readonly crosses: BoolNode;
}

export interface AtmosphereCloudSegment {
  readonly near: FloatNode;
  readonly far: FloatNode;
}

export interface AtmosphereCloudGeometry {
  readonly shellRadiusOf: (species: CloudSpecies) => FloatNode;
  readonly crossingsOf: (ray: AtmosphereCloudRay, radius: FloatNode) => AtmosphereCloudCrossings;
  readonly outwardDepthAt: (ray: AtmosphereCloudRay, distance: FloatNode) => Vec2Node;
  readonly transmittanceTo: (
    originDepth: Vec2Node, ray: AtmosphereCloudRay, distance: FloatNode,
  ) => Vec3Node;
  readonly pointAt: (rayOrigin: Vec3Node, rayDir: Vec3Node, distance: FloatNode) => Vec3Node;
  readonly offsetAt: (ray: AtmosphereCloudRay, distance: FloatNode) => Vec3Node;
  readonly sunDirectionAt: (point: Vec3Node) => Vec3Node;
  readonly sunRadianceAt: (point: Vec3Node) => Vec3Node;
}

export interface CloudShellLayer {
  readonly distance: FloatNode;
  readonly transmittance: FloatNode;
  readonly radiance: Vec3Node;
}

export class AtmosphereCloudLayers {
  private readonly clouds = new CloudAtmosphereRenderer();

  public setClouds(clouds: Parameters<CloudAtmosphereRenderer['set']>[0]): void {
    this.clouds.set(clouds);
  }

  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.clouds.setShellEnabled(species, enabled);
  }

  public transmittanceAt(shells: readonly CloudShellLayer[], distance: FloatNode): FloatNode {
    const product = float(1).toVar();
    for (const shell of shells) {
      product.mulAssign(mix(float(1), shell.transmittance, step(shell.distance, distance)));
    }
    return product;
  }

  public compose(
    atmosphereTransmittance: Vec3Node, atmosphereRadiance: Vec3Node,
    shells: readonly CloudShellLayer[],
  ): { readonly transmittance: Vec3Node; readonly inscatter: Vec3Node } {
    const shellTransmittance = float(1).toVar();
    const shellRadiance = vec3(0, 0, 0).toVar();
    for (const shell of shells) {
      shellTransmittance.mulAssign(shell.transmittance);
      shellRadiance.addAssign(shell.radiance);
    }
    return {
      transmittance: atmosphereTransmittance.mul(shellTransmittance),
      inscatter: atmosphereRadiance.add(shellRadiance),
    };
  }

  public build(
    ray: AtmosphereCloudRay, segment: AtmosphereCloudSegment,
    rayOrigin: Vec3Node, rayDir: Vec3Node, pixelAngle: FloatNode,
    geometry: AtmosphereCloudGeometry,
  ): readonly CloudShellLayer[] {
    const shells = (['cirrus', 'cumulus'] as const).map((species) => {
      const radius = geometry.shellRadiusOf(species);
      return { species, radius, crossings: geometry.crossingsOf(ray, radius) };
    });
    const entries = shells.map((shell) => [shell, shell.crossings.entry] as const);
    const exits = shells.map((shell) => [shell, shell.crossings.exit] as const).reverse();
    const originDepth = geometry.outwardDepthAt(ray, float(0));
    const front = float(1).toVar();
    const layers: CloudShellLayer[] = [];
    for (const [shell, crossing] of [...entries, ...exits]) {
      const distance = crossing.toVar();
      const transmittance = float(1).toVar();
      const radiance = vec3(0, 0, 0).toVar();
      const inSegment = and(
        greaterThan(distance, segment.near), lessThan(distance, segment.far),
      );
      If(and(and(shell.crossings.crosses, inSegment), this.clouds.present(shell.species)), () => {
        const point = geometry.pointAt(rayOrigin, rayDir, distance);
        const offset = geometry.offsetAt(ray, distance);
        const sunDir = normalize(geometry.sunDirectionAt(point));
        const sample: CloudShellSample = this.clouds.scatteredAt(
          shell.species, shell.radius, offset, ray.unitDir, sunDir,
          geometry.sunRadianceAt(point), pixelAngle.mul(distance),
        );
        transmittance.assign(sample.transmittance);
        radiance.assign(sample.radiance.mul(front).mul(
          geometry.transmittanceTo(originDepth, ray, distance),
        ));
      });
      front.mulAssign(transmittance);
      layers.push({ distance, transmittance, radiance });
    }
    return layers;
  }

}
