// 恒星の直射光を遮るメッシュ(艦艇・基地・デブリなど)を、恒星方向を向いた平行投影のライト空間へ
// 描き、線形深度をスロットごとの深度マップへ書く。
//
// **スロットは視錐台の深度分割ではなく、遮蔽器の塊 1 つずつへ枠を合わせる。** 枠どうしは重なりうる
// ので、**どのスロットも自分の枠に入る遮蔽器をすべて描く** — 受け手はそのうち 1 つを選ぶだけで
// 答えが得られる。
//
// **1 スロットは深度マップを 2 枚持つ。** 光源にいちばん近いものが勝つ深度テストは 1 枚に 1 つの
// 遮蔽器しか残せないので、枠から見て本影が残る遮蔽器と、本影を失って淡い減光しか残さない
// 遮蔽器を、同じ枠・同じ uv の別の層へ分けて撮る。混ぜると、遠くて淡いものが至近の濃いものを
// 追い出す。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { positionView, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { anchorAxis, castsOnto, extentForTexel, insideBox, requiredTexel } from '../shadow-demand';
import type { FloatNode, FloatUniform, Mat4Uniform } from '../tsl-types';
import { SUN_SHADOW_CASTER_LAYER } from './lit-layer';
import type { SunLight } from './sun-light';

export const SHADOW_SLOT_SIZE = 1024;
export const SHADOW_SLOT_COUNT = 4;

// 枠の縁へ取る余白 [texel]。受け手を法線方向へずらす量と PCF の半径ぶんあれば、選ばれた
// スロットのフィルタの足が枠からはみ出さない。
const SLOT_MARGIN_TEXELS = 10;

// 本影が消えるまでの距離を枠の 1 辺の何倍に取るか。差し渡し S の遮蔽器の本影は太陽の視半径
// θ☉ = 4.65e-3 から D = S/(2·θ☉) = 107.5·S で消え、そこから先の遮蔽率は (107.5·S/D)² で落ちる。
// **枠から見てここより手前に居る遮蔽器は、近層の深度テストへ参加させない**(下の farTargets)。
const UMBRA_SPAN = 107.5;

// 柱の長さを枠の 1 辺の何倍に取るか。UMBRA_SPAN の先も遮蔽率 (107.5·S/D)² は残るので、
// ここまで撮る。打ち切り位置に残る遮蔽率は 1.2 % で、縁は段差にならない。**この打ち切りが
// 深度の値域も K·S へ抑える** — 深度の数値精度はここから従属して決まり、この値でも float32 に
// 24 倍の余裕がある。
const COLUMN_SPAN = 1000;

// 遠層の 1 辺 [texel]。遠層に写る遮蔽器は本影を失っていて、半影の幅は枠の 1 辺以上ある
// (2·θ☉·D ≥ S)。**枠の 1 辺より広くぼけた影に、近層と同じ細かさは要らない。**
const SHADOW_FAR_SLOT_SIZE = 256;

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
  // このスロットの近層の深度マップ。枠から見て本影が残る距離にある遮蔽器だけが写る。
  readonly texture: THREE.Texture;
  // 同じ枠・同じ uv の遠層の深度マップ。本影を失った遮蔽器だけが写る。**近層と写る遮蔽器が
  // 排他なので、2 枚から出した透過率はそのまま掛けられる。**
  readonly farTexture: THREE.Texture;
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
  // 枝の中でカメラにいちばん近い実体の点と、そこまでの距離 [m]。**窓の中心と要求精度はこれで
  // 決める** — 外接箱の最近点は、細長い部材を持つ艦では実体の無い空間を指す。
  readonly anchor: THREE.Vector3;
  readonly anchorDistance: number;
  // 個体が箱いっぱいに散らばる枝(薬莢・破片のプール)か。**実体が箱のどこにあるか名指しできない
  // ので、箱より小さい窓を置いても当たらない** — この枝には窓を作らない。
  readonly diffuse: boolean;
  // 箱の外接球の半径 [m]。柱の判定と要求精度をこれで測る。
  readonly radius: number;
  // 受け手としての要求 texel [m]。**Infinity なら枠は要らない** — 画面に写らないか、
  // 誰の影も落ちてこない。
  requiredTexel: number;
};

// ライト空間の線形深度を書く 1 辺 size のレンダーターゲット。
//
// **r32float はレンダーターゲットとしては描けるがフィルタできない。** サンプラを明示して
// おかないと three が線形フィルタを要求し、パイプライン生成が落ちて画面が丸ごと黒くなる。
function createDepthTarget(size: number, name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(size, size, {
    format: THREE.RedFormat, type: THREE.FloatType, depthBuffer: true, samples: 0,
    magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
  });
  target.texture.name = name;
  target.depthTexture = new THREE.DepthTexture(size, size, THREE.FloatType);
  return target;
}

export class SunShadowMaps {
  private readonly targets: readonly THREE.RenderTarget[];
  private readonly farTargets: readonly THREE.RenderTarget[];
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
  // expandVisibleCasters が枝ごとに拾う、カメラにいちばん近い実体の点とその距離。
  private readonly branchAnchor = new THREE.Vector3();
  private branchDistance = Infinity;
  private branchDiffuse = false;
  // このフレームにスロットを与えた塊の枠(描画座標の AABB)。
  private readonly clusters: THREE.Box3[] = [];
  // 枠の 1 辺 [m]。相乗りの可否をこれで測る — **枠はこの大きさのまま平行移動するだけ。**
  private readonly clusterSizes: number[] = [];
  // 枠の半径の上限 [m]。**被覆の枠は箱ぜんたいを覆う必要があるので上限を持たない**(Infinity)。
  // 細かい窓だけが、要求から決まる半径でここを縛る。
  private readonly clusterCaps: number[] = [];
  private readonly scratchBox = new THREE.Box3();
  private readonly scratchCorner = new THREE.Vector3();
  // measureLightSpaceBox が書く、直前に測った箱のライト空間での範囲。x/y は枠、front/back は
  // 深度で、どちらもメートル。
  private readonly lightSpaceBox = { minX: 0, maxX: 0, minY: 0, maxY: 0, front: 0, back: 0 };
  // いま構えているスロットの、近層と遠層を分ける深度 [m]。ライトカメラの near/far だけを
  // ここで切り替え、スロットの uniform は柱ぜんたいのまま置く。
  private bandSplit = -Infinity;
  private nearBandFar = 0;
  private readonly scratchMatrix = new THREE.Matrix4();
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

  // スロット 4 枚ぶんの近層・遠層の深度マップと、そこへライト空間の線形深度を書く override
  // マテリアルを組む。
  constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    this.targets = Array.from(
      { length: SHADOW_SLOT_COUNT },
      (_slot, index) => createDepthTarget(SHADOW_SLOT_SIZE, `sun-shadow-${index}`),
    );
    this.farTargets = Array.from(
      { length: SHADOW_SLOT_COUNT },
      (_slot, index) => createDepthTarget(SHADOW_FAR_SLOT_SIZE, `sun-shadow-far-${index}`),
    );

    this.drawNear = uniform(0.1);
    this.slotUniforms = this.targets.map((target, index) => ({
      texture: target.texture,
      farTexture: this.farTargets[index]!.texture,
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
    this.clusterSizes.length = 0;
    this.clusterCaps.length = 0;
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
      for (const [index, cluster] of this.clusters.entries()) {
        this.drawSlot(scene, sun, index, cluster, this.clusterCaps[index]!);
      }
      // 前フレームに使っていて今フレームは使わないスロットを空へ戻す。
      for (let index = this.clusters.length; index < this.drawnSlots; index++) {
        for (const target of [this.targets[index]!, this.farTargets[index]!]) {
          this.renderer.setRenderTarget(target);
          this.renderer.clear(true, true, false);
        }
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
  //
  // 撮るのは 2 枚。**本影が残る距離に居る遮蔽器と、本影を失った遮蔽器を、別の深度マップへ分ける**
  // — 1 枚に混ぜると、光源にいちばん近いものが勝つ深度テストで、遠くて淡い遮蔽器が至近の濃い
  // 遮蔽器を追い出してしまう。遠層に写るものが 1 つも無いときは空のまま残す。
  private drawSlot(
    scene: THREE.Scene, sun: SunLight, index: number, box: THREE.Box3, extentCap: number,
  ): void {
    const slot = this.slotUniforms[index]!;
    this.renderer.setRenderTarget(this.farTargets[index]!);
    this.renderer.clear(true, true, false);
    if (!this.configureSlot(slot, box, extentCap, sun)) return;
    // 深度マテリアルはスロット共有なので、深度の原点をこのスロットの near へ差し替える。
    this.drawNear.value = slot.near.value;
    if (this.bandSplit > slot.near.value) {
      this.setLightDepthRange(slot.near.value, this.bandSplit);
      this.renderer.render(scene, this.lightCamera);
    }
    this.setLightDepthRange(Math.max(slot.near.value, this.bandSplit), this.nearBandFar);
    this.renderer.setRenderTarget(this.targets[index]!);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, this.lightCamera);
    slot.active.value = 1;
  }

  // ライトカメラが撮る深度の範囲を差し替える。**枠(left/right/top/bottom)は動かさない** —
  // 平行投影の uv は near/far に依らないので、層を撮り分けても受け手が引く uv は 1 つで足りる。
  private setLightDepthRange(near: number, far: number): void {
    this.lightCamera.near = near;
    this.lightCamera.far = far;
    this.lightCamera.updateProjectionMatrix();
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
    camera.getWorldPosition(this.cameraPosition);
    for (const root of scene.children) {
      if (!root.visible) continue;
      this.scratchBox.makeEmpty();
      this.branchDistance = Infinity;
      this.branchDiffuse = false;
      this.expandVisibleCasters(root);
      if (this.scratchBox.isEmpty()) continue;
      const box = this.scratchBox.clone();
      box.getBoundingSphere(this.boundingSphere);
      this.casters.push({
        box,
        center: this.boundingSphere.center.clone(),
        radius: this.boundingSphere.radius,
        anchor: this.branchAnchor.clone(),
        anchorDistance: this.branchDistance,
        diffuse: this.branchDiffuse,
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
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    for (const receiver of this.casters) {
      this.boundingSphere.set(receiver.center, receiver.radius);
      if (!this.frustum.intersectsSphere(this.boundingSphere)) continue;
      if (!this.casters.some((caster) => this.castsOnto(caster, receiver, sun))) continue;
      // **実体までの距離で測る。** 外接箱までの距離だと、細長い部材を持つ艦はカメラが箱の
      // 内側へ入った時点で 0 へ潰れ、どれも同じ最優先になって順位が付かない。
      receiver.requiredTexel = requiredTexel(
        receiver.anchorDistance, camera.near, camera.fov, viewportHeight,
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
      if (extent === undefined) {
        this.scratchBox.expandByObject(mesh);
        this.takeMeshAnchor(mesh);
      } else if (!extent.worldBounds.isEmpty()) {
        // 個体が箱いっぱいに散らばる枝は、箱の最近点がそのまま実体の在りかになる。
        this.scratchBox.union(extent.worldBounds);
        this.branchDiffuse = true;
        this.takeBoxAnchor(extent.worldBounds, null);
      }
    }
    for (const child of object.children) this.expandVisibleCasters(child);
  }

  // メッシュ 1 本ぶんの実体の在りかを、枝の代表点の候補として拾う。個体が散らばる
  // InstancedMesh は、名指しできる 1 点を持たない枝として branchDiffuse を立てる。
  private takeMeshAnchor(mesh: THREE.Mesh): void {
    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      // 1 個体ぶんの geometry の箱は、どの個体の在りかでもない場所を指す。個体の変換を
      // 数えた箱を使う。
      if (instanced.boundingBox === null) instanced.computeBoundingBox();
      if (instanced.boundingBox === null) return;
      this.branchDiffuse = true;
      this.takeBoxAnchor(instanced.boundingBox, mesh.matrixWorld);
      return;
    }
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox === null) return;
    this.takeBoxAnchor(mesh.geometry.boundingBox, mesh.matrixWorld);
  }

  // box の中でカメラにいちばん近い点を、枝の代表点の候補として拾う。toWorld は box の座標系から
  // 描画座標への変換で、box が既に描画座標なら null を渡す。
  private takeBoxAnchor(box: THREE.Box3, toWorld: THREE.Matrix4 | null): void {
    // カメラを box の座標系へ落として解く。行列 2 回で OBB に対する最近点が出るので、
    // ワールドへ開いた AABB を相手にするより締まる。
    const point = this.scratchCorner.copy(this.cameraPosition);
    if (toWorld !== null) point.applyMatrix4(this.scratchMatrix.copy(toWorld).invert());
    const { min, max } = box;
    const retreat = insideBox(point.x, point.y, point.z, min.x, min.y, min.z, max.x, max.y, max.z);
    point.set(
      anchorAxis(point.x, min.x, max.x, retreat),
      anchorAxis(point.y, min.y, max.y, retreat),
      anchorAxis(point.z, min.z, max.z, retreat),
    );
    if (toWorld !== null) point.applyMatrix4(toWorld);
    this.takeAnchor(point, point.distanceTo(this.cameraPosition));
  }

  // カメラにより近い代表点が来たら、枝の代表点を差し替える。
  private takeAnchor(point: THREE.Vector3, distance: number): void {
    const clamped = Math.max(distance, 0);
    if (clamped >= this.branchDistance) return;
    this.branchDistance = clamped;
    this.branchAnchor.copy(point);
  }

  // 要求の厳しい受け手から順に枠を起こす。**枠は受け手のまわりに置く** — 影を落とす遮蔽器は
  // 平行投影でちょうどその枠に重なるものなので、枠が受け手を覆えば必要な遮蔽器だけが入る。
  //
  // 既存の枠が覆っていて十分に細かいなら何もしない。覆っていない枠へ足せるのは、**足したあとも
  // その枠を起こした受け手の要求を満たせるとき**だけ。どれも駄目なら新しい枠を起こし、枠が
  // 尽きていればその受け手は諦める(要求の緩い側から捨てられる)。
  // 要求の厳しい受け手から順に枠を配る。**枠は要求どおりの大きさで開き、低い要求のために
  // 広げない** — 広げるとその枠を起こした受け手まで一緒に粗くなる。既存の枠へ相乗りできるのは、
  // 枠の大きさを変えずに平行移動して収まるときだけ。
  //
  // **最後の 1 枚は被覆に取っておく。** 要求どおりに縮めた枠は遮蔽器を覆いきれないので、
  // はみ出した部分を拾う粗い枠が要る。
  private buildClusters(): void {
    const windowSlots = SHADOW_SLOT_COUNT - 1;
    for (const receiver of this.casters) {
      if (!Number.isFinite(receiver.requiredTexel)) break; // 昇順なので、以降はすべて要求が無い
      const limit = 2 * extentForTexel(receiver.requiredTexel, SHADOW_SLOT_SIZE);
      if (this.shareFrame(receiver, limit)) continue;
      if (this.clusters.length >= windowSlots) break;
      this.openFrames(receiver, limit, windowSlots);
    }
    this.addCoverageFrame();
  }

  // 既存の枠へ相乗りさせる。**枠の大きさは変えない** — 中身の和が今の大きさに収まるときだけ、
  // 枠をずらして両方を入れる。粗い枠から試すのは、細かい枠をできるだけ手つかずで残すため。
  private shareFrame(receiver: Caster, limit: number): boolean {
    for (let index = this.clusters.length - 1; index >= 0; index--) {
      if (this.clusterSizes[index]! > limit) continue; // その枠では要求を満たせない
      this.scratchBox.copy(this.clusters[index]!).union(receiver.box);
      if (this.frameSize(this.scratchBox) > this.clusterSizes[index]!) continue;
      this.clusters[index]!.copy(this.scratchBox);
      return true;
    }
    return false;
  }

  // 受け手 1 つぶんの枠を開く。要求が箱より細かいときは、カメラにいちばん近い点へ寄せた窓を
  // 開き、**続けて箱ぜんたいの枠も開く。** 窓からはみ出した部分が最後の被覆枠(全受け手の和)
  // まで落ちると、そこだけ極端に粗くなる — 至近の艦の胴体に、遠くの艦まで含めた枠の texel が
  // 出てしまう。以後の受け手は箱ぜんたいの枠のほうへ相乗りする。
  private openFrames(receiver: Caster, limit: number, budget: number): void {
    const boxSize = this.frameSize(receiver.box);
    const size = receiver.diffuse ? boxSize : Math.min(boxSize, limit);
    if (size < boxSize) {
      this.scratchBox.setFromCenterAndSize(receiver.anchor, this.size.setScalar(size)).intersect(receiver.box);
      this.pushFrame(this.scratchBox, size, size * 0.5);
      if (this.clusters.length >= budget) return;
    }
    this.pushFrame(receiver.box, boxSize, Infinity);
  }

  // 枠を 1 枚積む。cap は枠の半径の上限で、Infinity なら箱に密着させる。
  private pushFrame(box: THREE.Box3, size: number, cap: number): void {
    this.clusterSizes.push(size);
    this.clusterCaps.push(cap);
    this.clusters.push(box.clone());
  }

  // 最後の 1 枚へ、影を要求する受け手をすべて包む枠を置く。**縮めた枠がこぼした部分と、枠が
  // 尽きて配れなかった受け手を、まとめてここが拾う。**
  private addCoverageFrame(): void {
    this.scratchBox.makeEmpty();
    for (const receiver of this.casters) {
      if (!Number.isFinite(receiver.requiredTexel)) break;
      this.scratchBox.union(receiver.box);
    }
    if (this.scratchBox.isEmpty()) return;
    // 箱に密着した枠が既に全体を包んでいるなら、同じ絵をもう 1 枚描くだけになる。
    const covered = this.clusters.some(
      (cluster, index) => this.clusterCaps[index] === Infinity && cluster.containsBox(this.scratchBox),
    );
    if (covered) return;
    this.pushFrame(this.scratchBox, this.frameSize(this.scratchBox), Infinity);
  }

  // box の 8 頂点をいま構えているライトカメラの空間へ写し、その範囲を lightSpaceBox へ書く。
  // **世界軸の広がりで代用しない** — 箱がライト基底に対して回っているぶんだけ範囲が足りず、
  // 縁の受け手が枠から外れて影を失う。
  private measureLightSpaceBox(box: THREE.Box3): void {
    const measured = this.lightSpaceBox;
    measured.minX = Infinity; measured.maxX = -Infinity;
    measured.minY = Infinity; measured.maxY = -Infinity;
    measured.front = Infinity; measured.back = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      const point = this.scratchCorner.set(
        (corner & 1) === 0 ? box.min.x : box.max.x,
        (corner & 2) === 0 ? box.min.y : box.max.y,
        (corner & 4) === 0 ? box.min.z : box.max.z,
      ).applyMatrix4(this.lightCamera.matrixWorldInverse);
      measured.minX = Math.min(measured.minX, point.x);
      measured.maxX = Math.max(measured.maxX, point.x);
      measured.minY = Math.min(measured.minY, point.y);
      measured.maxY = Math.max(measured.maxY, point.y);
      measured.front = Math.min(measured.front, -point.z);
      measured.back = Math.max(measured.back, -point.z);
    }
  }

  // 直前に測った箱を収める枠の半径 [m]。等方な texel を保つため長辺で揃え、フィルタの足の
  // ぶんだけ広げる。
  private frameExtent(): number {
    const { minX, maxX, minY, maxY } = this.lightSpaceBox;
    const half = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
    return half / (1 - 2 * SLOT_MARGIN_TEXELS / SHADOW_SLOT_SIZE);
  }

  // 箱を 1 枚へ収める枠の 1 辺 [m]。**世界軸ではなく対角で測る** — 計画の段では光の向きが
  // 枠ごとに決まっていないので、どう回っても収まる側へ倒す。
  private frameSize(box: THREE.Box3): number {
    box.getSize(this.size);
    return this.size.length();
  }

  // 箱へ平行投影のライトカメラを合わせ、スロットの uniform を書く。恒星方向が取れなければ偽。
  private configureSlot(
    slot: SunShadowSlot, box: THREE.Box3, extentCap: number, sun: SunLight,
  ): boolean {
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
    // 視線と平行な up は姿勢を決められないので、光の向きが縦に近いときだけ up を倒す。
    this.lightCamera.up.set(
      Math.abs(this.lightDirection.y) < 0.9 ? 0 : 1,
      Math.abs(this.lightDirection.y) < 0.9 ? 1 : 0,
      0,
    );
    this.lightCamera.lookAt(this.center);
    this.lightCamera.updateMatrixWorld(true);

    // **上限で縛ると枠は箱より小さくなりうる。** はみ出した受け手は被覆の枠が拾う。
    this.measureLightSpaceBox(box);
    const frameFront = this.lightSpaceBox.front;
    const extent = Math.min(this.frameExtent(), extentCap);
    this.lightCamera.left = -extent;
    this.lightCamera.right = extent;
    this.lightCamera.top = extent;
    this.lightCamera.bottom = -extent;

    // **near も far も枠から導出する。** 枠に交わる遮蔽器を光源寄りの端から遠い端まで漏れなく
    // 撮ることで、この 1 組だけで枠の中の答えが完結する。far は柱の終端で頭打ちにする — その先
    // にある遮蔽器が影を落とす相手は、もうこのスロットの被覆の外に居る。
    const span = COLUMN_SPAN * 2 * extent;
    const depths = this.casterDepthRange(extent);
    if (depths === null) return false;
    const far = Math.min(Math.max(depths.far, eyeDistance + extent), depths.near + span);
    // 枠から見て本影が残るのはここまで。これより光源寄りの遮蔽器は遠層が受け持つ。
    this.bandSplit = frameFront - UMBRA_SPAN * 2 * extent;
    this.nearBandFar = far;
    this.setLightDepthRange(depths.near, far);

    slot.near.value = depths.near;
    slot.far.value = far;
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
      this.measureLightSpaceBox(caster.box);
      const { minX, maxX, minY, maxY, front, back } = this.lightSpaceBox;
      if (minX > extent || maxX < -extent || minY > extent || maxY < -extent) continue;
      near = Math.min(near, front);
      far = Math.max(far, back);
    }
    return near <= far ? { near, far } : null;
  }

  // 保持している GPU 資源を解放する。
  dispose(): void {
    for (const target of [...this.targets, ...this.farTargets]) target.dispose();
    this.depthMaterial.dispose();
  }
}
