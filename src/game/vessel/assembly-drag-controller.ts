// 掴んだもの(部品または部材)を実寸のメッシュのままカーソルで運び、機体の取り付け位置へ吸い寄せて
// 離す操作。カーソルの光線を船体ローカル座標へ移し、最寄りの取り付け位置を求め、そこへ置いたときに
// 設計が成り立つかを assembly-editor に問う。取り付けの可否をこのモジュールが判定することはない。
//
// 部品は既存の取り付け位置(ポート・エッジ表面)へ置かれ、確定は DockWorkbenchController.drop を
// 通る。部材(構造材)は空きポートへだけ吸い寄せられ、遠端に新しいノードとエッジが生える編集を
// member.ts が組み、確定は workbench.applyAssemblyEdit を直に呼ぶ ―― DockWorkbenchController の
// 掴み状態(DragState)は部品専用のままで、部材の掴みはそこを経由しない。
//
// 掴んでいる間の部品側の状態は DockWorkbenchController が持つ。ここが持つのは、掴んでいるものと、
// ゴーストをどこにどの色で描くかという表示側の値だけである。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { markLitOpaque } from '../../render/pipeline/lit-layer';
import { buildFitting, buildRadiatorPanel, buildSolarPanel } from '../../render/hull/part-meshes';
import { hullShapeOf } from './hull-shape';
import { buildLoftGeometry } from '../../render/hull/loft-mesh';
import type { AnyPart } from '../game-entity/parts';
import type { FloatingOrigin } from '../floating-origin';
import type { Quat } from '../../physics/attitude';
import { qInvert, qRotate } from '../../physics/attitude';
import { closestPointsOnSegments } from '../../physics/capsule-contact';
import type { Vec3 } from '../../physics/vec3';
import { add, addScaled, len, norm, scale, sub, v3 } from '../../physics/vec3';
import { isCoarsePointer } from '../input/pointer-precision';
import type { VesselAssembly } from './assembly';
import type { AssemblyEditResult } from './assembly-editor';
import { addPlacement, movePlacement } from './assembly-editor';
import { deriveCapsules } from './collision-shape';
import { FITTINGS } from './part-fittings';
import type { MemberSpec } from './member';
import { MEMBER_KIND_LABELS, memberAdditionAt, memberGhostTree } from './member';
import type { DockWorkbenchController, DragSource, SnapCandidate } from './dock-workbench-controller';
import type { WorkbenchValidation } from './dock-workbench';
import type { MountCandidate } from './mount-candidates';
import { nearestMountCandidate } from './mount-candidates';
import type { PartVisualRef } from './part-visual';
import type { MountFrame } from './tree';

// カーソルの光線を線分として扱う長さ [m]。機体の差し渡しより十分に長い。
const RAY_LENGTH = 1000;
// 取り付け位置がこの距離までなら吸い寄せる [m]。
const SNAP_DISTANCE = 2.5;
// 光線がカプセル表面からこの距離まで離れていても、機体の近くを指しているとみなす [m]。
const BROAD_PHASE_MARGIN = 3;
// 取り付け先が見つからないときにゴーストを置くカメラからの距離 [m]。
const FLOAT_DISTANCE = 12;
// 掴んでいる部品の代表寸法を決めるときの機体側の基準寸法 [m]。
const REFERENCE_HULL_SCALE = 1.5;

// エッジは太さの無いレイキャストなので、実寸での許容幅を明示する [m]。coarse ポインタ
// (タッチ)ではさらに広げる —— input/pointer-precision.ts の pickRadiusSq は画面投影後の
// 距離判定を対象にしており、ここはワールド座標系での実際の隙間なのでそのままは使えない。
const EDGE_PICK_THRESHOLD_FINE = 0.12;
const EDGE_PICK_THRESHOLD_COARSE = 0.4;

const GHOST_OPACITY = 0.65;

/** 掴んだものを落とせる機体1つと、その船体ローカル座標系の慣性系(ECI)での置かれ方。 */
export interface AssemblyDragTarget {
  readonly targetId: string;
  readonly assembly: VesselAssembly;
  readonly position: Vec3;
  readonly attitude: Quat;
}

export type GhostVerdict = 'valid' | 'invalid' | 'far';

/** ゴーストを描くのに要る値。update が決め、sync だけが読む。部品・部材のどちらでも形は同じ。 */
interface GhostPose {
  readonly position: Vec3; // 慣性系(ECI)
  readonly basis: MountFrame | null; // 慣性系での姿勢。取り付け先が無ければ null
  readonly verdict: GhostVerdict;
}

const GHOST_COLORS: Record<GhostVerdict, string> = {
  valid: C.COLOR_ASSEMBLY_GHOST_VALID,
  invalid: C.COLOR_ASSEMBLY_GHOST_INVALID,
  far: C.COLOR_ASSEMBLY_GHOST_FAR,
};

/** レイの先で拾ったもの。部品は掴み上げの対象、ノード・エッジは選択の対象になる。 */
export type AssemblyPick =
  | { readonly kind: 'part'; readonly partId: string }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'edge'; readonly edgeId: string }
  | { readonly kind: 'none' };

// 掴んでいるものの判別共用体。部品は DockWorkbenchController の DragState(移動元・在庫還元)を
// 経由するが、部材は移動元を持たない使い捨ての仕様なので、その追跡もここだけで完結する。
// 部品は掴み元(DragSource)も併せて持つ —— 対象上に残る鏡像側の同じ部品を隠すため、
// heldTargetPart がここから引く。
type Held =
  | { readonly kind: 'part'; readonly part: AnyPart; readonly source: DragSource }
  | { readonly kind: 'member'; readonly member: MemberSpec };

// 部材ドラッグの直近の update が組んだ編集。drop はこれを再計算せず、そのまま適用する。
interface PendingMemberEdit {
  readonly result: AssemblyEditResult;
  readonly label: string;
}

// 光線の向きを解くための一時オブジェクト。毎フレームの割り当てを避ける。
const rayScratch = new THREE.Vector3();
const basisScratch = new THREE.Matrix4();
const axisScratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
const pickNdc = new THREE.Vector2();

// 部品・部材をカーソルで運び、取り付け位置へ吸い寄せ、離して取り付けるまでを繋ぐ。
// 1フレームは update(判定) → sync(描画)の順で呼ぶ。
export class AssemblyDragController {
  private workbench: DockWorkbenchController | null = null;
  private held: Held | null = null;
  private pendingMemberEdit: PendingMemberEdit | null = null;
  private ghost: THREE.Object3D | null = null;
  private pose: GhostPose | null = null;
  private readonly raycaster = new THREE.Raycaster();

  public constructor(private readonly scene: THREE.Scene) {}

  // 部品でも部材でも、いま何かを掴んでいるか。掴んでいる間はクリックが離す操作になる。
  public get dragging(): boolean { return this.held !== null; }

  // 部品を掴む。workbench はこの掴みを記録する作業台、source は部品がどこから来たか
  // (倉庫か、既に装着されていた機体か)。
  public beginDrag(
    workbench: DockWorkbenchController,
    part: AnyPart,
    source: DragSource,
  ): void {
    this.cancelDrag();
    this.workbench = workbench;
    this.held = { kind: 'part', part, source };
    this.pose = null;
    workbench.beginDrag(part, source);
    this.ghost = buildPartGhost(part);
    if (this.ghost) this.scene.add(this.ghost);
  }

  // いま対象上から掴み上げている部品がどれか。棚から掴んでいる、部材を掴んでいる、または
  // 何も掴んでいなければ null —— 対象の鏡像から探して隠す相手が無いことを言う。
  public get heldTargetPart(): { readonly targetId: string; readonly partId: string } | null {
    if (!this.held || this.held.kind !== 'part' || this.held.source.kind !== 'target') return null;
    return { targetId: this.held.source.targetId, partId: this.held.part.id };
  }

  // 部材(構造材)を掴む。棚での構成そのものが仕様なので、移動元や在庫還元の概念を持たない ――
  // 離した先が見つからなければ何も生えず、部材はただ捨てられる。
  public beginMemberDrag(workbench: DockWorkbenchController, member: MemberSpec): void {
    this.cancelDrag();
    this.workbench = workbench;
    this.held = { kind: 'member', member };
    this.pose = null;
    this.pendingMemberEdit = null;
    this.ghost = buildMemberGhost(member);
    this.scene.add(this.ghost);
  }

  // カーソルの指す先にある部品・ノード・エッジを1つ拾う。root は現在の対象の描画木
  // (Vessel.renderObject か AssemblyRenderObject.object)— hull-mesh.ts が部品へ
  // userData['partVisualRef'] を、render/vessel-wireframe.ts がノード・エッジへ
  // userData['assemblyNodeId']/['assemblyEdgeId'] を自身かその祖先へ既に書いているので、
  // レイに当たった最も近いオブジェクトから root まで祖先を辿って読む。ワイヤーフレームの
  // 表示切り替えはレイキャストには効かない(THREE.Raycaster は visible を見ない)ので、
  // 組立表示トグルの状態に関わらず拾える。
  public pickAt(
    camera: THREE.Camera,
    pointerScreen: { readonly x: number; readonly y: number },
    viewport: { readonly width: number; readonly height: number },
    root: THREE.Object3D,
  ): AssemblyPick {
    const ndcX = (pointerScreen.x / Math.max(1, viewport.width)) * 2 - 1;
    const ndcY = -((pointerScreen.y / Math.max(1, viewport.height)) * 2 - 1);
    this.raycaster.params.Line = {
      threshold: isCoarsePointer() ? EDGE_PICK_THRESHOLD_COARSE : EDGE_PICK_THRESHOLD_FINE,
    };
    this.raycaster.setFromCamera(pickNdc.set(ndcX, ndcY), camera);
    // 手前から順に見て、最初に目印が見つかった当たりを採る。
    for (const hit of this.raycaster.intersectObject(root, true)) {
      const found = pickFromObject(hit.object, root);
      if (found) return found;
    }
    return { kind: 'none' };
  }

  // カーソルの指す先から取り付け位置を求め、そこへ置いたときの成否まで決める。
  // camera は描画フレーム(原点 = フローティングオリジン)に置かれているが、両フレームは平行移動
  // だけで移り合うので、光線の向きはそのまま慣性系の向きになる。始点には慣性系でのカメラ位置
  // cameraPos を使う。target が null なら吸い寄せ先を探さない。
  // THREE のオブジェクトには触れない — ゴーストの姿・色を決めるのは sync の仕事である。
  public update(
    camera: THREE.Camera,
    cameraPos: Vec3,
    pointerScreen: { readonly x: number; readonly y: number },
    viewport: { readonly width: number; readonly height: number },
    target: AssemblyDragTarget | null,
  ): void {
    if (!this.held || !this.workbench) return;
    const direction = rayDirection(camera, pointerScreen, viewport);
    if (this.held.kind === 'member') {
      this.updateMemberDrag(this.held.member, cameraPos, direction, target);
      return;
    }
    this.updatePartDrag(this.held.part, cameraPos, direction, target);
  }

  // 既存の取り付け位置(軸ポート・エッジ表面)へ吸い寄せ、そこへ置いたときの成否まで決める。
  private updatePartDrag(part: AnyPart, cameraPos: Vec3, direction: Vec3, target: AssemblyDragTarget | null): void {
    const mount = target === null ? null : this.resolveMount(target, cameraPos, direction);
    if (!mount || !target) {
      this.pose = { position: addScaled(cameraPos, direction, FLOAT_DISTANCE), basis: null, verdict: 'far' };
      this.workbench!.updateCandidate(null);
      return;
    }

    const placement = { kind: 'external', part, mount: mount.mount } as const;
    // 掴んでいる途中の設計は部分的であり、完成した設計の検査を通すことはできない。ここで問うのは
    // 「この取り付け位置が構造として成り立つか」だけである。
    const options = { validateBlueprint: false } as const;
    const held = target.assembly.placements.some((candidate) => candidate.part.id === part.id);
    const result = held
      ? movePlacement(target.assembly, { placementId: part.id, mount: mount.mount }, options)
      : addPlacement(target.assembly, placement, options);

    const basis = worldFrame(mount.frame, target);
    this.pose = { position: basis.origin, basis, verdict: result.accepted ? 'valid' : 'invalid' };
    const candidate: SnapCandidate = {
      placement,
      verdict: { accepted: result.accepted, reason: result.accepted ? null : result.errors[0]?.message ?? null },
      targetLabel: target.targetId,
      position: basis.origin,
      targetKind: this.workbench!.validateTarget(target.targetId).kind,
    };
    this.workbench!.updateCandidate(candidate);
  }

  // 空きポート(軸・側面とも)だけを狙い、見つかれば member.length ぶん先に生える遠端ノードの
  // 編集を組んで保持する。drop はこれを再計算せずそのまま適用する。
  private updateMemberDrag(member: MemberSpec, cameraPos: Vec3, direction: Vec3, target: AssemblyDragTarget | null): void {
    const mount = target === null ? null : this.resolvePortMount(target, cameraPos, direction);
    if (!mount || !target || mount.mount.kind !== 'port') {
      this.pose = { position: addScaled(cameraPos, direction, FLOAT_DISTANCE), basis: null, verdict: 'far' };
      this.pendingMemberEdit = null;
      return;
    }
    const result = memberAdditionAt(target.assembly, mount.mount.nodeId, mount.mount.port, mount.frame, member);
    const basis = worldFrame(mount.frame, target);
    this.pose = { position: basis.origin, basis, verdict: result.accepted ? 'valid' : 'invalid' };
    this.pendingMemberEdit = { result, label: `${MEMBER_KIND_LABELS[member.kind]}を追加` };
  }

  // update が決めた位置・姿勢・色をゴーストへ押し込む。
  public sync(fo: FloatingOrigin): void {
    const ghost = this.ghost;
    const pose = this.pose;
    if (!ghost) return;
    if (!pose) {
      ghost.visible = false;
      return;
    }
    ghost.visible = true;
    ghost.position.copy(fo.RtoThreeV3(pose.position));
    if (pose.basis) {
      const [x, y, z] = axisScratch;
      basisScratch.makeBasis(
        x.set(pose.basis.x.x, pose.basis.x.y, pose.basis.x.z),
        y.set(pose.basis.y.x, pose.basis.y.y, pose.basis.y.z),
        z.set(pose.basis.z.x, pose.basis.z.y, pose.basis.z.z),
      );
      ghost.quaternion.setFromRotationMatrix(basisScratch);
    }
    paintGhost(ghost, GHOST_COLORS[pose.verdict]);
  }

  // 掴んでいたものを targetId の機体へ確定して掴みを終える。部品は DockWorkbenchController.drop
  // (在庫・移動元の付け替えを含む)を、部材は直前の update が組んだ編集を workbench.applyAssemblyEdit
  // へそのまま渡す ―― 部材は DockWorkbenchController の DragState を一度も経由しない。
  // 直前の update が成立する取り付け位置を見つけていなければ何も変えずに終わる。
  // 返り値は確定後の作業台の検証結果。
  public drop(targetId: string): WorkbenchValidation {
    const workbench = this.workbench;
    if (!workbench || !this.held) throw new Error('assembly drag is not in progress');
    if (this.held.kind === 'member') {
      const validation = this.applyPendingMemberEdit(workbench, targetId);
      this.endDrag();
      return validation;
    }
    const validation = workbench.drop(targetId);
    this.endDrag();
    return validation;
  }

  // 保持している編集を適用するか、無ければ「取り付け位置が無い」検証結果を作って返す。
  private applyPendingMemberEdit(workbench: DockWorkbenchController, targetId: string): WorkbenchValidation {
    const pending = this.pendingMemberEdit;
    if (!pending || !pending.result.accepted) {
      return {
        valid: false,
        errors: pending ? pending.result.errors.map((error) => error.message) : ['取り付け位置が見つかりません'],
        targets: [workbench.validateTarget(targetId)],
      };
    }
    return workbench.applyAssemblyEdit(targetId, pending.result, pending.label);
  }

  // クリックで掴みを終える。直前の update が成立する取り付け位置を見つけていれば drop と同じく
  // そこへ取り付ける。部品で見つけていなければ ―― 機体から掴み上げた部品は workbench.remove で
  // 在庫へ戻し、棚から掴んだ部品はそもそも在庫から出ていないのでそのまま掴みを捨てる。部材は
  // 在庫を経由しないので、見つからなければ捨てるだけでよい。掴んでいなければ何もしない。
  // 在庫へ戻すことが検証に拒まれたときだけ、その理由を返す(部品は装着されたまま残る)。
  public release(targetId: string): string | null {
    const workbench = this.workbench;
    if (!workbench || !this.held) return null;
    if (this.held.kind === 'member') {
      if (this.pendingMemberEdit?.result.accepted) this.drop(targetId);
      else this.cancelDrag();
      return null;
    }
    const drag = workbench.dragging;
    if (drag?.candidate?.verdict.accepted) {
      this.drop(targetId);
      return null;
    }
    // 機体から掴み上げた部品(棚からではない)だけ、離した場所が空振りなら在庫へ戻す。
    if (drag && drag.source.kind === 'target') {
      const validation = workbench.remove(drag.source.targetId, drag.part.id).validation;
      if (!validation.valid) {
        this.cancelDrag();
        return validation.errors[0] ?? '取り外せません';
      }
    }
    this.cancelDrag();
    return null;
  }

  // 取り付けを試みずに掴みを捨てる。掴んでいなければ何もしない。
  public cancelDrag(): void {
    if (!this.workbench) return;
    this.workbench.updateCandidate(null);
    this.endDrag();
  }

  public dispose(): void { this.cancelDrag(); }

  // 光線に最も近いカプセルの上で光線が指す点を求め、そこから最寄りの取り付け位置(部品向け:
  // 軸ポート・エッジ表面)を返す。カプセルは広域の絞り込みであり、機体の近くを指していない
  // フレームでノードとエッジを総当たりする費用を省く。
  private resolveMount(target: AssemblyDragTarget, cameraPos: Vec3, direction: Vec3): MountCandidate | null {
    const probe = this.probeMountPoint(target, cameraPos, direction);
    return probe && nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE);
  }

  // 同じ広域絞り込みから、部材向けに空きポート(軸・側面とも)だけを候補にする。部材はエッジの
  // 表面ではなく必ず PortRef を持つ口へ生えるので、surface/truss 候補は探さない。
  private resolvePortMount(target: AssemblyDragTarget, cameraPos: Vec3, direction: Vec3): MountCandidate | null {
    const probe = this.probeMountPoint(target, cameraPos, direction);
    return probe && nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE, (m) => m.kind === 'port', ['axial', 'lateral']);
  }

  // 光線に最も近いカプセル上で、光線が指す点を返す。カプセル(広域の絞り込み)から
  // BROAD_PHASE_MARGIN 以上離れていれば機体の近くを指していないとみなし null。
  private probeMountPoint(target: AssemblyDragTarget, cameraPos: Vec3, direction: Vec3): Vec3 | null {
    const inverse = qInvert(target.attitude);
    const origin = qRotate(inverse, sub(cameraPos, target.position));
    const localDirection = qRotate(inverse, direction);
    const tip = addScaled(origin, localDirection, RAY_LENGTH);

    let probe: Vec3 | null = null;
    let bestGap = Infinity;
    for (const capsule of deriveCapsules(target.assembly.tree)) {
      const { s, t } = closestPointsOnSegments(origin, tip, capsule.a, capsule.b);
      const onRay = addScaled(origin, sub(tip, origin), s);
      const onAxis = add(capsule.a, scale(sub(capsule.b, capsule.a), t));
      const gap = len(sub(onAxis, onRay)) - capsule.radius;
      if (gap > BROAD_PHASE_MARGIN || gap >= bestGap) continue;
      bestGap = gap;
      probe = onRay;
    }
    return probe;
  }

  // 掴みが終わった後に残るもの(ゴースト・掴んでいた値)をすべて手放す。
  private endDrag(): void {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      disposeGhost(this.ghost);
      this.ghost = null;
    }
    this.workbench = null;
    this.held = null;
    this.pendingMemberEdit = null;
    this.pose = null;
  }
}

// 当たったオブジェクトから root までの祖先を辿り、3つの目印(部品・ノード・エッジ)の
// どれかを持つ最初のものを返す。どれも持たないまま root まで達したら null(=この当たりは
// 諦めて、次に近い当たりへ移る)。
function pickFromObject(hit: THREE.Object3D, root: THREE.Object3D): AssemblyPick | null {
  for (let node: THREE.Object3D | null = hit; node; node = node === root ? null : node.parent) {
    const partRef = node.userData['partVisualRef'] as PartVisualRef | undefined;
    if (partRef) return { kind: 'part', partId: partRef.partId };
    const nodeId = node.userData['assemblyNodeId'] as string | undefined;
    if (nodeId !== undefined) return { kind: 'node', nodeId };
    const edgeId = node.userData['assemblyEdgeId'] as string | undefined;
    if (edgeId !== undefined) return { kind: 'edge', edgeId };
  }
  return null;
}

// 画面座標の指す向きを慣性系の単位ベクトルとして返す。
function rayDirection(
  camera: THREE.Camera,
  pointerScreen: { readonly x: number; readonly y: number },
  viewport: { readonly width: number; readonly height: number },
): Vec3 {
  const ndcX = (pointerScreen.x / Math.max(1, viewport.width)) * 2 - 1;
  const ndcY = -((pointerScreen.y / Math.max(1, viewport.height)) * 2 - 1);
  rayScratch.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position);
  return norm(v3(rayScratch.x, rayScratch.y, rayScratch.z));
}

// 船体ローカルの取り付け位置の座標系を、機体の位置と姿勢で慣性系へ移す。
function worldFrame(frame: MountFrame, target: AssemblyDragTarget): MountFrame {
  return {
    origin: add(target.position, qRotate(target.attitude, frame.origin)),
    x: qRotate(target.attitude, frame.x),
    y: qRotate(target.attitude, frame.y),
    z: qRotate(target.attitude, frame.z),
  };
}

// 掴んでいる部品の見た目。機体が決まる前に作るので、大きさは部品自身と基準寸法から取る。
function buildPartGhost(part: AnyPart): THREE.Object3D | null {
  const object = buildPartGhostShape(part);
  if (object) markLitOpaque(object);
  return object;
}

// 部品の種別ごとの造形。外に出ない種別なら null。
function buildPartGhostShape(part: AnyPart): THREE.Object3D | null {
  if (part.type === 'radiator') return buildRadiatorPanel('up');
  if (part.type === 'solar_panel') return buildSolarPanel('up');
  const fitting = FITTINGS[part.type];
  if (!fitting) return null;
  const size = part.type === 'engine' ? part.length : fitting.ratio * REFERENCE_HULL_SCALE;
  const holder = new THREE.Group();
  holder.add(buildFitting(fitting.shape, size));
  return holder;
}

// 掴んでいる部材の見た目。member.ts の使い捨てツリーを、本物の外皮と同じ経路
// (hullShapeOf → buildLoftGeometry)へ通すので、生える辺と別のメッシュ生成器を持たない。
function buildMemberGhost(member: MemberSpec): THREE.Object3D {
  const geometry = buildLoftGeometry(hullShapeOf(memberGhostTree(member)));
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData['ownsGeometry'] = true;
  mesh.userData['ownsMaterial'] = true;
  markLitOpaque(mesh);
  return mesh;
}

// ゴースト全体を1色の半透明に染める。材質は掴むたびに作られるので、書き換えても他の描画に及ばない。
function paintGhost(ghost: THREE.Object3D, color: string): void {
  ghost.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const target = entry as THREE.MeshStandardMaterial | undefined;
      if (!target?.color) continue;
      target.color.set(color);
      target.transparent = true;
      target.opacity = GHOST_OPACITY;
    }
  });
}

// ゴーストが自分で持っているジオメトリと材質を解放する。
function disposeGhost(ghost: THREE.Object3D): void {
  ghost.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData['ownsGeometry']) mesh.geometry.dispose();
    if (mesh.userData['ownsMaterial']) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    }
  });
}
