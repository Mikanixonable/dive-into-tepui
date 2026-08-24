// 恒星の直射光を遮るメッシュ(艦艇・基地・デブリなど)を、恒星方向を向いた平行投影のライト空間へ
// 描き、線形深度をスロットごとの深度マップへ書く。
//
// **スロットは視錐台の深度分割ではなく、遮蔽器の塊 1 つずつへ割り当てる。** 塊どうしは重なりうる。
//
// TODO: 重なりの中に居る受け手は、入っている最初のスロットしか引かないので片方の遮蔽器を
// 取りこぼす。仕様に根拠が無い。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { clamp, positionView, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { metersPerPixelAtDepth } from '../../physics/projection';
import { apparentSizePx } from '../screen-lod';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Uniform } from '../tsl-types';
import { SUN_SHADOW_CASTER_LAYER } from './lit-layer';
import type { SunLight } from './sun-light';

export const SHADOW_SLOT_SIZE = 1024;
export const SHADOW_SLOT_COUNT = 4;

// 遮蔽器の外接球へ対して平行投影の枠をどれだけ広げるか。ライトカメラの向きによって箱の
// 見かけが回るので、外接球ぶんの余裕が要る。
const SLOT_MARGIN = 1.05;

// 画面上でこの直径 [px] を下回る遮蔽器は捨てる。ここを下回ると影の構造が画面側でも見えず、
// スロットを 1 枚使う価値が無い。**太陽系全体を見る視点で塊が 0 個になるのはこの足切り。**
const MIN_CASTER_PX = 4;

// 大量の個体を 1 本のメッシュで描く枝が、自分の広がりを影パスへ渡す口。個体が毎フレーム動く枝は
// メッシュ自身の外接箱が当てにならないので、userData.sunShadowExtent にこれを置く。
export type SunShadowExtent = {
  // 今フレームの全個体を包む描画座標の AABB。
  readonly worldBounds: THREE.Box3;
  // 個体 1 つぶんの差し渡し [m]。見かけの大きさはこちらで測る。
  readonly instanceWorldSize: number;
};

// スロット 1 枚ぶんの、受け手が引く値。SunOcclusion がこれを読んでグラフを組む。
export type SunShadowSlot = {
  // このスロットの深度マップ。
  readonly texture: THREE.Texture;
  // 描画座標 → ライト空間クリップ。UV は xy だけを使う。
  readonly lightViewProjection: Mat4Uniform;
  // 描画座標 → ライト空間 view。深度は射影の規約(反転深度)に依らないこちらから測る。
  readonly lightView: Mat4Uniform;
  readonly near: FloatUniform;
  readonly far: FloatUniform;
  // このスロットが覆う描画座標の AABB。受け手はこの外なら遮蔽を引かない。
  readonly boundsMin: Vec3Uniform;
  readonly boundsMax: Vec3Uniform;
  // 1 texel が描画座標で何メートルか。バイアスとフィルタ半径の単位になる。
  readonly texelWorld: FloatUniform;
  // 0 ならこのスロットは空。
  readonly active: FloatUniform;
};

// このフレームに 1 スロットぶんとしてまとめた遮蔽器。roots はスロットを描くとき以外を
// 一時的に隠すために持つ。
type Cluster = {
  readonly box: THREE.Box3;
  readonly roots: THREE.Object3D[];
};

// シーン直下の 1 単位ぶんの遮蔽器(艦 1 隻・基地 1 つ・インスタンスプール 1 本)。
type Caster = {
  readonly root: THREE.Object3D;
  readonly box: THREE.Box3;
  // その枝が持つ単一個体の差し渡し [m]。艦や基地は枝ぜんたいで 1 個体なので箱の対角に等しい。
  readonly individualSize: number;
  // 単一個体の見かけの直径 [px]。
  readonly apparentPx: number;
};

export class SunShadowMaps {
  private readonly targets: readonly THREE.RenderTarget[];
  private readonly depthMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly slotUniforms: readonly SunShadowSlot[];
  // 深度マテリアルが読む near/far。スロットを 1 枚ずつ描くので、その都度書き換える。
  private readonly drawNear: FloatUniform;
  private readonly drawFar: FloatUniform;
  private readonly casters: Caster[] = [];
  // collectCasters が枝ごとに拾う、その枝の単一個体の差し渡し [m](0 なら見つからなかった)。
  private branchInstanceSize = 0;
  private readonly clusters: Cluster[] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly scratchBox = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly cameraToTarget = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();
  // 前フレームに中身を書いたスロットの数。塊が 0 個になったフレームで 1 度だけ空へ戻すために持つ
  // — 戻さないと、デバッグ表示「影」に前フレームの深度マップが残って読み手を欺く。
  private drawnSlots = 0;

  // スロット 4 枚ぶんの深度マップと、そこへライト空間の線形深度を書く override マテリアルを組む。
  constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    this.targets = Array.from({ length: SHADOW_SLOT_COUNT }, (_slot, index) => {
      // r32float はレンダーターゲットとしては描けるがフィルタできない。**サンプラを明示して
      // おかないと three が線形フィルタを要求し、パイプライン生成が落ちて画面が丸ごと黒くなる。**
      const target = new THREE.RenderTarget(SHADOW_SLOT_SIZE, SHADOW_SLOT_SIZE, {
        format: THREE.RedFormat, type: THREE.FloatType, depthBuffer: true, samples: 0,
        magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
      });
      target.texture.name = `sun-shadow-${index}`;
      target.depthTexture = new THREE.DepthTexture(SHADOW_SLOT_SIZE, SHADOW_SLOT_SIZE, THREE.FloatType);
      return target;
    });

    this.drawNear = uniform(0.1);
    this.drawFar = uniform(10);
    this.slotUniforms = this.targets.map((target) => ({
      texture: target.texture,
      lightViewProjection: uniform(new THREE.Matrix4()),
      lightView: uniform(new THREE.Matrix4()),
      near: uniform(0.1),
      far: uniform(10),
      boundsMin: uniform(new THREE.Vector3()),
      boundsMax: uniform(new THREE.Vector3()),
      texelWorld: uniform(1),
      active: uniform(0),
    }));

    const linearDepth: FloatNode = clamp(
      positionView.z.negate().sub(this.drawNear).div(this.drawFar.sub(this.drawNear)), 0, 1,
    );
    this.depthMaterial = new MeshBasicNodeMaterial({
      depthTest: true, depthWrite: true, transparent: false,
      blending: THREE.NoBlending, side: THREE.DoubleSide,
    });
    this.depthMaterial.colorNode = vec4(vec3(linearDepth), 1);
  }

  get slots(): readonly SunShadowSlot[] { return this.slotUniforms; }

  // 遮蔽器を塊へまとめ、塊ごとに 1 スロットを描く。enabled が偽か、どの遮蔽器も画面上
  // MIN_CASTER_PX に満たないフレームは、GPU 側の仕事がまったく発生しない。
  render(
    scene: THREE.Scene, camera: THREE.Camera, viewportHeight: number, sun: SunLight, enabled: boolean,
  ): void {
    for (const slot of this.slotUniforms) slot.active.value = 0;
    this.clusters.length = 0;
    if (enabled) {
      // 遮蔽器の箱は親の変換込みで測る必要がある。**Box3.expandByObject は親の行列を更新しない**
      // ので、このパスがフレームの先頭で走る限り、ここで確定させないと箱が前フレームの位置で作られる。
      scene.updateMatrixWorld();
      this.collectCasters(scene, camera, viewportHeight);
      this.buildClusters(camera, viewportHeight);
    }
    if (this.clusters.length === 0 && this.drawnSlots === 0) return;

    const savedOverride = scene.overrideMaterial;
    const savedTarget = this.renderer.getRenderTarget();
    const savedAutoClear = this.renderer.autoClear;
    const savedClearColor = this.renderer.getClearColor(this.clearColor).clone();
    const savedClearAlpha = this.renderer.getClearAlpha();
    try {
      this.renderer.autoClear = true;
      scene.overrideMaterial = this.depthMaterial;
      this.lightCamera.layers.set(SUN_SHADOW_CASTER_LAYER);
      // 空の texel は「最も遠い」= 1 で埋める。遮蔽器の居ない範囲が影にならないための初期値。
      this.renderer.setClearColor(0xffffff, 1);
      // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
      this.gpu.beginPass(GPU_PASS.shadow);
      for (const [index, cluster] of this.clusters.entries()) this.drawSlot(scene, sun, index, cluster);
      // 前フレームに使っていて今フレームは使わないスロットを空へ戻す。
      for (let index = this.clusters.length; index < this.drawnSlots; index++) {
        this.renderer.setRenderTarget(this.targets[index]!);
        this.renderer.clear(true, true, false);
      }
      this.drawnSlots = this.clusters.length;
    } finally {
      scene.overrideMaterial = savedOverride;
      this.renderer.setRenderTarget(savedTarget);
      this.renderer.autoClear = savedAutoClear;
      this.renderer.setClearColor(savedClearColor, savedClearAlpha);
      this.showHidden();
    }
  }

  // 塊 1 つをスロット index へ描く。**塊に属さない遮蔽器は visible を一時的に落として外す** —
  // 層は塊ごとに用意できず、InstancedMesh.count を絞ると以後まったく描かれなくなる。
  private drawSlot(scene: THREE.Scene, sun: SunLight, index: number, cluster: Cluster): void {
    const slot = this.slotUniforms[index]!;
    if (!this.configureSlot(slot, cluster.box, sun)) return;
    // この塊に属さない遮蔽器を退避する。
    for (const caster of this.casters) {
      if (cluster.roots.includes(caster.root)) continue;
      caster.root.visible = false;
      this.hidden.push(caster.root);
    }
    // 深度マテリアルはスロット共有なので、正規化に使う near/far をこのスロットのものへ差し替える。
    this.drawNear.value = slot.near.value;
    this.drawFar.value = slot.far.value;
    this.renderer.setRenderTarget(this.targets[index]!);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, this.lightCamera);
    slot.active.value = 1;
    this.showHidden();
  }

  // drawSlot が退避した遮蔽器を元へ戻す。スロットを描くたびに必ず対で呼ぶ。
  private showHidden(): void {
    for (const root of this.hidden) root.visible = true;
    this.hidden.length = 0;
  }

  // シーン直下の枝ごとに、SUN_SHADOW_CASTER_LAYER のメッシュを包む描画座標の AABB を作る。
  // 艦 1 隻・基地 1 つ・インスタンスプール 1 本がそれぞれ 1 単位になる。
  //
  // **層を見るだけでは足りず、Mesh であることまで見る。** シーンルートは全チャンネルを持つ
  // (レンダラがカメラのチャンネルを絞る間も子を辿れるようにするため)ので、層だけで拾うと
  // ルートに当たり、Box3.expandByObject が子を再帰して天体ごと箱に入れてしまう。
  private collectCasters(scene: THREE.Scene, camera: THREE.Camera, viewportHeight: number): void {
    this.casters.length = 0;
    for (const root of scene.children) {
      if (!root.visible) continue;
      this.scratchBox.makeEmpty();
      this.branchInstanceSize = 0;
      this.expandVisibleCasters(root);
      if (this.scratchBox.isEmpty()) continue;
      const box = this.scratchBox.clone();
      box.getSize(this.size);
      box.getCenter(this.center);
      // **見かけは箱の対角ではなく単一個体で測る。** 散らばった小片の雲は、箱で測ると常に最大の
      // 遮蔽器として先頭へ来てしまい、実際には影を何も落とせないままスロットを奪う。
      const individualSize = this.branchInstanceSize > 0 ? this.branchInstanceSize : this.size.length();
      const mpp = this.metersPerPixelAt(camera, viewportHeight, this.center);
      this.casters.push({ root, box, individualSize, apparentPx: apparentSizePx(individualSize, mpp) });
    }
    // 大きく写るものから順に塊を起こす。小さいものは枠が尽きた時点で捨ててよい。
    this.casters.sort((a, b) => b.apparentPx - a.apparentPx);
  }

  // 見えている枝だけを辿って scratchBox を広げる。traverse は visible を見ずに全体を辿るので、
  // 隠した艦が影だけ落とし続ける — レンダラ自身の走査と同じく、見えない枝はそこで打ち切る。
  private expandVisibleCasters(object: THREE.Object3D): void {
    if (!object.visible) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(SUN_SHADOW_CASTER_LAYER)) {
      const extent = mesh.userData.sunShadowExtent as SunShadowExtent | undefined;
      if (extent === undefined) {
        this.scratchBox.expandByObject(mesh);
      } else if (!extent.worldBounds.isEmpty()) {
        this.scratchBox.union(extent.worldBounds);
        this.branchInstanceSize = Math.max(this.branchInstanceSize, extent.instanceWorldSize);
      }
    }
    for (const child of object.children) this.expandVisibleCasters(child);
  }

  // 遮蔽器を塊へまとめる。**広がりの上限は「吸収してよいか」だけを決める** — 上限は
  // 「スロットの遠端で 1 texel/px」を満たす条件、すなわち SHADOW_SLOT_SIZE ×
  // metersPerPixel(塊のカメラ距離)で、カメラ 12m なら 11.8m 角、カメラ 1km なら 983m 角。
  // これを超える吸収を断ることで、近い遮蔽器のために遠い遮蔽器の解像度を落とさずに済む。
  //
  // **単独で上限を超える遮蔽器は、個体が 1 texel を埋められるならそのまま 1 スロットを取る。**
  // 大きな艦へ寄ったときに影が丸ごと消えるのは、粗い影よりはるかに悪い。
  private buildClusters(camera: THREE.Camera, viewportHeight: number): void {
    for (const caster of this.casters) {
      if (caster.apparentPx < MIN_CASTER_PX) break; // 降順なので、以降はすべて小さい
      const absorbed = this.clusters.find((cluster) => {
        this.scratchBox.copy(cluster.box).union(caster.box);
        return this.fitsSlot(camera, viewportHeight, this.scratchBox);
      });
      if (absorbed !== undefined) {
        absorbed.box.union(caster.box);
        absorbed.roots.push(caster.root);
        continue;
      }
      if (this.clusters.length >= SHADOW_SLOT_COUNT) continue;
      if (!this.resolvesInSlot(caster)) continue;
      this.clusters.push({ box: caster.box.clone(), roots: [caster.root] });
    }
  }

  // 1 スロットを与えたとき、その塊の個体が 1 texel 以上を埋めるか。**埋められない塊にスロットを
  // 与えても、深度マップには何も写らないまま 1 枚が消える。**
  private resolvesInSlot(caster: Caster): boolean {
    caster.box.getSize(this.size);
    return caster.individualSize * SHADOW_SLOT_SIZE >= this.size.length();
  }

  // box をスロット 1 枚へ収めても 1 texel/px を保てるか。カメラから遠い塊ほど広く取れる。
  private fitsSlot(camera: THREE.Camera, viewportHeight: number, box: THREE.Box3): boolean {
    box.getSize(this.size);
    box.getCenter(this.center);
    return this.size.length() <= SHADOW_SLOT_SIZE * this.metersPerPixelAt(camera, viewportHeight, this.center);
  }

  // worldPos の位置で画面 1px が描画座標で何メートルにあたるか。平行投影では位置に依らない。
  private metersPerPixelAt(camera: THREE.Camera, viewportHeight: number, worldPos: THREE.Vector3): number {
    const height = Math.max(1, viewportHeight);
    if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / height;
    if (!(camera instanceof THREE.PerspectiveCamera)) return 0;
    camera.getWorldPosition(this.cameraPosition);
    camera.getWorldDirection(this.cameraForward);
    const depth = this.cameraForward.dot(this.cameraToTarget.subVectors(worldPos, this.cameraPosition));
    return metersPerPixelAtDepth(camera.fov, depth, height);
  }

  // 箱へ平行投影のライトカメラを合わせ、スロットの uniform を書く。恒星方向が取れなければ偽。
  private configureSlot(slot: SunShadowSlot, box: THREE.Box3, sun: SunLight): boolean {
    box.getCenter(this.center);
    box.getSize(this.size);
    this.lightDirection.copy(sun.position.value).sub(this.center);
    const distance = this.lightDirection.length();
    if (!(distance > 1e-6) || !Number.isFinite(distance)) return false;
    this.lightDirection.multiplyScalar(1 / distance);

    const radius = Math.max(this.size.length() * 0.5, 1);
    const extent = radius * SLOT_MARGIN;
    // カメラは箱の外へ、半径の 2 倍だけ引く。near/far を塊へ密着させるので、深度の分解能は
    // 塊の差し渡しだけで決まる — 983m の塊でも 1cm を分けるのに必要なのは相対精度 1e-5 で、
    // float32 の線形深度には桁が余る。
    const eyeDistance = radius * 2;
    this.lightCamera.left = -extent;
    this.lightCamera.right = extent;
    this.lightCamera.top = extent;
    this.lightCamera.bottom = -extent;
    this.lightCamera.near = eyeDistance - extent;
    this.lightCamera.far = eyeDistance + extent;
    this.lightCamera.position.copy(this.center).addScaledVector(this.lightDirection, eyeDistance);
    // 視線と平行な up は姿勢を決められない。protein-shadow-pass.ts と同じ切り替えで避ける。
    this.lightCamera.up.set(
      Math.abs(this.lightDirection.y) < 0.9 ? 0 : 1,
      Math.abs(this.lightDirection.y) < 0.9 ? 1 : 0,
      0,
    );
    this.lightCamera.lookAt(this.center);
    this.lightCamera.updateProjectionMatrix();
    this.lightCamera.updateMatrixWorld(true);

    slot.near.value = this.lightCamera.near;
    slot.far.value = this.lightCamera.far;
    slot.lightView.value.copy(this.lightCamera.matrixWorldInverse);
    slot.lightViewProjection.value.multiplyMatrices(
      this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse,
    );
    slot.texelWorld.value = (2 * extent) / SHADOW_SLOT_SIZE;
    // 受け手の判定に使う境界は、法線オフセットぶんだけ箱より広く取る — 箱の面ぎりぎりに
    // 居る受け手が、オフセット後に範囲外へ落ちて影を失うのを避ける。
    slot.boundsMin.value.copy(box.min).addScalar(-slot.texelWorld.value * 4);
    slot.boundsMax.value.copy(box.max).addScalar(slot.texelWorld.value * 4);
    return true;
  }

  // 保持している GPU 資源を解放する。
  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.depthMaterial.dispose();
  }
}
