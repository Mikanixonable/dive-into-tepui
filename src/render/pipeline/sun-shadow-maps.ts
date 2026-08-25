// 恒星の直射光を遮るメッシュ(艦艇・基地・デブリなど)を、恒星方向を向いた平行投影のライト空間へ
// 描き、線形深度をスロットごとの深度マップへ書く。
//
// **スロットは視錐台の深度分割ではなく、遮蔽器の塊 1 つずつへ枠を合わせる。** 枠どうしは重なりうる
// ので、**どのスロットも自分の枠に入る遮蔽器をすべて描く** — 受け手はそのうち 1 枚を選ぶだけで
// 答えが得られる。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { positionView, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { castsOnto, extentForTexel, requiredTexel } from '../shadow-demand';
import type { FloatNode, FloatUniform, Mat4Uniform } from '../tsl-types';
import { SUN_SHADOW_CASTER_LAYER } from './lit-layer';
import type { SunLight } from './sun-light';

export const SHADOW_SLOT_SIZE = 1024;
export const SHADOW_SLOT_COUNT = 4;

// 枠の縁へ取る余白 [texel]。受け手を法線方向へずらす量と PCF の半径ぶんあれば、選ばれた
// スロットのフィルタの足が枠からはみ出さない。
const SLOT_MARGIN_TEXELS = 10;

// 柱の長さを枠の 1 辺の何倍に取るか。差し渡し S の遮蔽器の本影は太陽の視半径から
// S/(2·4.65e-3) = 107.5·S で消えるので、それより遠くを覆っても影は残っていない。
// **この打ち切りが深度の値域も K·S へ抑える** — 深度の数値精度はここから従属して決まる。
const COLUMN_SPAN = 110;

// 遮蔽器が 1 つも写らなかった texel を埋める深度 [m]。**受け手のライト空間深度がこれを超える
// ことはない**ので、受け手はそのまま「自分より奥に遮蔽器が居る = 遮られていない」と読める。
// 正規化した深度で空を 1.0 と表すと、枠の far より遠い受け手を区別できない。
const EMPTY_DEPTH = 1e30;

// 大量の個体を 1 本のメッシュで描く枝が、自分の広がりを影パスへ渡す口。個体が毎フレーム動く枝は
// メッシュ自身の外接箱が当てにならないので、userData.sunShadowExtent にこれを置く。
export type SunShadowExtent = {
  // 今フレームの全個体を包む描画座標の AABB。
  readonly worldBounds: THREE.Box3;
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
  // near から測った柱の長さ [m]。受け手は枠の中でこれより手前に居れば遮蔽を引ける。
  readonly coverDepth: FloatUniform;
  // 1 texel が描画座標で何メートルか。バイアスとフィルタ半径の単位になる。
  readonly texelWorld: FloatUniform;
  // 0 ならこのスロットは空。
  readonly active: FloatUniform;
};

// シーン直下の 1 単位ぶんの遮蔽器(艦 1 隻・基地 1 つ・インスタンスプール 1 本)。**遮蔽器で
// あると同時に受け手の代理でもある** — 艦も基地もデブリも、影を落とすと同時に受ける。
type Caster = {
  readonly box: THREE.Box3;
  readonly center: THREE.Vector3;
  // 箱の外接球の半径 [m]。柱の判定と要求精度をこれで測る。
  readonly radius: number;
  // 受け手としての要求 texel [m]。**Infinity なら枠は要らない** — 画面に写らないか、
  // 誰の影も落ちてこない。
  requiredTexel: number;
};

export class SunShadowMaps {
  private readonly targets: readonly THREE.RenderTarget[];
  private readonly depthMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lightCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly slotUniforms: readonly SunShadowSlot[];
  // 深度マテリアルが引く、いま描いているスロットの near。深度はここからのメートルで書く。
  private readonly drawNear: FloatUniform;
  private readonly casters: Caster[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly boundingSphere = new THREE.Sphere();
  private readonly lightForward = new THREE.Vector3();
  // このフレームにスロットを与えた塊の枠(描画座標の AABB)。
  private readonly clusters: THREE.Box3[] = [];
  // 枠を起こした受け手が許す枠の 1 辺 [m]。枠を広げてよいかの上限になる。
  private readonly seedLimits: number[] = [];
  private readonly scratchBox = new THREE.Box3();
  private readonly scratchCorner = new THREE.Vector3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();
  private readonly emptyDepth = new THREE.Color().setScalar(EMPTY_DEPTH);
  // 前フレームに中身を書いたスロットの数。使わなくなったスロットを 1 度だけ空へ戻すために持つ
  // — 戻さないと、デバッグ表示「影」に前フレームの深度マップが残って読み手を欺く。**確保直後の
  // 深度マップはゼロ埋めなので、初回も空へ戻す対象に入れる。**
  private drawnSlots = SHADOW_SLOT_COUNT;

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
    this.slotUniforms = this.targets.map((target) => ({
      texture: target.texture,
      lightViewProjection: uniform(new THREE.Matrix4()),
      lightView: uniform(new THREE.Matrix4()),
      near: uniform(0.1),
      far: uniform(10),
      coverDepth: uniform(1),
      texelWorld: uniform(1),
      active: uniform(0),
    }));

    // near からのメートルで書く。**正規化しない** — 空の texel を EMPTY_DEPTH で埋めることで、
    // 枠の far より遠い受け手も「遮蔽器が居ない」を区別して読めるようにする。
    const linearDepth: FloatNode = positionView.z.negate().sub(this.drawNear);
    this.depthMaterial = new MeshBasicNodeMaterial({
      depthTest: true, depthWrite: true, transparent: false,
      blending: THREE.NoBlending, side: THREE.DoubleSide,
    });
    this.depthMaterial.colorNode = vec4(vec3(linearDepth), 1);
  }

  get slots(): readonly SunShadowSlot[] { return this.slotUniforms; }

  // 遮蔽器を枠へまとめ、枠ごとに 1 スロットを描く。enabled が偽か、影を要求する受け手が
  // 1 つも無いフレームは、GPU 側の仕事がまったく発生しない。
  render(
    scene: THREE.Scene, camera: THREE.Camera, viewportHeight: number, sun: SunLight, enabled: boolean,
  ): void {
    for (const slot of this.slotUniforms) slot.active.value = 0;
    this.clusters.length = 0;
    this.seedLimits.length = 0;
    if (enabled) {
      // 遮蔽器の箱は親の変換込みで測る必要がある。**Box3.expandByObject は親の行列を更新しない**
      // ので、このパスがフレームの先頭で走る限り、ここで確定させないと箱が前フレームの位置で作られる。
      scene.updateMatrixWorld();
      this.collectCasters(scene, camera, viewportHeight, sun);
      this.buildClusters();
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
      // 遮蔽器の居ない範囲が影にならないよう、空の texel はどの受け手よりも遠い深度で埋める。
      this.renderer.setClearColor(this.emptyDepth, 1);
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
    }
  }

  // 枠 1 つをスロット index へ描く。**枠に入る遮蔽器はすべて描く** — 枠の外は平行投影が落とす。
  private drawSlot(scene: THREE.Scene, sun: SunLight, index: number, box: THREE.Box3): void {
    const slot = this.slotUniforms[index]!;
    if (!this.configureSlot(slot, box, sun)) return;
    // 深度マテリアルはスロット共有なので、深度の原点をこのスロットの near へ差し替える。
    this.drawNear.value = slot.near.value;
    this.renderer.setRenderTarget(this.targets[index]!);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, this.lightCamera);
    slot.active.value = 1;
  }

  // シーン直下の枝ごとに、SUN_SHADOW_CASTER_LAYER のメッシュを包む描画座標の AABB を作る。
  // 艦 1 隻・基地 1 つ・インスタンスプール 1 本がそれぞれ 1 単位になる。
  //
  // **層を見るだけでは足りず、Mesh であることまで見る。** シーンルートは全チャンネルを持つ
  // (レンダラがカメラのチャンネルを絞る間も子を辿れるようにするため)ので、層だけで拾うと
  // ルートに当たり、Box3.expandByObject が子を再帰して天体ごと箱に入れてしまう。
  private collectCasters(
    scene: THREE.Scene, camera: THREE.Camera, viewportHeight: number, sun: SunLight,
  ): void {
    this.casters.length = 0;
    for (const root of scene.children) {
      if (!root.visible) continue;
      this.scratchBox.makeEmpty();
      this.expandVisibleCasters(root);
      if (this.scratchBox.isEmpty()) continue;
      const box = this.scratchBox.clone();
      box.getBoundingSphere(this.boundingSphere);
      this.casters.push({
        box,
        center: this.boundingSphere.center.clone(),
        radius: this.boundingSphere.radius,
        requiredTexel: Infinity,
      });
    }
    this.scoreCasters(camera, viewportHeight, sun);
    // 要求が厳しい(= texel が細かい)ものから枠を起こす。
    this.casters.sort((a, b) => a.requiredTexel - b.requiredTexel);
  }

  // 遮蔽器を受け手として見たときの要求 texel を書き込む。**画面に写らない受け手と、誰の影も
  // 落ちてこない受け手は要求を持たない** — 枠を 1 枚使う理由が無い。
  private scoreCasters(camera: THREE.Camera, viewportHeight: number, sun: SunLight): void {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    camera.getWorldPosition(this.cameraPosition);
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    for (const receiver of this.casters) {
      this.boundingSphere.set(receiver.center, receiver.radius);
      if (!this.frustum.intersectsSphere(this.boundingSphere)) continue;
      if (!this.casters.some((caster) => this.castsOnto(caster, receiver, sun))) continue;
      receiver.requiredTexel = requiredTexel(
        this.cameraPosition.distanceTo(receiver.center), receiver.radius,
        camera.near, camera.fov, viewportHeight,
      );
    }
  }

  // caster の影が receiver へ届くか。光の向きは遮蔽器ごとに取り直す — 恒星は点光源なので、
  // 共通の向きで代用すると重心から離れた遮蔽器の柱が逸れる。
  private castsOnto(caster: Caster, receiver: Caster, sun: SunLight): boolean {
    this.lightForward.copy(caster.center).sub(sun.position.value);
    const distance = this.lightForward.length();
    if (!(distance > 1e-6)) return false;
    this.lightForward.multiplyScalar(1 / distance);
    return castsOnto(
      receiver.center.x - caster.center.x, receiver.center.y - caster.center.y,
      receiver.center.z - caster.center.z, caster.radius, receiver.radius,
      this.lightForward.x, this.lightForward.y, this.lightForward.z, COLUMN_SPAN,
    );
  }

  // 見えている枝だけを辿って scratchBox を広げる。traverse は visible を見ずに全体を辿るので、
  // 隠した艦が影だけ落とし続ける — レンダラ自身の走査と同じく、見えない枝はそこで打ち切る。
  private expandVisibleCasters(object: THREE.Object3D): void {
    if (!object.visible) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.layers.isEnabled(SUN_SHADOW_CASTER_LAYER)) {
      const extent = mesh.userData.sunShadowExtent as SunShadowExtent | undefined;
      if (extent === undefined) this.scratchBox.expandByObject(mesh);
      else if (!extent.worldBounds.isEmpty()) this.scratchBox.union(extent.worldBounds);
    }
    for (const child of object.children) this.expandVisibleCasters(child);
  }

  // 要求の厳しい受け手から順に枠を起こす。**枠は受け手のまわりに置く** — 影を落とす遮蔽器は
  // 平行投影でちょうどその枠に重なるものなので、枠が受け手を覆えば必要な遮蔽器だけが入る。
  //
  // 既存の枠が覆っていて十分に細かいなら何もしない。覆っていない枠へ足せるのは、**足したあとも
  // その枠を起こした受け手の要求を満たせるとき**だけ。どれも駄目なら新しい枠を起こし、枠が
  // 尽きていればその受け手は諦める(要求の緩い側から捨てられる)。
  private buildClusters(): void {
    for (const receiver of this.casters) {
      if (!Number.isFinite(receiver.requiredTexel)) break; // 昇順なので、以降はすべて要求が無い
      const limit = 2 * extentForTexel(receiver.requiredTexel, SHADOW_SLOT_SIZE);
      // **粗い枠から順に試す。** seedLimits は昇順に積まれるので、後ろの枠ほど要求が緩い。
      // 細かい枠へ足すと、その枠を起こした近くの受け手まで一緒に粗くなる。
      let placed = false;
      for (let index = this.clusters.length - 1; index >= 0; index--) {
        const cluster = this.clusters[index]!;
        this.scratchBox.copy(cluster).union(receiver.box);
        if (this.frameSize(this.scratchBox) > Math.min(limit, this.seedLimits[index]!)) continue;
        cluster.copy(this.scratchBox);
        placed = true;
        break;
      }
      if (placed) continue;
      if (this.clusters.length < SHADOW_SLOT_COUNT) {
        this.seedLimits.push(limit);
        this.clusters.push(receiver.box.clone());
        continue;
      }
      // 枠が尽きた。**最後の 1 枚へ無条件に飲ませる** — 捨てると影がまるごと消え、カメラを
      // 動かすたびに点滅する。最後の枠を起こしたのは残りの中でいちばん要求が緩い受け手なので、
      // 粗くなるのはもともと粗くてよかった側だけで、手前の枠は巻き添えにならない。
      this.clusters[SHADOW_SLOT_COUNT - 1]!.union(receiver.box);
    }
  }

  // いま構えているライトカメラから見た box の枠の半径 [m]。等方な texel を保つため長辺で
  // 揃え、フィルタの足のぶんだけ広げる。
  private frameExtent(box: THREE.Box3): number {
    let half = 0;
    for (let corner = 0; corner < 8; corner++) {
      this.scratchCorner.set(
        (corner & 1) === 0 ? box.min.x : box.max.x,
        (corner & 2) === 0 ? box.min.y : box.max.y,
        (corner & 4) === 0 ? box.min.z : box.max.z,
      ).applyMatrix4(this.lightCamera.matrixWorldInverse);
      half = Math.max(half, Math.abs(this.scratchCorner.x), Math.abs(this.scratchCorner.y));
    }
    return half / (1 - 2 * SLOT_MARGIN_TEXELS / SHADOW_SLOT_SIZE);
  }

  // 箱を 1 枚へ収める枠の 1 辺 [m]。**世界軸ではなく対角で測る** — 計画の段では光の向きが
  // 枠ごとに決まっていないので、どう回っても収まる側へ倒す。
  private frameSize(box: THREE.Box3): number {
    box.getSize(this.size);
    return this.size.length();
  }

  // 箱へ平行投影のライトカメラを合わせ、スロットの uniform を書く。恒星方向が取れなければ偽。
  private configureSlot(slot: SunShadowSlot, box: THREE.Box3, sun: SunLight): boolean {
    box.getCenter(this.center);
    box.getSize(this.size);
    this.lightDirection.copy(sun.position.value).sub(this.center);
    const distance = this.lightDirection.length();
    if (!(distance > 1e-6) || !Number.isFinite(distance)) return false;
    this.lightDirection.multiplyScalar(1 / distance);

    // カメラは箱の外へ、外接球の半径の 2 倍だけ引く。
    const radius = this.size.length() * 0.5;
    const eyeDistance = radius * 2;
    this.lightCamera.position.copy(this.center).addScaledVector(this.lightDirection, eyeDistance);
    // 視線と平行な up は姿勢を決められない。protein-shadow-pass.ts と同じ切り替えで避ける。
    this.lightCamera.up.set(
      Math.abs(this.lightDirection.y) < 0.9 ? 0 : 1,
      Math.abs(this.lightDirection.y) < 0.9 ? 1 : 0,
      0,
    );
    this.lightCamera.lookAt(this.center);
    this.lightCamera.updateMatrixWorld(true);

    // **枠は箱の 8 頂点をライト空間へ射影して測る。** 世界軸の広がりで代用すると、箱がライト
    // 基底に対して回っているぶんだけ枠が足りず、縁の受け手が枠から外れて影を失う。
    const extent = this.frameExtent(box);
    this.lightCamera.left = -extent;
    this.lightCamera.right = extent;
    this.lightCamera.top = extent;
    this.lightCamera.bottom = -extent;

    // **near も far も枠から導出する。** 枠に交わる遮蔽器を光源寄りの端から遠い端まで漏れなく
    // 撮ることで、この 1 枚だけで枠の中の答えが完結する。far は柱の終端で頭打ちにする — その先
    // にある遮蔽器が影を落とす相手は、もうこのスロットの被覆の外に居る。
    const span = COLUMN_SPAN * 2 * extent;
    const depths = this.casterDepthRange(extent);
    if (depths === null) return false;
    this.lightCamera.near = depths.near;
    this.lightCamera.far = Math.min(Math.max(depths.far, eyeDistance + extent), depths.near + span);
    this.lightCamera.updateProjectionMatrix();

    slot.near.value = this.lightCamera.near;
    slot.far.value = this.lightCamera.far;
    slot.coverDepth.value = span;
    slot.lightView.value.copy(this.lightCamera.matrixWorldInverse);
    slot.lightViewProjection.value.multiplyMatrices(
      this.lightCamera.projectionMatrix, this.lightCamera.matrixWorldInverse,
    );
    slot.texelWorld.value = (2 * extent) / SHADOW_SLOT_SIZE;
    return true;
  }

  // いま構えているライトカメラの枠(半径 extent)に uv で交わる遮蔽器の、ライト空間での深度の
  // 範囲。**枠から外れた遮蔽器は影を枠の中へ落とせない**ので数えない。1 つも交わらなければ null。
  private casterDepthRange(extent: number): { readonly near: number; readonly far: number } | null {
    let near = Infinity;
    let far = -Infinity;
    for (const caster of this.casters) {
      let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
      let front = Infinity, back = -Infinity;
      for (let corner = 0; corner < 8; corner++) {
        this.scratchCorner.set(
          (corner & 1) === 0 ? caster.box.min.x : caster.box.max.x,
          (corner & 2) === 0 ? caster.box.min.y : caster.box.max.y,
          (corner & 4) === 0 ? caster.box.min.z : caster.box.max.z,
        ).applyMatrix4(this.lightCamera.matrixWorldInverse);
        left = Math.min(left, this.scratchCorner.x);
        right = Math.max(right, this.scratchCorner.x);
        bottom = Math.min(bottom, this.scratchCorner.y);
        top = Math.max(top, this.scratchCorner.y);
        front = Math.min(front, -this.scratchCorner.z);
        back = Math.max(back, -this.scratchCorner.z);
      }
      if (left > extent || right < -extent || bottom > extent || top < -extent) continue;
      near = Math.min(near, front);
      far = Math.max(far, back);
    }
    return near <= far ? { near, far } : null;
  }

  // 保持している GPU 資源を解放する。
  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.depthMaterial.dispose();
  }
}
