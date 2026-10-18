// 建造中のポインタとショートカットキーの解釈: ホバーが取り付け先を指し、クリックで配置・
// 選択、選択中モジュールの上から始まったドラッグで先端部を掴んで付け替える。
// 指す先の判定は候補の画面位置への距離、モジュールの選択は船体へのレイキャストで行う。
import { type KeyBinding, KEY_MAPPING as K } from '../../input/key-mapping';
import { screenProjection } from '../../math/projection';
import type { Ray } from '../../math/ray';
import type { Vec3 } from '../../math/vec3';
import type { CompoundCylinderRayHit } from '../../physics/compound-cylinder-contact';
import type { Input, PointerPoint, PointerPress } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import {
  CONSTRUCTION_TARGET_PICK_RADIUS_SQ, pickConstructionTargetAtScreenPoint,
  type ConstructionTargetGuide,
} from './ship-construction-candidates';
import { constructionTargetId } from './ship-construction-rules';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type { ConstructionTrial } from './ship-construction-preview';
import type { ConstructionCardDrag, ConstructionHeld } from './ship-construction-types';

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

// カタログのカテゴリを選ぶキー。並びはカタログのタブの並びと対応する。
const CATEGORY_KEYS: readonly KeyBinding[] = [
  K.constructionCategory1, K.constructionCategory2, K.constructionCategory3,
  K.constructionCategory4, K.constructionCategory5, K.constructionCategory6,
];

// 入力の解釈が船体へ求める面。配置済みモジュールの当たり判定だけを使う。
interface ConstructionPointerShip {
  readonly motion: {
    readonly state: { readonly r: Vec3 };
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
  placeAt(targetId?: string): void;
  moveSelectedTo(targetId: string): void;
  hold(held: ConstructionHeld): void;
  release(): void;
  select(moduleId: string | null): void;
  // moduleId を根とする先端部が撤去・付け替え・回転を受け付けるか。
  canEditModule(moduleId: string): boolean;
  clearCardDrag(): void;
  rotate(delta: 1 | -1): void;
  swapEnds(): void;
  cycleSymmetry(): void;
  duplicateSelected(): void;
  removeSelected(): void;
  undo(): void;
  redo(): void;
  // 建造対象の船体へ視点を寄せる。
  focusShip(): void;
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

  public constructor(private readonly host: ConstructionPointerHost) {}

  // このフレームのポインタ入力を読み、指す先の追従とクリック・ドラッグの操作を組む。
  // 掴んだドラッグはカメラへ流れないよう、カメラの入力解釈より先に呼ぶ。
  public interpretPointer(input: Input, camera: CameraSystem, viewport: Viewport): void {
    const host = this.host;
    const ship = host.sessionShip;
    if (ship === null) return;
    // 選択中モジュールの上から始まった押下だけを掴む。それ以外の押下はカメラへ流す。
    input.takePresses(press => this.tryGrab(ship, camera, viewport, press));
    const drag = this.grabbedPressId === null ? null : input.grabbedDrag(this.grabbedPressId);
    if (this.grabbedPressId !== null && drag === null) this.grabbedPressId = null;
    // 指す先の追従。カードのドラッグ・掴んだドラッグ・ホバーの順で位置を読む。
    const cardDrag = host.cardDrag;
    const point = cardDrag !== null ? input.canvasPoint(cardDrag.point.x, cardDrag.point.y)
      : drag !== null ? drag.point
      : input.pointerPoint;
    if (point !== null) {
      const canPoint = host.held !== null || host.selectedModuleId !== null;
      host.setPointedTarget(canPoint ? this.pickTarget(camera, viewport, point) : null);
    }
    // 掴んだ先端部を離す: 有効な取り付け先なら置き、それ以外なら手放して選択へ戻る。
    if (drag !== null && drag.released !== null) {
      this.dropHeld(camera, viewport, drag.released);
      this.grabbedPressId = null;
    }
    // カタログのカードのドラッグを離した位置で確定する。
    if (cardDrag !== null && cardDrag.released !== null) {
      this.dropHeld(camera, viewport, input.canvasPoint(cardDrag.released.x, cardDrag.released.y));
      host.clearCardDrag();
    }
    // クリック: 手に持っている間は指した取り付け先へ置き、それ以外はモジュールを選ぶ。
    input.takeClicks(click => {
      if (host.held !== null && host.pointedTargetId !== null) {
        host.placeAt();
        return true;
      }
      const moduleId = this.hitModuleId(ship, camera, viewport, click);
      if (moduleId === null) {
        host.select(null);
      } else {
        host.select(moduleId);
        // 選べたときだけ手に持ったものを手放す(起点ドックは選べない)。
        if (host.selectedModuleId === moduleId) host.release();
      }
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
      host.focusShip();
      return true;
    }
    const category = CATEGORY_KEYS.findIndex(binding => bindingMatches(binding, code, input));
    if (category !== -1) {
      host.selectCatalogCategory(category);
      return true;
    }
    return false;
  }

  // 選択中モジュールの上から始まった押下だけ掴み、その先端部を手持ちにする。
  private tryGrab(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, press: PointerPress,
  ): boolean {
    const host = this.host;
    const moduleId = host.selectedModuleId;
    if (moduleId === null || !host.canEditModule(moduleId)) return false;
    if (this.hitModuleId(ship, camera, viewport, press.point) !== moduleId) return false;
    host.hold({ kind: 'piece', moduleId });
    this.grabbedPressId = press.id;
    return true;
  }

  // 離した位置の取り付け先が有効なら手持ちを置き、無効か空白なら手放す。
  private dropHeld(camera: CameraSystem, viewport: Viewport, point: PointerPoint): void {
    const host = this.host;
    const targetId = this.pickTarget(camera, viewport, point);
    host.setPointedTarget(targetId);
    if (targetId !== null && host.pointedTrial()?.valid === true) host.placeAt();
    else host.release();
  }

  // 画面位置 point [px] に最も近い取り付け先の id。半径内に候補が無ければ null。
  private pickTarget(camera: CameraSystem, viewport: Viewport, point: PointerPoint): string | null {
    const project = screenProjection(camera.activeViewpoint, viewport.width, viewport.height);
    const candidates = this.host.targetGuides().map(guide => ({
      id: constructionTargetId(guide.target), ...project(guide.guideEci),
    }));
    return pickConstructionTargetAtScreenPoint(candidates, point, CONSTRUCTION_TARGET_PICK_RADIUS_SQ);
  }

  // 画面位置を通る視線が当たるモジュールの id。船体の外なら null。
  private hitModuleId(
    ship: ConstructionPointerShip, camera: CameraSystem, viewport: Viewport, point: PointerPoint,
  ): string | null {
    const ray = camera.rayThroughScreen(point.x, point.y, viewport);
    return ship.motion.raycastCompound(ray, ship.motion.state.r)?.moduleId ?? null;
  }
}
