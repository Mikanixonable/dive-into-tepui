// 弾本体・弾ハロー・プラズマ弾・薬莢・破片のように geometry/material を全個体で共有する種別を、
// 種別ごとに InstancedMesh 1本へまとめて描くためのプール一式。
import * as THREE from 'three/webgpu';
import { InstancedPool } from '../instanced-pool';
import {
  bulletBodyResources, bulletHaloResources, plasmaBodyResources, casingBodyResources,
  debrisFragmentResources,
} from './ships';

export class InstancedPools {
  private readonly bulletBody: InstancedPool;
  private readonly bulletHalo: InstancedPool;
  private readonly plasma: InstancedPool;
  private readonly casing: InstancedPool;
  // 破片(fragment)はバリアントごとに geometry が異なるため、バリアント数だけプールを持つ。
  private readonly debrisFragments: readonly InstancedPool[];

  // 種別ごとに、1フレームで積める上限の数だけインスタンスを確保する。
  public constructor(
    scene: THREE.Scene,
    bulletCapacity: number,
    casingCapacity: number,
    debrisCapacity: number,
  ) {
    // 弾・薬莢・破片が共有する描画資源。
    const bulletBody = bulletBodyResources();
    const bulletHalo = bulletHaloResources();
    const plasmaBody = plasmaBodyResources();
    const casingBody = casingBodyResources();
    const debrisFragment = debrisFragmentResources();
    this.bulletBody = new InstancedPool(scene, bulletBody.geometry, bulletBody.material, bulletCapacity);
    this.bulletHalo = new InstancedPool(scene, bulletHalo.geometry, bulletHalo.material, bulletCapacity);
    this.plasma = new InstancedPool(scene, plasmaBody.geometry, plasmaBody.material, bulletCapacity);
    this.casing = new InstancedPool(
      scene, casingBody.geometry, casingBody.material, casingCapacity, false, 0, true);
    this.debrisFragments = debrisFragment.geometries.map(
      (geo) => new InstancedPool(scene, geo, debrisFragment.material, debrisCapacity, true, 0, true));
  }

  // このフレームぶんを積み始める。積む前に1度だけ呼ぶ。
  public beginFrame(): void {
    this.bulletBody.beginFrame();
    this.bulletHalo.beginFrame();
    this.plasma.beginFrame();
    this.casing.beginFrame();
    for (const pool of this.debrisFragments) pool.beginFrame();
  }

  // このフレームぶんを積み終える。積み終えたら1度だけ呼ぶ。
  public endFrame(): void {
    this.bulletBody.endFrame();
    this.bulletHalo.endFrame();
    this.plasma.endFrame();
    this.casing.endFrame();
    for (const pool of this.debrisFragments) pool.endFrame();
  }

  public pushBulletBody(renderObject: THREE.Object3D): void { this.bulletBody.push(renderObject); }
  public pushBulletHalo(renderObject: THREE.Object3D): void { this.bulletHalo.push(renderObject); }
  public pushPlasma(renderObject: THREE.Object3D): void { this.plasma.push(renderObject); }
  public pushCasing(renderObject: THREE.Object3D): void { this.casing.push(renderObject); }

  // variant はどのバリアントジオメトリで描くか、color は個体ごとの色。
  public pushDebrisFragment(variant: number, renderObject: THREE.Object3D, color: THREE.Color): void {
    this.debrisFragments[variant]!.push(renderObject, color);
  }

  // 全プールの InstancedMesh と、それが握っている描画資源を解放する。
  public dispose(): void {
    this.bulletBody.dispose();
    this.bulletHalo.dispose();
    this.plasma.dispose();
    this.casing.dispose();
    for (const pool of this.debrisFragments) pool.dispose();
  }
}
