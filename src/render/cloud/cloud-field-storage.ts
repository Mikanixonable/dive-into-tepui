// 雲場の basis テクスチャと shape テクスチャを同じ投影・世代で管理する GPU storage。
// shape は coverage と cloudTop を持ち、basis の光学重みから形状を復元しない。
import * as THREE from 'three/webgpu';
import { BakedField } from '../baked-field';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink, GpuPassId } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { Vec3Node, Vec4Node } from '../tsl-types';
import { cloudSampleFromTexels, type CloudSample } from './cloud-field-sample';

export class CloudFieldStorage {
  private readonly basis: BakedField;
  private readonly shape: BakedField;

  public constructor(
    name: string,
    projection: FieldProjection,
    basisAt: (direction: Vec3Node) => Vec4Node,
    shapeAt: (direction: Vec3Node) => Vec4Node,
    pass: GpuPassId,
  ) {
    this.basis = new BakedField(
      `${name}Basis`, THREE.RGBAFormat, projection, basisAt, pass,
    );
    this.shape = new BakedField(`${name}Shape`, THREE.RGFormat, projection, shapeAt, pass);
  }

  public get basisTexture(): THREE.Texture { return this.basis.texture; }
  public get shapeTexture(): THREE.Texture { return this.shape.texture; }

  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    this.basis.render(renderer, gpu);
    this.shape.render(renderer, gpu);
  }

  public sample(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexels(this.basis.at(direction), this.shape.at(direction));
  }

  public dispose(): void {
    this.basis.dispose();
    this.shape.dispose();
  }
}
