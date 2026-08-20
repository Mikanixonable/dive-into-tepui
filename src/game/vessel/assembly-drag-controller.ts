// 掴んだ搭載要素を実寸のメッシュのままカーソルで運び、機体の取り付け位置へ吸い寄せて離す操作。
// カーソルの光線を船体ローカル座標へ移し、最寄りの取り付け位置を求め、そこへ置いたときに設計が
// 成り立つかを assembly-editor に問う。取り付けの可否をこのモジュールが判定することはない。
//
// 掴んでいる間の状態は DockWorkbenchController が持つ。ここが持つのは、ゴーストをどこにどの色で
// 描くかという表示側の値だけである。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { markLitOpaque } from '../../render/pipeline/lit-layer';
import { buildFitting, buildRadiatorPanel, buildSolarPanel } from '../../render/hull/part-meshes';
import type { AnyPart } from '../game-entity/parts';
import type { FloatingOrigin } from '../floating-origin';
import type { Quat } from '../../physics/attitude';
import { qInvert, qRotate } from '../../physics/attitude';
import { closestPointsOnSegments } from '../../physics/capsule-contact';
import type { Vec3 } from '../../physics/vec3';
import { add, addScaled, len, norm, scale, sub, v3 } from '../../physics/vec3';
import type { VesselAssembly } from './assembly';
import { addPlacement, movePlacement } from './assembly-editor';
import { deriveCapsules } from './collision-shape';
import { FITTINGS } from './part-fittings';
import type { DockWorkbenchController, SnapCandidate } from './dock-workbench-controller';
import type { WorkbenchValidation } from './dock-workbench';
import type { MountCandidate } from './mount-candidates';
import { nearestMountCandidate } from './mount-candidates';
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

const GHOST_OPACITY = 0.65;

/** 掴んだ部品を落とせる機体1つと、その船体ローカル座標系の慣性系(ECI)での置かれ方。 */
export interface AssemblyDragTarget {
  readonly targetId: string;
  readonly assembly: VesselAssembly;
  readonly position: Vec3;
  readonly attitude: Quat;
}

export type GhostVerdict = 'valid' | 'invalid' | 'far';

/** ゴーストを描くのに要る値。update が決め、sync だけが読む。 */
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

// 光線の向きを解くための一時オブジェクト。毎フレームの割り当てを避ける。
const rayScratch = new THREE.Vector3();
const basisScratch = new THREE.Matrix4();
const axisScratch = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;

// 部品をカーソルで運び、取り付け位置へ吸い寄せ、離して取り付けるまでを繋ぐ。
// 1フレームは update(判定) → sync(描画)の順で呼ぶ。
export class AssemblyDragController {
  private workbench: DockWorkbenchController | null = null;
  private part: AnyPart | null = null;
  private ghost: THREE.Object3D | null = null;
  private pose: GhostPose | null = null;
  private lastTargetId: string | null = null;
  private readonly releaseListener = (): void => { this.releaseAtLastTarget(); };

  public constructor(private readonly scene: THREE.Scene) {}

  public get draggingPart(): AnyPart | null { return this.part; }

  // 部品を掴む。workbench はこの掴みを記録する作業台、sourceTargetId は部品を外した機体
  // (倉庫から掴んだなら null)。掴んでいる間の離し操作を拾うため、ここで pointerup を購読する
  // — 「離すまで続く」操作には毎フレームの入力キューに現れる縁が無い。
  public beginDrag(
    workbench: DockWorkbenchController,
    part: AnyPart,
    sourceTargetId: string | null,
    sourceInventory: boolean,
  ): void {
    this.cancelDrag();
    this.workbench = workbench;
    this.part = part;
    this.pose = null;
    this.lastTargetId = null;
    workbench.beginDrag(part, sourceTargetId, sourceInventory);
    this.ghost = buildGhost(part);
    if (this.ghost) this.scene.add(this.ghost);
    document.addEventListener('pointerup', this.releaseListener);
    document.addEventListener('pointercancel', this.releaseListener);
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
    if (!this.part || !this.workbench) return;
    const direction = rayDirection(camera, pointerScreen, viewport);
    this.lastTargetId = target?.targetId ?? null;

    const mount = target === null ? null : this.resolveMount(target, cameraPos, direction);
    if (!mount || !target) {
      this.pose = { position: addScaled(cameraPos, direction, FLOAT_DISTANCE), basis: null, verdict: 'far' };
      this.workbench.updateCandidate(null);
      return;
    }

    const placement = { kind: 'external', part: this.part, mount: mount.mount } as const;
    // 掴んでいる途中の設計は部分的であり、完成した設計の検査を通すことはできない。ここで問うのは
    // 「この取り付け位置が構造として成り立つか」だけである。
    const options = { validateBlueprint: false } as const;
    const held = target.assembly.placements.some((candidate) => candidate.part.id === this.part!.id);
    const result = held
      ? movePlacement(target.assembly, { placementId: this.part.id, mount: mount.mount }, options)
      : addPlacement(target.assembly, placement, options);

    const basis = worldFrame(mount.frame, target);
    this.pose = { position: basis.origin, basis, verdict: result.accepted ? 'valid' : 'invalid' };
    const candidate: SnapCandidate = {
      placement,
      verdict: {
        accepted: result.accepted,
        failures: result.accepted ? [] : [result.errors.some((error) => error.code === 'occupied-port') ? 'occupied' : 'work-area'],
      },
      targetLabel: target.targetId,
      position: basis.origin,
      targetKind: this.workbench.validateTarget(target.targetId).kind,
    };
    this.workbench.updateCandidate(candidate);
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

  // 掴んでいた部品を targetId の機体へ取り付けて掴みを終える。直前の update が成立する取り付け位置を
  // 見つけていなければ何も取り付けずに終わり、部品は掴む前の持ち主のもとに残る。
  // 返り値は取り付け後の作業台の検証結果。
  public drop(targetId: string): WorkbenchValidation {
    const workbench = this.workbench;
    if (!workbench) throw new Error('assembly drag is not in progress');
    const validation = workbench.drop(targetId);
    this.endDrag();
    return validation;
  }

  // 取り付けを試みずに掴みを捨てる。掴んでいなければ何もしない。
  public cancelDrag(): void {
    if (!this.workbench) return;
    this.workbench.updateCandidate(null);
    this.endDrag();
  }

  public dispose(): void { this.cancelDrag(); }

  // 光線に最も近いカプセルの上で光線が指す点を求め、そこから最寄りの取り付け位置を返す。
  // カプセルは広域の絞り込みであり、機体の近くを指していないフレームでノードとエッジを
  // 総当たりする費用を省く。
  private resolveMount(
    target: AssemblyDragTarget,
    cameraPos: Vec3,
    direction: Vec3,
  ): MountCandidate | null {
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
    if (!probe) return null;

    return nearestMountCandidate(target.assembly, probe, SNAP_DISTANCE);
  }

  // 直前の update が見ていた機体へ落とす。見ていなければ掴みを捨てる。
  private releaseAtLastTarget(): void {
    if (!this.workbench) return;
    if (this.lastTargetId === null) {
      this.cancelDrag();
      return;
    }
    this.drop(this.lastTargetId);
  }

  // 掴みが終わった後に残るもの(購読・ゴースト・掴んでいた値)をすべて手放す。
  private endDrag(): void {
    document.removeEventListener('pointerup', this.releaseListener);
    document.removeEventListener('pointercancel', this.releaseListener);
    if (this.ghost) {
      this.scene.remove(this.ghost);
      disposeGhost(this.ghost);
      this.ghost = null;
    }
    this.workbench = null;
    this.part = null;
    this.pose = null;
    this.lastTargetId = null;
  }
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
function buildGhost(part: AnyPart): THREE.Object3D | null {
  const object = buildGhostShape(part);
  if (object) markLitOpaque(object);
  return object;
}

// 部品の種別ごとの造形。外に出ない種別なら null。
function buildGhostShape(part: AnyPart): THREE.Object3D | null {
  if (part.type === 'radiator') return buildRadiatorPanel('up');
  if (part.type === 'solar_panel') return buildSolarPanel('up');
  const fitting = FITTINGS[part.type];
  if (!fitting) return null;
  const size = part.type === 'engine' ? part.length : fitting.ratio * REFERENCE_HULL_SCALE;
  const holder = new THREE.Group();
  holder.add(buildFitting(fitting.shape, size));
  return holder;
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
