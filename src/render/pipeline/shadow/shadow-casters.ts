// 恒星の直射光を遮る枝をシーンから集め、1 枝ぶんの箱・代表点・影の要求精度を測る。枝の単位は
// シーン直下の子 1 つ(艦 1 隻・基地 1 つ・インスタンスプール 1 本)で、**影を落とす側であると同時に
// 受け手の代理でもある** — 艦も基地もデブリも、影を落とすと同時に受ける。
import * as THREE from 'three/webgpu';
import { anchorAxis, castsOnto, insideBox, requiredTexel } from '../../shadow-demand';
import { SHADOW_CASTER_LAYER } from '../lit-layer';
import type { SunLight } from '../sun-light';

// 影が届く距離を、影を落とすものの差し渡しの何倍に取るか。差し渡し S のものの本影は太陽の視半径
// θ☉ = 4.65e-3 から D = S/(2·θ☉) = 107.5·S で消えるが、その先も影の濃さは (107.5·S/D)² で残る
// ので、ここまでを影の届く範囲として数える。打ち切り位置に残る濃さは 1.2 % で、縁は段差に
// ならない。
export const COLUMN_SPAN = 1000;

// 大量の個体を 1 本のメッシュで描く枝が、自分の広がりを影パスへ渡す口。個体が毎フレーム動く枝は
// メッシュ自身の外接箱が当てにならないので、userData.shadowExtent にこれを置く。
export type ShadowExtent = {
  // 今フレームの全個体を包む描画座標の AABB。
  readonly worldBounds: THREE.Box3;
};

// 枝 1 つぶんの、影を落とすもの。
export type ShadowCaster = {
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

export class ShadowCasters {
  private readonly casters: ShadowCaster[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly boundingSphere = new THREE.Sphere();
  private readonly lightForward = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly scratchBox = new THREE.Box3();
  private readonly scratchCorner = new THREE.Vector3();
  private readonly scratchMatrix = new THREE.Matrix4();
  // 枝ごとに拾う、カメラにいちばん近い実体の点とその距離。
  private readonly branchAnchor = new THREE.Vector3();
  private branchDistance = Infinity;
  private branchDiffuse = false;

  // シーン直下の枝ごとに、SHADOW_CASTER_LAYER のメッシュを包む描画座標の AABB を作り、
  // 要求 texel の厳しい(= 細かい)順に並べて返す。**返り値は次に呼ぶまでの間だけ有効** —
  // 同じ配列を毎フレーム詰め直す。scene のワールド行列は呼び出し側が確定させておく。
  //
  // **層を見るだけでは足りず、Mesh であることまで見る。** シーンルートは全チャンネルを持つ
  // (レンダラがカメラのチャンネルを絞る間も子を辿れるようにするため)ので、層だけで拾うと
  // ルートに当たり、Box3.expandByObject が子を再帰して天体ごと箱に入れてしまう。
  collect(
    scene: THREE.Scene, camera: THREE.Camera, viewportHeight: number, sun: SunLight,
    texelsPerPixel: number,
  ): readonly ShadowCaster[] {
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
    this.scoreCasters(camera, viewportHeight, sun, texelsPerPixel);
    // 要求が厳しい(= texel が細かい)ものから枠を起こせるよう、昇順に並べる。
    this.casters.sort((a, b) => a.requiredTexel - b.requiredTexel);
    return this.casters;
  }

  // 影を落とすものを受け手として見たときの要求 texel を書き込む。**画面に写らない受け手と、誰の影も
  // 落ちてこない受け手は要求を持たない** — 枠を 1 枚使う理由が無い。
  private scoreCasters(
    camera: THREE.Camera, viewportHeight: number, sun: SunLight, texelsPerPixel: number,
  ): void {
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
        receiver.anchorDistance, camera.near, camera.fov, viewportHeight, texelsPerPixel,
      );
    }
  }

  // caster の影が receiver へ届くか。光の向きは枝ごとに取り直す — 恒星は点光源なので、
  // 共通の向きで代用すると重心から離れた枝の柱が逸れる。
  private castsOnto(caster: ShadowCaster, receiver: ShadowCaster, sun: SunLight): boolean {
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
    if (mesh.isMesh && mesh.layers.isEnabled(SHADOW_CASTER_LAYER)) {
      const extent = mesh.userData.shadowExtent as ShadowExtent | undefined;
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
}
