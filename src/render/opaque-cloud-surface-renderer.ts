// 積雲fieldを外殻から内側へ連続密度として積分し、累積光学深度が閾値を越えた位置を
// 不透明表面としてGバッファへ書く。cloudTop交点やclearanceの二分探索は主経路に置かない。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, float,
  greaterThanEqual, length, max, modelViewMatrix, modelWorldMatrixInverse, normalize,
  positionLocal, select, uniform, transformNormalToView, vec3, vec4,
} from 'three/tsl';
import { CloudFieldSampler, type CloudLodMode } from './cloud/cloud-field-sampler';
import { CloudVolume } from './cloud/cloud-volume';
import { unitSphereGeometry } from './celestial-surface';
import { CLOUD_ALBEDO, CLOUD_TOP_SPAN } from './cloud/cumulus-shape';
import { eastAt, northAt } from './cloud/sphere-frame';
import { markLitOpaque } from './pipeline/lit-layer';
import {
  sphereLodLevelWithHysteresis, SPHERE_LOD_LADDER, SphereLodLevel,
} from './screen-lod';
import type { FloatNode, FloatUniform, Vec3Node, Vec4Node } from './tsl-types';

const CUMULUS_ROUGHNESS = 1;
const SURFACE_OPACITY_OPTICAL_DEPTH = 1;
const NORMAL_SAMPLE_DISTANCE = 1000;

export const CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

type CumulusSampling = { readonly march: number };

// 固定段数は表面雲のGPU費用上限でもある。段を増やす場合はこの表とGPU計測を同時に更新する。
const SAMPLING_OF_DETAIL = {
  [CUMULUS_DETAIL.off]: { march: 0 },
  // field.g はcoverageに応じて雲底近くまで縮むため、殻全体を粗く割るとprofileを
  // 一度も評価しない。段数は高度方向の最小の薄い雲を拾う固定上限で、光学式やhit
  // 判定を二値化する代わりに、すべての段を同じCloudVolumeへ渡す。
  [CUMULUS_DETAIL.coarse]: { march: 16 },
  [CUMULUS_DETAIL.standard]: { march: 32 },
  [CUMULUS_DETAIL.fine]: { march: 48 },
} as const satisfies Readonly<Record<CumulusDetail, CumulusSampling>>;

export class OpaqueCloudSurfaceRenderer {
  private readonly volume: CloudVolume;
  private readonly bodyRadius: FloatUniform;
  private sampling: CumulusSampling = SAMPLING_OF_DETAIL[CUMULUS_DETAIL.standard];
  private material: THREE.Material;
  private readonly groundRadius: FloatUniform;
  private readonly shellScale: FloatUniform;
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  public constructor(private readonly fieldSampler: CloudFieldSampler, bodyRadius: number) {
    this.volume = new CloudVolume(fieldSampler);
    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    this.bodyRadius = uniform(bodyRadius);
    this.shellScale = uniform(shellScale);
    this.groundRadius = uniform(1 / shellScale);
    this.material = this.buildMaterial();

    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), this.material);
      mesh.scale.setScalar(shellScale);
      mesh.visible = false;
      markLitOpaque(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  public get visible(): boolean { return this.activeLevel !== null; }
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  public setDetail(detail: CumulusDetail): void {
    this.setSampling(SAMPLING_OF_DETAIL[detail]);
    if (detail === CUMULUS_DETAIL.off) this.hide();
  }

  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.fieldSampler.setLodSampling(mode, fixedLevel);
  }

  private setSampling(sampling: CumulusSampling): void {
    if (sampling.march === this.sampling.march) return;
    this.sampling = sampling;
    const previous = this.material;
    this.material = this.buildMaterial();
    for (const mesh of this.meshes.values()) mesh.material = this.material;
    previous.dispose();
  }

  public syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevelWithHysteresis(
      apparentDiameterPx, this.activeLevel, this.sampling.march !== 0,
    );
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  public dispose(): void {
    this.hide();
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
  }

  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    const marched = this.marchedSurface().toVar();
    material.depthNode = marched.w;
    material.normalNode = marched.xyz;
    material.colorNode = vec3(CLOUD_ALBEDO);
    return material;
  }

  private marchedSurface(): Vec4Node {
    return Fn(() => {
      const entry = positionLocal.toVar();
      const origin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const direction = normalize(entry.sub(origin)).toVar();
      const along = direction.dot(entry);
      const discriminant = along.mul(along).sub(entry.dot(entry));
      const groundDiscriminant = discriminant.add(this.groundRadius.mul(this.groundRadius));
      const marchEnd = max(select(
        groundDiscriminant.greaterThan(0),
        along.negate().sub(groundDiscriminant.sqrt()),
        along.negate().add(max(discriminant.add(1), 0).sqrt()),
      ), 0);
      const stepLength = marchEnd.div(Math.max(this.sampling.march, 1));
      const footprint = max(length(dFdx(entry)), length(dFdy(entry)))
        .mul(this.bodyRadius).mul(this.shellScale);
      const accumulated = float(0).toVar();
      const hitDistance = float(0).toVar();
      const hit = float(0).toVar();
      for (let index = 0; index < this.sampling.march; index++) {
        const start = stepLength.mul(index);
        const end = stepLength.mul(index + 1);
        const middle = start.add(end).mul(0.5);
        const point = entry.add(direction.mul(middle));
        const density = this.volume.densityAt(
          point.mul(this.bodyRadius).mul(this.shellScale), this.bodyRadius, max(footprint, 1),
        ).cumulus;
        const segmentLength = end.sub(start).mul(this.bodyRadius).mul(this.shellScale);
        const segmentTau = density.mul(segmentLength);
        If(greaterThanEqual(accumulated.add(segmentTau), SURFACE_OPACITY_OPTICAL_DEPTH)
          .and(hit.lessThan(0.5)), () => {
          const fraction = float(SURFACE_OPACITY_OPTICAL_DEPTH).sub(accumulated)
            .div(max(segmentTau, 1e-6)).clamp(0, 1);
          hitDistance.assign(start.add(end.sub(start).mul(fraction)));
          hit.assign(1);
        });
        accumulated.addAssign(segmentTau);
      }

      const hitPoint = entry.add(direction.mul(hitDistance)).toVar();
      // G-bufferは1枚の深度しか持てないため、ここではfront-to-back累積tauが最初に閾値を
      // 越えた体積フロントだけを代表面として書く。背後の散乱層は大気ray march側が扱う。
      const gradient = this.densityGradientAt(hitPoint, footprint);
      // 密度勾配はfieldの方向変化と高度profileを同じ評価器から取り、離散メッシュ法線を使わない。
      const normal = normalize(gradient.negate().add(normalize(hitPoint).mul(1e-4)));
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      Discard(hit.lessThan(0.5));
      return vec4(transformNormalToView(normal), clip.z.div(clip.w));
    })();
  }

  private densityGradientAt(point: Vec3Node, footprint: FloatNode): Vec3Node {
    const up = normalize(point);
    const east = eastAt(up);
    const north = northAt(up);
    const normalFootprint = max(
      footprint,
      this.fieldSampler.fieldTexelWidth(this.bodyRadius).mul(2),
    );
    // fieldの明示LODが画面footprintへ合わせて粗くなるとき、固定1 kmの差分では同じ
    // 補間セル内かセル境界だけを拾って法線が帯になる。2 px相当まで広げ、表示解像度に
    // 追従する平滑な体積境界の勾配を取る。
    const epsilon = max(float(NORMAL_SAMPLE_DISTANCE), normalFootprint.mul(2))
      .div(max(this.bodyRadius.mul(this.shellScale), 1));
    const sample = (offset: Vec3Node): FloatNode => this.volume.densityAt(
      offset.mul(this.bodyRadius).mul(this.shellScale), this.bodyRadius, max(normalFootprint, 1),
    ).cumulus;
    const radial = sample(point.add(up.mul(epsilon))).sub(sample(point.sub(up.mul(epsilon))));
    const eastSlope = sample(point.add(east.mul(epsilon))).sub(sample(point.sub(east.mul(epsilon))));
    const northSlope = sample(point.add(north.mul(epsilon))).sub(sample(point.sub(north.mul(epsilon))));
    return up.mul(radial).add(east.mul(eastSlope)).add(north.mul(northSlope));
  }
}
