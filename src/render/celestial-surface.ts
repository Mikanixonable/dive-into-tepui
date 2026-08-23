// 天体表面のメッシュと、その昼夜の陰影。天体は光源を共有せず、自分の位置から見た恒星方向を
// uniform で受け取って自分だけで陰影を計算する。
import * as THREE from 'three/webgpu';
import {
  and,
  clamp,
  dot,
  exp,
  float,
  greaterThan,
  length,
  lessThan,
  max,
  min,
  normalWorld,
  positionWorld,
  select,
  sub,
  texture as textureNode,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { RingSystemDef } from '../physics/solar-system';
import { SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from './tsl-types';

// 夜側の明るさ(0 で真っ暗)。惑星光・星明かりを表す最低限の底上げ。
export const NIGHT_AMBIENT = 0.04;

// 分割数の組が SPHERE_LOD_LADDER のいずれかの段と一致する呼び出しだけ、その段の単位球
// ジオメトリを全呼び出し元(=全天体)で共有する。一致しない組(既存のジオメトリを
// 個別に書き換える呼び出しなど)は共有すると他の利用元を壊すため、専用に1つ作る。
const sharedLodGeometries = new Map<SphereLodLevel, THREE.BufferGeometry>();
function unitSphereGeometry(widthSegments: number, heightSegments: number): { geometry: THREE.BufferGeometry; shared: boolean } {
  const level = SPHERE_LOD_LADDER.find((l) => l.widthSegments === widthSegments && l.heightSegments === heightSegments);
  if (level === undefined) return { geometry: new THREE.SphereGeometry(1, widthSegments, heightSegments), shared: false };
  let geo = sharedLodGeometries.get(level);
  if (geo === undefined) {
    geo = new THREE.SphereGeometry(1, widthSegments, heightSegments);
    sharedLodGeometries.set(level, geo);
  }
  return { geometry: geo, shared: true };
}

type RingShadowBand = {
  readonly axis: Vec3Uniform;
  readonly center: Vec3Uniform;
  readonly inner: FloatUniform;
  readonly outer: FloatUniform;
  readonly tau: FloatUniform;
  readonly active: FloatUniform;
};

export class CelestialSurface {
  private readonly sunDirNode = uniform(new THREE.Vector3(1, 0, 0));
  // リングを持たない天体では null のままにする。リング付き天体でも、実際に同期される
  // まで遅延して作ることで、非リング天体の shader graph に32帯ぶんの計算を混ぜない。
  private ringShadowBands: readonly RingShadowBand[] | null = null;
  // setRingShadowSystem は毎フレーム呼ばれるため、リング付き天体についても一時ベクトルを再利用する。
  private readonly ringAxis = new THREE.Vector3(0, 1, 0);

  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;
  private readonly albedoNode: Vec3Node;
  // false なら mesh.geometry は SPHERE_LOD_LADDER 段の共有ジオメトリで、dispose では触らない。
  private readonly ownsGeometry: boolean;
  private readonly texture: THREE.Texture | null;

  // albedo は面の色を返すノード。これに昼夜の陰影を掛けたものが最終色になる。
  private constructor(geometry: THREE.BufferGeometry, ownsGeometry: boolean, albedo: Vec3Node, texture: THREE.Texture | null) {
    this.ownsGeometry = ownsGeometry;
    this.texture = texture;
    this.albedoNode = albedo;
    this.material = this.buildMaterial(this.albedoNode, false);
    this.mesh = new THREE.Mesh(geometry, this.material);
  }

  private material: THREE.MeshBasicNodeMaterial;

  private buildMaterial(albedo: Vec3Node, withRingShadows: boolean): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    const lambert = clamp(dot(normalWorld, this.sunDirNode), 0, 1);
    let ringTransmission: FloatNode = float(1);
    if (withRingShadows) {
      // withRingShadows は enableRingShadows() で bands を先に作ってから呼ぶ。
      const bands = this.ringShadowBands;
      if (bands === null) throw new Error('CelestialSurface: ring shadow bands are not initialized');
      for (const band of bands) {
        const relative = sub(positionWorld, band.center);
        const denominator = dot(band.axis, this.sunDirNode);
        const safeDenominator = select(greaterThan(denominator, 0), max(denominator, 0.015), min(denominator, -0.015));
        const planeDistance = dot(relative, band.axis).negate().div(safeDenominator);
        const hit = positionWorld.add(this.sunDirNode.mul(planeDistance));
        const radial = length(sub(hit, band.center));
        const inside = and(
          greaterThan(planeDistance, 0),
          and(greaterThan(radial, band.inner), lessThan(radial, band.outer)),
        );
        const transmission = exp(band.tau.div(max(denominator.abs(), 0.015)).negate());
        ringTransmission = ringTransmission.mul(select(and(inside, greaterThan(band.active, 0.5)), transmission, float(1)));
      }
    }
    // 環が遮るのは太陽の直射光だけ。夜側の環境光まで減衰させない。
    mat.colorNode = albedo.mul(float(NIGHT_AMBIENT).add(
      lambert.mul(1 - NIGHT_AMBIENT).mul(ringTransmission),
    ));
    return mat;
  }

  private enableRingShadows(): void {
    if (this.ringShadowBands !== null) return;
    this.ringShadowBands = Array.from({ length: 32 }, () => ({
      axis: uniform(new THREE.Vector3(0, 1, 0)),
      center: uniform(new THREE.Vector3()),
      inner: uniform(-1),
      outer: uniform(-1),
      tau: uniform(0),
      active: uniform(0),
    }));
    const previousMaterial = this.material;
    this.material = this.buildMaterial(this.albedoNode, true);
    this.mesh.material = this.material;
    previousMaterial.dispose();
  }

  // 実写テクスチャを貼った球面。
  static textured(textureUrl: string, widthSegments: number, heightSegments: number): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    return new CelestialSurface(geometry, !shared, textureNode(map, uv()).rgb, map);
  }

  // テクスチャを持たない天体の単色球面。
  static solid(color: number, widthSegments: number, heightSegments: number): CelestialSurface {
    const c = new THREE.Color(color);
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    return new CelestialSurface(geometry, !shared, vec3(c.r, c.g, c.b), null);
  }

  // この天体の真の ECI 位置から見た恒星方向(単位ベクトル)を与える。
  setSunDirection(dir: THREE.Vector3): void {
    this.sunDirNode.value.copy(dir);
  }

  // 環平面と太陽方向の交点を表面シェーダへ渡す。最大32帯まで、複数帯は透過率を乗算する。
  setRingShadowSystem(rings: RingSystemDef | undefined, bodyCenter: THREE.Vector3, axis: THREE.Vector3 | null): void {
    if (rings !== undefined) this.enableRingShadows();
    const bands = this.ringShadowBands;
    // リング情報を持たない天体では、リング用uniformもshader nodeも存在しない。
    if (bands === null) return;
    const ringAxis = axis === null
      ? this.ringAxis.set(0, 1, 0)
      : this.ringAxis.copy(axis).normalize();
    for (let i = 0; i < bands.length; i++) {
      const node = bands[i]!;
      const band = rings?.bands[i];
      node.axis.value.copy(ringAxis);
      node.center.value.copy(bodyCenter);
      if (band === undefined) {
        node.active.value = 0;
        continue;
      }
      node.inner.value = band.innerRadius;
      node.outer.value = band.outerRadius;
      node.tau.value = band.optics.normalOpticalDepth;
      node.active.value = 1;
    }
  }

  // mesh を親から外し、現行マテリアルとテクスチャを解放する。テクスチャは
  // material.dispose() から連鎖解放されない(TSL のノードグラフに埋め込まれているだけ)ため、
  // ここで個別に dispose する。
  dispose(): void {
    this.mesh.removeFromParent();
    this.material.dispose();
    if (this.ownsGeometry) this.mesh.geometry.dispose();
    this.texture?.dispose();
  }
}
