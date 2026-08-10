// 天体表面のメッシュと、その昼夜の陰影。天体は描画される位置が真の位置と一致しない
// (戦闘ビューは視距離を圧縮してカメラの近くへ置く)ため、シーンのライトで照らすと
// 昼夜境界が実際の太陽方向と合わない。そこで天体は光源を共有せず、自分の真の位置から見た
// 恒星方向を uniform で受け取り、自分だけで陰影を計算する。
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
  modelNormalMatrix,
  normalize,
  positionWorld,
  select,
  sub,
  texture as textureNode,
  uniform,
  uv,
  vec3,
  smoothstep,
} from 'three/tsl';
import { Vec3 } from '../physics/vec3';
import { RingSystemDef } from '../physics/solar-system';
import { createMoonSurfaceNodes } from './celestial-material';

// 夜側の明るさ(0 で真っ暗)。惑星光・星明かりを表す最低限の底上げ。
export const NIGHT_AMBIENT = 0.04;

export class CelestialSurface {
  private readonly sunDirNode = uniform(new THREE.Vector3(1, 0, 0));
  private readonly earthDirNode = uniform(new THREE.Vector3(1, 0, 0));
  private readonly earthshineNode = uniform(0);
  private readonly directSunNode = uniform(1);
  private readonly eclipseRedNode = uniform(0);
  private readonly ringShadowBands: readonly {
    readonly axis: ReturnType<typeof uniform>;
    readonly center: ReturnType<typeof uniform>;
    readonly inner: ReturnType<typeof uniform>;
    readonly outer: ReturnType<typeof uniform>;
    readonly tau: ReturnType<typeof uniform>;
    readonly active: ReturnType<typeof uniform>;
  }[];

  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;

  // albedo は面の色を返すノード。これに昼夜の陰影を掛けたものが最終色になる。
  private constructor(
    geometry: THREE.BufferGeometry,
    albedo: ReturnType<typeof vec3>,
    terrainNormal: ReturnType<typeof vec3> | null = null,
    lunar = false,
  ) {
    const mat = new THREE.MeshBasicNodeMaterial();
    const shadingNormal = terrainNormal === null
      ? normalWorld
      : normalize(modelNormalMatrix.mul(terrainNormal));
    const lambert = clamp(dot(shadingNormal, this.sunDirNode), 0, 1);
    this.ringShadowBands = Array.from({ length: 32 }, () => ({
      axis: uniform(new THREE.Vector3(0, 1, 0)),
      center: uniform(new THREE.Vector3()),
      inner: uniform(-1),
      outer: uniform(-1),
      tau: uniform(0),
      active: uniform(0),
    }));
    let ringTransmission = float(1);
    for (const band of this.ringShadowBands) {
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
    // 環が遮るのは太陽の直射光だけ。夜側の環境光まで減衰させない。
    if (lunar) {
      // 低い太陽高度ではdetail normalの凹凸を強く残し、クレーター縁の影を作る。
      // 地球照は月→地球方向から来る別の拡散光として夜側へ加える。
      const craterVisibility = smoothstep(0.004, 0.065, dot(shadingNormal, this.sunDirNode));
      const direct = lambert.mul(craterVisibility).mul(this.directSunNode);
      const earthLight = clamp(dot(shadingNormal, this.earthDirNode), 0, 1)
        .mul(this.earthshineNode);
      const eclipseGlow = vec3(0.34, 0.055, 0.018)
        .mul(lambert.mul(this.eclipseRedNode));
      mat.colorNode = albedo.mul(float(0.006).add(direct).add(earthLight)).add(eclipseGlow);
    } else {
      mat.colorNode = albedo.mul(float(NIGHT_AMBIENT).add(
        lambert.mul(1 - NIGHT_AMBIENT).mul(ringTransmission),
      ));
    }
    this.mesh = new THREE.Mesh(geometry, mat as unknown as THREE.Material);
    this.mesh.frustumCulled = false;
  }

  // 実写テクスチャを貼った球面。
  static textured(
    textureUrl: string,
    widthSegments = 48,
    heightSegments = 24,
    options: { readonly terrain?: 'moon' } = {},
  ): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const nodes = options.terrain === 'moon' ? createMoonSurfaceNodes(map) : null;
    return new CelestialSurface(
      new THREE.SphereGeometry(1, widthSegments, heightSegments),
      nodes?.baseColor ?? textureNode(map, uv()),
      nodes?.terrainNormal ?? null,
      options.terrain === 'moon',
    );
  }

  // テクスチャを持たない天体の単色球面。
  static solid(color: number): CelestialSurface {
    const c = new THREE.Color(color);
    return new CelestialSurface(new THREE.SphereGeometry(1, 32, 16), vec3(c.r, c.g, c.b));
  }

  // この天体の真の ECI 位置から見た恒星方向(単位ベクトル)を与える。
  setSunDirection(dir: Vec3): void {
    this.sunDirNode.value.set(dir.x, dir.y, dir.z);
  }

  /** 月面専用の地球照・月食入力。通常天体では呼ばれない。 */
  setLunarLighting(earthDirection: Vec3, earthshine: number, directSun: number, eclipseRed: number): void {
    this.earthDirNode.value.set(earthDirection.x, earthDirection.y, earthDirection.z);
    this.earthshineNode.value = Math.max(0, earthshine);
    this.directSunNode.value = Math.max(0, Math.min(1, directSun));
    this.eclipseRedNode.value = Math.max(0, Math.min(1, eclipseRed));
  }

  // 環平面と太陽方向の交点を表面シェーダへ渡す。最大32帯まで、複数帯は透過率を乗算する。
  setRingShadowSystem(rings: RingSystemDef | undefined, bodyCenter: THREE.Vector3, bodyRadius: number, displayScale: number, axis: Vec3 | null): void {
    const ringAxis = axis === null ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
    for (let i = 0; i < this.ringShadowBands.length; i++) {
      const node = this.ringShadowBands[i]!;
      const band = rings?.bands[i];
      node.axis.value.copy(ringAxis);
      node.center.value.copy(bodyCenter);
      if (band === undefined) {
        node.active.value = 0;
        continue;
      }
      node.inner.value = (band.innerRadius / bodyRadius) * displayScale;
      node.outer.value = (band.outerRadius / bodyRadius) * displayScale;
      node.tau.value = band.optics.normalOpticalDepth;
      node.active.value = 1;
    }
  }
}
