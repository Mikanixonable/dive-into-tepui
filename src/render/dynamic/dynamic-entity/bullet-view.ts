// 自機弾・敵プラズマ弾の表示と、全弾が共有する描画資源とプール。
import * as THREE from 'three/webgpu';
import { InstancedPool } from '../../instanced-pool';
import { orientProjectile } from '../../projectile-orientation';
import { memoParseShared } from '../baked-model';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import bulletData from '../../../assets/models/bullet.json';
import plasmaData from '../../../assets/models/plasma.json';
import type { InstancedPoolSet } from '../instanced-pools';
import type { KinematicState } from '../../../physics/kinematic-state';

const ENEMY_PLASMA_COLOR = '#ff3333'; // 蛍光色の赤

const parseBullet = memoParseShared<THREE.Mesh>(bulletData);
const parsePlasma = memoParseShared<THREE.Mesh>(plasmaData);

// 自機弾の光芒(半透明の加算合成ハロー)。全弾で1組を共有する。
let bulletHalo: { readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material } | null = null;

// 全弾が共有する本体の geometry/material を返す。
function bulletBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const m = parseBullet();
  return { geometry: m.geometry, material: m.material as THREE.Material };
}

// 全弾が共有するハローの geometry/material を返す。初回に生成する。
function bulletHaloResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  if (bulletHalo === null) {
    const geometry = new THREE.CylinderGeometry(0.5, 0.5, 7, 8);
    geometry.rotateX(Math.PI / 2); // 進行方向(Z軸)に合わせる
    const material = new THREE.MeshBasicMaterial({
      // 明るさは色に載せ、不透明度は 1 のままにする(render/billboard.ts と同じ規約)。
      color: new THREE.Color(0xffc86e).multiplyScalar(0.35),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    bulletHalo = { geometry, material };
  }
  return bulletHalo;
}

// 自機弾のメッシュを、子の 0 番を本体、1 番をハローとして組み立てる。geometry/material は全弾の共有物。
function buildBulletMesh(): THREE.Group {
  const halo = bulletHaloResources();
  const g = new THREE.Group();
  g.add(parseBullet());
  g.add(new THREE.Mesh(halo.geometry, halo.material));
  return g;
}

let plasmaBodyMat: THREE.MeshBasicMaterial | null = null;

// 敵プラズマ弾のメッシュ(本体のみ)を組み立てる。マテリアルは全弾で1つを共有する。
function buildPlasmaMesh(): THREE.Mesh {
  const m = parsePlasma();
  // 焼いた頂点は長さ軸が既に +Z を向いている。ここで rotateX() すると二重に回る。
  if (!plasmaBodyMat) {
    plasmaBodyMat = new THREE.MeshBasicMaterial({
      color: ENEMY_PLASMA_COLOR,
      transparent: false,
      opacity: 1.0,
      depthWrite: true,
      blending: THREE.NormalBlending,
    });
  }
  m.material = plasmaBodyMat;

  // スケールを大きくして視認性を上げる
  m.scale.set(1.5, 1.5, 1.5);

  return m;
}

// 全プラズマ弾が共有する本体の geometry/material を返す。
function plasmaBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const m = buildPlasmaMesh();
  return { geometry: m.geometry, material: m.material as THREE.Material };
}

// 自機弾の本体・ハローと敵プラズマ弾を、それぞれ1本の InstancedMesh へ積むプールの束。
export class BulletPools implements InstancedPoolSet {
  private readonly body: InstancedPool;
  private readonly halo: InstancedPool;
  private readonly plasma: InstancedPool;

  // 1フレームに積める弾の数 capacity だけ、各プールの枠を確保する。
  public constructor(scene: THREE.Scene, capacity: number) {
    const body = bulletBodyResources();
    const halo = bulletHaloResources();
    const plasma = plasmaBodyResources();
    this.body = new InstancedPool(scene, body.geometry, body.material, capacity);
    this.halo = new InstancedPool(scene, halo.geometry, halo.material, capacity);
    this.plasma = new InstancedPool(scene, plasma.geometry, plasma.material, capacity);
  }

  // このフレームぶんを3本のプールへ積み始める。
  public beginFrame(): void {
    this.body.beginFrame();
    this.halo.beginFrame();
    this.plasma.beginFrame();
  }

  // このフレームぶんを3本のプールへ積み終える。
  public endFrame(): void {
    this.body.endFrame();
    this.halo.endFrame();
    this.plasma.endFrame();
  }

  // 3本のプールの InstancedMesh を解放する。
  public dispose(): void {
    this.body.dispose();
    this.halo.dispose();
    this.plasma.dispose();
  }

  // 自機弾の本体とハローを、それぞれのプールへ積む。
  public pushNormal(body: THREE.Object3D, halo: THREE.Object3D): void {
    this.body.push(body);
    this.halo.push(halo);
  }

  // 敵プラズマ弾の本体を積む。
  public pushPlasma(plasma: THREE.Object3D): void {
    this.plasma.push(plasma);
  }
}

abstract class ProjectileView extends DynamicView {
  private readonly orientation = new THREE.Quaternion();

  // object を、プールへ積む変換の担い手として持つ。
  protected constructor(object: THREE.Object3D) {
    super(object, undefined, false);
  }

  // 表示時刻の速度へ機首を向け、画面に出るフレームだけプールへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    if (displayed !== null
      && orientProjectile(this.orientation, viewFrame.camera.floatingOrigin.VtoThreeV3(displayed.v))) {
      this.object.quaternion.copy(this.orientation);
    }
    if (!this.object.visible) return;
    this.pushToPool(viewFrame.pools.get(BulletPools));
  }

  // 自分の変換で、種別の共有描画資源をプールへ積む。
  protected abstract pushToPool(pools: BulletPools): void;
}

export class NormalBulletView extends ProjectileView {
  // 本体とハローを子に持つ自機弾を組み立てる。
  public constructor() {
    super(buildBulletMesh());
  }

  // 本体とハローを、それぞれのプールへ積む。
  protected override pushToPool(pools: BulletPools): void {
    this.object.updateMatrixWorld();
    pools.pushNormal(this.object.children[0]!, this.object.children[1]!);
  }
}

export class PlasmaBulletView extends ProjectileView {
  // 敵プラズマ弾を組み立てる。
  public constructor() {
    super(buildPlasmaMesh());
  }

  // 本体をプラズマ弾のプールへ積む。
  protected override pushToPool(pools: BulletPools): void {
    pools.pushPlasma(this.object);
  }
}
