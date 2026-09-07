// 弾本体・弾ハロー・プラズマ弾・薬莢・破片のように geometry/material を全個体で共有する種別を、
// 種別ごとに InstancedMesh 1本へまとめて描くためのプール一式。個体は毎フレーム、自分の sync の
// 中で同期し終えた変換をここへ積む。
import * as THREE from 'three/webgpu';
import { InstancedPool } from '../../../render/instanced-pool';
import {
  bulletBodyResources, bulletHaloResources, plasmaBodyResources, casingBodyResources,
  debrisFragmentResources,
} from '../../../render/ships';
import { ENTITY_CAP } from './entity-kind';

export class InstancedPools {
  private readonly bulletBody: InstancedPool;
  private readonly bulletHalo: InstancedPool;
  private readonly plasma: InstancedPool;
  private readonly casing: InstancedPool;
  // 破片(fragment)はバリアントごとに geometry が異なるため、バリアント数だけプールを持つ。
  private readonly debrisFragments: readonly InstancedPool[];

  // 枠ごとの上限をそのままプールの容量にする。上限を超えた個体は顔ぶれから落ちるので、
  // 同時に積まれうる数はその枠を超えない。
  constructor(scene: THREE.Scene) {
    // 弾・薬莢・破片が共有する描画資源。
    const bulletBody = bulletBodyResources();
    const bulletHalo = bulletHaloResources();
    const plasmaBody = plasmaBodyResources();
    const casingBody = casingBodyResources();
    const debrisFragment = debrisFragmentResources();
    this.bulletBody = new InstancedPool(scene, bulletBody.geometry, bulletBody.material, ENTITY_CAP.bullet);
    this.bulletHalo = new InstancedPool(scene, bulletHalo.geometry, bulletHalo.material, ENTITY_CAP.bullet);
    this.plasma = new InstancedPool(scene, plasmaBody.geometry, plasmaBody.material, ENTITY_CAP.bullet);
    this.casing = new InstancedPool(
      scene, casingBody.geometry, casingBody.material, ENTITY_CAP.casing, false, 0, true);
    this.debrisFragments = debrisFragment.geometries.map(
      (geo) => new InstancedPool(scene, geo, debrisFragment.material, ENTITY_CAP.debris, true, 0, true));
  }

  // このフレームぶんを積み始める。積む前に1度だけ呼ぶ。
  beginFrame(): void {
    this.bulletBody.beginFrame();
    this.bulletHalo.beginFrame();
    this.plasma.beginFrame();
    this.casing.beginFrame();
    for (const pool of this.debrisFragments) pool.beginFrame();
  }

  // このフレームぶんを積み終える。積み終えたら1度だけ呼ぶ。
  endFrame(): void {
    this.bulletBody.endFrame();
    this.bulletHalo.endFrame();
    this.plasma.endFrame();
    this.casing.endFrame();
    for (const pool of this.debrisFragments) pool.endFrame();
  }

  pushBulletBody(renderObject: THREE.Object3D): void { this.bulletBody.push(renderObject); }
  pushBulletHalo(renderObject: THREE.Object3D): void { this.bulletHalo.push(renderObject); }
  pushPlasma(renderObject: THREE.Object3D): void { this.plasma.push(renderObject); }
  pushCasing(renderObject: THREE.Object3D): void { this.casing.push(renderObject); }

  // variant はどのバリアントジオメトリで描くか、color は個体ごとの色。
  pushDebrisFragment(variant: number, renderObject: THREE.Object3D, color: THREE.Color): void {
    this.debrisFragments[variant]!.push(renderObject, color);
  }

  // 全プールの InstancedMesh と、それが握っている描画資源を解放する。
  dispose(): void {
    this.bulletBody.dispose();
    this.bulletHalo.dispose();
    this.plasma.dispose();
    this.casing.dispose();
    for (const pool of this.debrisFragments) pool.dispose();
  }
}
