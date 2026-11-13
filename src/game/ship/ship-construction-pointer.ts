// 建造中のポインタとショートカットキーの解釈: ホバーが取り付け先を指し、クリックで配置・
// 選択、選択中モジュールの上から始まったドラッグで先端部を掴んで付け替える。
// 編集できるモジュールを選んでいる間は、その接続軸まわりの回転リングを掴める。
// 指す先の判定は候補の画面位置への距離とポインタの下のモジュール、モジュールの選択は
// 船体へのレイキャスト、リングの掴みはリング面への視線の交点で行う。
import { type KeyBinding, KEY_MAPPING as K } from '../../input/key-mapping';
import { metersPerPixel, screenProjection } from '../../math/projection';
import type { Quat } from '../../math/quat';
import type { Ray } from '../../math/ray';
import type { Vec3 } from '../../math/vec3';
import type { CompoundCylinderRayHit } from '../../physics/compound-cylinder-contact';
import type { GrabbedDrag, Input, PointerPoint, PointerPress } from '../../input/input';
import { pickRadiusSq } from '../../input/pointer-precision';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import {
  CONSTRUCTION_TARGET_PICK_RADIUS_SQ, constructionTargetModuleIds, pickConstructionTarget,
  type ConstructionTargetGuide,
} from './ship-construction-candidates';
import { constructionTargetId } from './ship-construction-rules';
import type { ShipAssembly } from './ship-assembly';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type { ConstructionTrial } from './ship-construction-preview';
import type { ConstructionCardDrag, ConstructionHeld } from './ship-construction-types';
import {
  appliedRotationSteps, constructionRotationRing, ringPlaneHit, wrapAnglePi,
  type ConstructionRotationDrag, type ConstructionRotationRing,
} from './ship-construction-rotation';

// 修飾キーの押下判定用。キー割り当てではなく、割り当てに伴う修飾の照合にだけ使う。
const CTRL_OR_META: readonly KeyBinding[] = [
  { code: 'ControlLeft', label: 'Ctrl' },
  { code: 'ControlRight', label: 'Ctrl' },
  { code: 'MetaLeft', label: '⌘' },
  { code: 'MetaRight', label: '⌘' },
];
const SHIFT: readonly KeyBinding[] = [
  { code: 'ShiftLeft', label: 'Shift' },
  { code: 'ShiftRight', label: 'Shift' },
];

// 回転リングの帯の片側の太さ [px]。押した位置がリングの半径からこの幅の内側なら掴む。
// タップターゲットの最小 44 px に合わせ、粗いポインタでは片側 22 px まで広げる。
const RING_HIT_PX = Math.sqrt(pickRadiusSq(12 * 12, 22 * 22));

// カタログのカテゴリを選ぶキー。並びはカタログのタブの並びと対応する。
const CATEGORY_KEYS: readonly KeyBinding[] = [
  K.constructionCategory1, K.constructionCategory2, K.constructionCategory3,
  K.constructionCategory4, K.constructionCategory5, K.constructionCategory6,
];

// 入力の解釈が船体へ求める面。接続の構造と配置済みモジュールの当たり判定、
// 回転リングの姿勢を求める姿勢・重心だけを使う。
interface ConstructionPointerShip {
  readonly assembly: ShipAssembly;
  readonly motion: {
    readonly state: { readonly r: Vec3 };
    readonly att: { readonly q: Quat };
    readonly centerOffset: Vec3;
    raycastCompound(ray: Ray, pos: Vec3): CompoundCylinderRayHit | null;
  };
}

// ポインタ・キーの解釈が読む建造セッションの面。読み取り面と命令の両方を持つ。
export interface ConstructionPointerHost {
  readonly sessionShip: ConstructionPointerShip | null;
  readonly held: ConstructionHeld | null;
  readonly selectedModuleId: string | null;
  readonly pointedTargetId: string | null;
  readonly cardDrag: ConstructionCardDrag | null;
  // 全取り付け先の接続面ガイド(ECI 座標)。指す候補を画面位置から選ぶ材料。
  targetGuides(): readonly ConstructionTargetGuide[];
  // 指している取り付け先へ手持ちを置いた結果の試し置き。
  pointedTrial(): ConstructionTrial | null;
  setPointedTarget(targetId: string | null): void;
  // ポインタの下にあるモジュールを記録する。タッチ環境や船体の外では null。
  setHoveredModule(moduleId: string | null): void;
  placeAt(targetId?: string): void;
  moveSelectedTo(targetId: string): void;
  hold(held: ConstructionHeld): void;
  release(): void;
  // 理由を出してから手に持ったものを手放す。
  releaseWithReason(reason: string): void;
  select(moduleId: string | null): void;
  // moduleId を根とする先端部が撤去・付け替え・回転を受け付けるか。
  canEditModule(moduleId: string): boolean;
  clearCardDrag(): void;
  rotate(delta: 1 | -1): void;
  // 手持ち・選択中を steps 段(90° 単位)回す。1 回の呼び出しは 1 つの操作。
  rotateSteps(steps: number): void;
  swapEnds(): void;
  cycleSymmetry(): void;
  duplicateSelected(): void;
  removeSelected(): void;
  undo(): void;
  redo(): void;
  // 選択中のモジュールへ、選んでいなければ建造対象の船体へ視点を寄せる。
  focus(): void;
  // カタログのカテゴリをタブの並び順の index で選ぶ。
  selectCatalogCategory(index: number): void;
}

// カタログ定義順で currentId から delta 先の定義 id。currentId が一覧に無ければ、
// 次へは先頭、前へは末尾へ送る。一覧が空なら null。
export function nextCatalogDefinitionId(
  definitionIds: readonly string[], currentId: string | null, delta: 1 | -1,
): string | null {
  if (definitionIds.length === 0) return null;
  const index = currentId === null ? -1 : definitionIds.indexOf(currentId);
  if (index === -1) return definitionIds[delta > 0 ? 0 : definitionIds.length - 1]!;
  return definitionIds[(index + delta + definitionIds.length) % definitionIds.length]!;
}

function ctrlOrMetaDown(input: Input): boolean {
  return CTRL_OR_META.some(binding => input.down(binding));
}

function shiftDown(input: Input): boolean {
  return SHIFT.some(binding => input.down(binding));
}

// code が binding に一致するか。修飾は宣言されたものを要求し、宣言されていない修飾は
// 押されていないことを要求する(Ctrl+Z と Ctrl+Shift+Z、Tab と Shift+Tab を分けるため)。
function bindingMatches(binding: KeyBinding, code: string, input: Input): boolean {
  if (binding.code !== code && !(binding.altCodes?.includes(code) ?? false)) return false;
  if ((binding.withCtrlOrMeta ?? false) !== ctrlOrMetaDown(input)) return false;
  if ((binding.withShift ?? false) !== shiftDown(input)) return false;
  return true;
}

// 建造中のポインタ操作とショートカットキーの解釈。掴んだドラッグの対応付けを
// 操作途中の状態として持つ。
export class ShipConstructionPointer {
  // 掴んだ押下の識別子(Input.PointerPress.id)。選択中モジュールのドラッグだけが掴まれる。
  private grabbedPressId: number | null = null;
  // 持ち運び中のドラッグの画面位置(キャンバス座標)。カード・先端部のどちらのドラッグでも
  // 持ち、どちらも無ければ null。表示の導出が持ち物をポインタの先へ浮かべる材料。
  private dragPointValue: { x: number; y: number } | null = null;
  // 回転リングを掴んだドラッグ。リングは掴んだときの幾何のまま追い、離した位置で
  // 90° 単位へ丸めて適用する。リングを掴んでいないドラッグでは null。
  private ringDrag: {
    readonly ring: ConstructionRotationRing;
    readonly startAngle: number;
    previousAngle: number;
    angle: number;
  } | null = null;

  public constructor(private readonly host: ConstructionPointerHost) {}

  // 持ち運び中のドラッグの画面位置(キャンバス座標)。どちらのドラッグも無ければ null。
  public get dragPoint(): { readonly x: number; readonly y: number } | null {
    return this.dragPointValue;
  }

  // リングのドラッグ中の角度情報。表示の導出が弧とスナップ位置を組む材料。
  public get rotationDrag(): ConstructionRotationDrag | null {
    const drag = this.ringDrag;
    return drag === null ? null : {
      startAngle: drag.startAngle,
      angle: drag.angle,
      appliedSteps: appliedRotationSteps(drag.startAngle, drag.angle),
    };
  }

  // このフレームのポインタ入力を読み、指す先の追従とクリック・ドラッグの操作を組む。
  // 掴んだドラッグはカメラへ流れないよう、カメラの入力解釈より先に呼ぶ。
  public interpretPointer(input: Input, camera: CameraSystem, viewport: Viewport): void {
    const host = this.host;
    const ship = host.sessionShip;
    if (ship === null) return;
    // 選択中モジュールの上から始まった押下だけを掴む。それ以外の押下はカメラへ流す。
    input.takePresses(press => this.tryGrab(ship, camera, viewport, press));
    const drag = this.grabbedPressId === null ? null : input.grabbedDrag(this.grabbedPressId);
    if (this.grabbedPressId !== null && drag === null) {
      this.grabbedPressId = null;
      this.ringDrag = null;
    }
    // 掴んだリングのドラッグ: 回した角を追い、離した位置で 90° 単位へ丸めて適用する。
    // リングを掴んだドラッグは、離したフレームも含めて先端部の掴み取りへ扱わない。
    const ringDragActive = this.ringDrag !== null;
    if (ringDragActive && drag !== null) {
      this.updateRingDrag(camera, viewport, drag);
      if (drag.released !== null) {
        this.finishRingDrag();
        this.grabbedPressId = null;
        this.ringDrag = null;
      }
    }
    const pieceDrag = ringDragActive ? null : drag;
    // 指す先の追従。カードのドラッグ・掴んだドラッグ・ホバーの順で位置を読む。
    const cardDrag = host.cardDrag;
    const point = cardDrag !== null ? input.canvasPoint(cardDrag.point.x, cardDrag.point.y)
      : pieceDrag !== null ? pieceDrag.point
      : input.pointerPoint;
    this.dragPointValue = cardDrag !== null || pieceDrag !== null ? point : null;
    if (point !== null) {
      const canPoint = !ringDragActive
        && (host.held !== null || host.selectedModuleId !== null);
      host.setPointedTarget(canPoint ? this.pickTarget(ship, camera, viewport, point) : null);
    }
    // ポインタの下のモジュールをホバーとして追う。手持ち・ドラッグの間は空を記録する。
    const hovering = host.held === null && drag === null && cardDrag === null;
    host.setHoveredModule(
      hovering && input.pointerPoint !== null
        ? this.hitModuleId(ship, camera, viewport, input.pointerPoint)
        : null,
    );
    // 掴んだ先端部を離す: 有効な取り付け先なら置き、それ以外なら手放して選択へ戻る。
    if (pieceDrag !== null && pieceDrag.released !== null) {
      this.dropHeld(ship, camera, viewport, pieceDrag.released);
      this.grabbedPressId = null;
    }
    // カタログのカードのドラッグを離した位置で確定する。
    if (cardDrag !== null && cardDrag.released !== null) {
      this.dropHeld(ship, camera, viewport, input.canvasPoint(cardDrag.released.x, cardDrag.released.y));
      host.clearCardDrag();
    }
    // クリック: 手に持っている間は押した位置の候補を選び直して置き、候補が無ければ
    // 何もしない。それ以外は当たったモジュールを選ぶ。
    input.takeClicks(click => {
      if (host.held !== null) {
        const targetId = this.pickTarget(ship, camera, viewport, click);
        if (targetId === null) return true;
        host.setPointedTarget(targetId);
        host.placeAt();
        return true;
      }
      host.select(this.hitModuleId(ship, camera, viewport, click));
      return true;
    });
    // 右クリック(動かず離した)・長押し: 手に持ったものを放し、選択を解く。
    input.takeRightClicks(() => {
      host.release();
      host.select(null);
      return true;
    });
  }

  // ショートカットキー1つを建造の操作へ写す。割り当てに一致しなければ false を返して
  // 下のオーバーレイへ回す。修飾の宣言(withCtrlOrMeta/withShift)は input.down で照合する。
  public interpretKey(code: string, input: Input): boolean {
    const host = this.host;
    if (bindingMatches(K.constructionRedo, code, input) || bindingMatches(K.constructionRedoAlt, code, input)) {
      host.redo();
      return true;
    }
    if (bindingMatches(K.constructionUndo, code, input)) {
      host.undo();
      return true;
    }
    if (bindingMatches(K.constructionRollLeft, code, input)) {
      host.rotate(-1);
      return true;
    }
    if (bindingMatches(K.constructionRollRight, code, input)) {
      host.rotate(1);
      return true;
    }
    if (bindingMatches(K.constructionSwapEnds, code, input)) {
      host.swapEnds();
      return true;
    }
    if (bindingMatches(K.constructionSymmetry, code, input)) {
      host.cycleSymmetry();
      return true;
    }
    if (bindingMatches(K.constructionDuplicate, code, input)) {
      host.duplicateSelected();
      return true;
    }
    if (bindingMatches(K.constructionRemove, code, input)) {
      host.removeSelected();
      return true;
    }
    // Tab は修飾の宣言を持たないので、Shift は送る向きとして読む。
    if (code === K.constructionCyclePart.code && !ctrlOrMetaDown(input)) {
      const current = host.held?.kind === 'catalog' ? host.held.definitionId : null;
      const next = nextCatalogDefinitionId(
        SHIP_MODULE_CATALOG.all().map(definition => definition.id), current, shiftDown(input) ? -1 : 1,
      );
      if (next !== null) host.hold({ kind: 'catalog', definitionId: next });
      return true;
    }
    if (bindingMatches(K.constructionPlace, code, input)) {
      // 手持ちが無く選択中のモジュールがあるとき、配置は付け替えとして働く。
      if (host.held !== null) host.placeAt();
      else if (host.selectedModuleId !== null && host.pointedTargetId !== null) {
        host.moveSelectedTo(host.pointedTargetId);
      }
      return true;
    }
    if (bindingMatches(K.constructionFocus, code, input)) {
      host.focus();
      return true;
    }
    const category = CATEGORY_KEYS.findIndex(binding => bindingMatches(binding, code, input));
    if (category !== -1) {
      host.selectCatalogCategory(category);
      return true;
    }
    return false;
  }

  // 選択中モジュールの上から始まった押下だけ掴む。回転リングの帯の上ならリングの
  // ドラッグとして、モジュールの上なら先端部を手持ちにする。それ以外は掴まない。
  private tryGrab(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, press: PointerPress,
  ): boolean {
    const host = this.host;
    const moduleId = host.selectedModuleId;
    if (moduleId === null || !host.canEditModule(moduleId)) return false;
    // リングは手持ちの間は出ていないので、先端部の掴み取りより先に解釈する。
    if (host.held === null && this.tryGrabRing(ship, camera, viewport, press)) return true;
    if (this.hitModuleId(ship, camera, viewport, press.point) !== moduleId) return false;
    host.hold({ kind: 'piece', moduleId });
    this.grabbedPressId = press.id;
    return true;
  }

  // 押した位置が選択中モジュールの回転リングの帯の内側なら掴む。帯の太さは交点の
  // 深さの画素あたりの長さから求め、角度はリング面の交点から取る。
  private tryGrabRing(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, press: PointerPress,
  ): boolean {
    const ring = constructionRotationRing(ship, this.host.selectedModuleId!);
    if (ring === null) return false;
    const hit = ringPlaneHit(ring, camera.rayThroughScreen(press.point.x, press.point.y, viewport));
    if (hit === null) return false;
    const band = metersPerPixel(camera.activeViewpoint, hit.point, viewport.height) * RING_HIT_PX;
    if (Math.abs(hit.distance - ring.radius) > band) return false;
    this.ringDrag = {
      ring, startAngle: hit.angle, previousAngle: hit.angle, angle: 0,
    };
    this.grabbedPressId = press.id;
    return true;
  }

  // ドラッグ中は面の交点の角を追い、±π を跨いでも向きが反転しないよう差分を畳んで足す。
  private updateRingDrag(
    camera: CameraSystem, viewport: Viewport, drag: GrabbedDrag,
  ): void {
    const ringDrag = this.ringDrag;
    if (ringDrag === null) return;
    const hit = ringPlaneHit(ringDrag.ring, camera.rayThroughScreen(drag.point.x, drag.point.y, viewport));
    if (hit === null) return;
    ringDrag.angle += wrapAnglePi(hit.angle - ringDrag.previousAngle);
    ringDrag.previousAngle = hit.angle;
  }

  // 離したときの回転を適用する。累積角は 90° 単位へ丸め、動かさず離した
  // クリックは最も近い矢印の向きへ 1 段回す。
  private finishRingDrag(): void {
    const ringDrag = this.ringDrag;
    if (ringDrag === null) return;
    this.host.rotateSteps(appliedRotationSteps(ringDrag.startAngle, ringDrag.angle));
  }

  // 離した位置の取り付け先が有効なら手持ちを置き、候補があって置けないなら理由を
  // 出して手放す。候補の無い場所ではそのまま手放す。
  private dropHeld(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, point: PointerPoint,
  ): void {
    const host = this.host;
    const targetId = this.pickTarget(ship, camera, viewport, point);
    host.setPointedTarget(targetId);
    const trial = targetId === null ? null : host.pointedTrial();
    if (trial?.valid === true) {
      host.placeAt();
      return;
    }
    if (targetId !== null) {
      host.releaseWithReason(trial?.reason ?? 'ここには置けません');
      return;
    }
    host.release();
  }

  // 画面位置 point [px] に最も近い取り付け先の id。ノードの半径内に候補が無ければ、
  // ポインタの下のモジュールに属する候補のうち最も近いものを選ぶ。
  private pickTarget(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, point: PointerPoint,
  ): string | null {
    const project = screenProjection(camera.activeViewpoint, viewport.width, viewport.height);
    const candidates = this.host.targetGuides().map(guide => ({
      id: constructionTargetId(guide.target),
      // 置けない候補は所属を空にし、モジュール経由の吸着から外す(掴んだ先端部自身の上で離すと拒否になるため)。
      moduleIds: guide.placement.valid ? constructionTargetModuleIds(ship.assembly, guide.target) : [],
      ...project(guide.guideEci),
    }));
    return pickConstructionTarget(
      candidates, point, CONSTRUCTION_TARGET_PICK_RADIUS_SQ,
      () => this.hitModuleId(ship, camera, viewport, point),
    );
  }

  // 画面位置を通る視線が当たるモジュールの id。船体の外なら null。
  private hitModuleId(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, point: PointerPoint,
  ): string | null {
    const ray = camera.rayThroughScreen(point.x, point.y, viewport);
    return ship.motion.raycastCompound(ray, ship.motion.state.r)?.moduleId ?? null;
  }
}
