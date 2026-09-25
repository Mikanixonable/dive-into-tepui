// 大気積分へ挿入する雲殻の交差判定・順序制御・合成処理を統括する。
// AtmosphereIntegrator から天体空間の幾何配置と太陽放射輝度を入力パラメータとして受け取る。
import { If, and, exp, float, greaterThan, lessThan, mix, normalize, step, vec3 } from 'three/tsl';
import {
  CLOUD_SHELL_SPECIES, CloudAtmosphereRenderer, type CloudShellSample, type CloudSpecies,
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

export interface CloudShellEvent {
  readonly distance: FloatNode;
  // その雲イベント自身を抜けた透過率。縦柱tau×airmassを一度だけ変換した値。
  readonly cloudTransmittance: FloatNode;
  // イベント局所の放射輝度。自分のcloudTransmittanceはまだ掛けない。
  readonly localRadiance: Vec3Node;
  // カメラからこのイベントまでの背景大気透過。localRadianceへ一度だけ掛ける。
  readonly backgroundTransmittance: Vec3Node;
}

export class AtmosphereCloudLayers {
  private readonly clouds = new CloudAtmosphereRenderer();

  public setClouds(clouds: Parameters<CloudAtmosphereRenderer['set']>[0]): void {
    this.clouds.set(clouds);
  }

  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.clouds.setShellEnabled(species, enabled);
  }

  public transmittanceAt(events: readonly CloudShellEvent[], distance: FloatNode): FloatNode {
    const product = float(1).toVar();
    for (const event of events) {
      product.mulAssign(mix(float(1), event.cloudTransmittance, step(event.distance, distance)));
    }
    return product;
  }

  public compose(
    atmosphereTransmittance: Vec3Node, atmosphereRadiance: Vec3Node,
    events: readonly CloudShellEvent[],
  ): { readonly transmittance: Vec3Node; readonly inscatter: Vec3Node } {
    // eventsはカメラから遠方への順。frontは手前イベントだけを遠いイベントへ掛ける。
    const frontTransmittance = float(1).toVar();
    const eventRadiance = vec3(0, 0, 0).toVar();
    for (const event of events) {
      eventRadiance.addAssign(
        frontTransmittance.mul(event.backgroundTransmittance).mul(event.localRadiance),
      );
      frontTransmittance.mulAssign(event.cloudTransmittance);
    }
    return {
      transmittance: atmosphereTransmittance.mul(frontTransmittance),
      inscatter: atmosphereRadiance.add(eventRadiance),
    };
  }

  public build(
    ray: AtmosphereCloudRay, segment: AtmosphereCloudSegment,
    rayOrigin: Vec3Node, rayDir: Vec3Node, geometry: AtmosphereCloudGeometry,
  ): readonly CloudShellEvent[] {
    const shells = CLOUD_SHELL_SPECIES.map((species) => {
      const radius = geometry.shellRadiusOf(species);
      return { species, radius, crossings: geometry.crossingsOf(ray, radius) };
    });
    const entries = shells.map((shell) => [shell, shell.crossings.entry] as const);
    const exits = shells.map((shell) => [shell, shell.crossings.exit] as const).reverse();
    const originDepth = geometry.outwardDepthAt(ray, float(0));
    const layers: CloudShellEvent[] = [];
    // 局所光学場の消散は視線へ一度だけ掛ける — 交点から前方へ積分した値なので、後のイベントで
    // もう一度掛けると同じ弦を重複して数える。
    const localFieldApplied = float(0).toVar();
    // 同心殻は外側からentry、内側からexitの順に並べればfront-to-backになる。接線はcrosses=false
    // のためイベントを作らず、入口/出口を不安定に2つへ分けない。
    for (const [shell, crossing] of [...entries, ...exits]) {
      const distance = crossing.toVar();
      const cloudTransmittance = float(1).toVar();
      const localRadiance = vec3(0, 0, 0).toVar();
      const backgroundTransmittance = vec3(1, 1, 1).toVar();
      const inSegment = and(
        greaterThan(distance, segment.near), lessThan(distance, segment.far),
      );
      If(and(and(shell.crossings.crosses, inSegment), this.clouds.present(shell.species)), () => {
        const point = geometry.pointAt(rayOrigin, rayDir, distance);
        const offset = geometry.offsetAt(ray, distance);
        const sunDir = normalize(geometry.sunDirectionAt(point));
        const sample: CloudShellSample = this.clouds.scatteredAt(
          shell.species, shell.radius, offset, ray.unitDir, sunDir, geometry.sunRadianceAt(point),
        );
        cloudTransmittance.assign(sample.transmittance);
        If(localFieldApplied.lessThan(0.5), () => {
          localFieldApplied.assign(1);
          cloudTransmittance.mulAssign(exp(sample.localFieldTau.negate()));
        });
        localRadiance.assign(sample.radiance);
        backgroundTransmittance.assign(geometry.transmittanceTo(originDepth, ray, distance));
      });
      layers.push({ distance, cloudTransmittance, localRadiance, backgroundTransmittance });
    }
    return layers;
  }

}
