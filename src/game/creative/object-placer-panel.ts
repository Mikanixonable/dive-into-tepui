// クリエイティブモードの「物体配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で ObjectPlacerForm を通知する。
import {
  buildLabeledRow, Button, CloseButton, SegmentedControl, ValueInput,
} from '../../hud-kit/widgets';
import { ENTITY_GLYPH } from '../marker/marker-identity';
import { baseMarkerSvg, shipMarkerSvg } from '../marker/marker-shapes';
import { placeOverlayAt } from '../../hud-kit/layout';
import { onViewportChange } from '../../hud-kit/visual-viewport';
import { isCompactViewport } from '../../hud-kit/breakpoints';
import { wireHeaderDrag } from '../../hud-kit/window-drag';
import type { OverlayHandle, OverlayManager } from '../../hud-kit/overlay-manager';
import type { CollinearPoint } from '../../physics/lagrange';
import type { PlacementFieldId, PlacementFieldIssue } from './placement-validation';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicEntityKind } from '../dynamic/entity/entity-kind';
import { ObjectPlacerElementsSection } from './object-placer-elements-section';
import { ObjectPlacerLagrangeSection } from './object-placer-lagrange-section';

export type ReferenceCelestialBody = string;
type PlacementMode = 'elements' | 'lagrange';

// 軌道要素指定のサイズ/形: sizeMode が選んだ組の値だけを持つ。
type EllipticSizeForm =
  | { readonly sizeMode: 'apsides'; readonly peAltKm: number; readonly apAltKm: number }
  | { readonly sizeMode: 'semiMajorEcc'; readonly semiMajorKm: number; readonly eccentricity: number }
  | { readonly sizeMode: 'periodEcc'; readonly periodHours: number; readonly eccentricity: number };

// 軌道要素指定一式: 基準天体・サイズ/形(上記)・向き/位相。
export type ElementsForm = {
  readonly placementMode: 'elements';
  readonly celestialBody: ReferenceCelestialBody;
  readonly incDeg: number;
  readonly raanDeg: number;
  readonly argpDeg: number;
  readonly nuDeg: number;
} & EllipticSizeForm;

// ラグランジュ点指定一式: 軌道種別ごとに持つ振幅が異なる。リサジューは面内・面外の両方を取り、
// ハローは面外だけを取る — ハローの面内振幅は三次の振幅拘束から面外振幅が決める。
export type LagrangeForm = {
  readonly placementMode: 'lagrange';
  readonly lagrangeSecondary: string;
  readonly lagrangePoint: CollinearPoint;
} & (
  | { readonly lagrangeOrbitKind: 'halo'; readonly azKm: number }
  | { readonly lagrangeOrbitKind: 'lissajous'; readonly axKm: number; readonly azKm: number }
);

// 確定時点のフォーム値。placementMode を判別子とし、選ばれた配置方法(・サイズ/形・軌道種別)が
// 実際に使う値だけを持つ。
type ShipPlacementPreset = 'combat-ship' | 'base-ship';
export type ObjectPlacementSelection =
  | ShipPlacementPreset | Exclude<DynamicEntityKind, 'player' | 'base'> | 'orbit-slot';
export type ObjectPlacerForm = { readonly selection: ObjectPlacementSelection } & (ElementsForm | LagrangeForm);

// open() の事前入力: 'body' はその天体を基準天体とする軌道要素方式のフォームで開く
// (他の入力欄は前回の値のまま)。'selection' は preset/種類だけを合わせる。
// 'form' は preset/種類を selection に固定し、軌道要素一式をその値へ書き換える。
type ObjectPlacerPreset =
  | { readonly kind: 'body'; readonly celestialBody: ReferenceCelestialBody }
  | { readonly kind: 'selection'; readonly selection: ObjectPlacementSelection }
  | { readonly kind: 'form'; readonly selection: ObjectPlacementSelection; readonly form: ElementsForm };

// アイコンはマップ実マーカーと同じ形状(自機=鏃の塗りつぶし、敵機=鏃の中抜き、基地=正七角形)。
const ENTITY_KIND_ITEMS: readonly (readonly [ObjectPlacementSelection, string, string])[] = [
  ['combat-ship', '自機', shipMarkerSvg(true)],
  ['enemy', '敵機', shipMarkerSvg(false)],
  ['ammo', '弾薬', ENTITY_GLYPH.ammo],
  ['fuel', 'RCS燃料', ENTITY_GLYPH.fuel],
  ['base-ship', '基地', baseMarkerSvg()],
  ['orbit-slot', '軌道標識', '⌾'],
];

const PLACEMENT_MODE_ITEMS: readonly (readonly [PlacementMode, string])[] = [
  ['elements', '軌道要素'],
  ['lagrange', 'ラグランジュ点'],
];

// OverlayManager の台帳上の id。開いているかどうかは登録の有無が正本。
const OVERLAY_ID = 'object-placer';

// 配置方法(placementMode)ごとの入力欄のまとまり。自分の DOM と値の読み取り、検証で指す
// 行の特定を持つ。
export interface PlacementSection {
  readonly element: HTMLElement;
  // セクションの入力欄の現在値を、表示中の組・種別が使う値だけ読み取ってフォームへ組む。
  readForm(): ElementsForm | LagrangeForm;
  // セクションが持つ入力欄ならその行要素を、持たない欄なら null を返す。
  fieldRowFor(field: PlacementFieldId): HTMLElement | null;
  // セクションが作った資源(選択ポップアップなど)を片付ける。
  dispose(): void;
}

export class ObjectPlacerPanel implements OverlayHandle {
  public onConfirm: ((name: string, form: ObjectPlacerForm) => void) | null = null;

  public get isOpen(): boolean { return this.overlayManager.isOverlayOpen(OVERLAY_ID); }

  private readonly panel: HTMLElement;
  private readonly entityKind: SegmentedControl<ObjectPlacementSelection>;
  private readonly placementMode: SegmentedControl<PlacementMode>;
  private readonly sections: {
    readonly elements: ObjectPlacerElementsSection;
    readonly lagrange: ObjectPlacerLagrangeSection;
  };
  private readonly nameInput: HTMLInputElement;
  private readonly issueList: HTMLElement;
  private issueRows: readonly HTMLElement[] = [];
  private lastIssueKey = '';

  private entityKindValue: ObjectPlacementSelection = 'combat-ship';
  private placementModeValue: PlacementMode = 'elements';
  private readonly unsubscribeViewport: () => void;

  // 物体配置パネルの DOM を組み立てる。要素は開くまで DOM へ挿さず、overlayManager が
  // window の層へ置く。
  public constructor(
    celestialSystem: CelestialSystem,
    private readonly overlayManager: OverlayManager,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-object-placer';
    this.panel.className = 'panel hidden editorial-control-sheet';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const header = document.createElement('div');
    header.className = 'panel-chrome-head editorial-panel-head';
    const code = document.createElement('span');
    code.className = 'ui-section-code';
    code.setAttribute('aria-hidden', 'true');
    code.textContent = 'INS';
    const title = document.createElement('h3');
    title.className = 'editorial-panel-title';
    title.textContent = 'OBJECT INSERT';
    header.append(code, title);
    header.appendChild(new CloseButton(() => this.close()).element);
    this.panel.appendChild(header);
    // ヘッダーを掴んで動かせる浮遊ウィンドウにする。compact の下端シート中はドラッグしない。
    wireHeaderDrag(header, {
      position: () => ({ x: this.panel.offsetLeft, y: this.panel.offsetTop }),
      moveTo: (x, y) => this.moveTo(x, y),
      enabled: () => this.isOpen && !isCompactViewport(),
    });
    this.unsubscribeViewport = onViewportChange(() => {
      if (this.isOpen) this.reclamp();
    });

    this.entityKind = new SegmentedControl('種類', ENTITY_KIND_ITEMS, (v) => this.selectEntityKind(v));
    this.entityKind.setSelected(this.entityKindValue);
    this.panel.appendChild(this.entityKind.element);

    this.placementMode = new SegmentedControl('配置方法', PLACEMENT_MODE_ITEMS, (v) => this.selectPlacementMode(v));
    this.panel.appendChild(this.placementMode.element);

    this.sections = {
      elements: new ObjectPlacerElementsSection(celestialSystem, overlayManager),
      lagrange: new ObjectPlacerLagrangeSection(celestialSystem, overlayManager),
    };
    this.panel.appendChild(this.sections.elements.element);
    this.panel.appendChild(this.sections.lagrange.element);
    this.selectPlacementMode(this.placementModeValue);

    const nameRow = this.buildNameRow();
    this.nameInput = nameRow.nameInput;
    this.panel.appendChild(nameRow.element);

    this.issueList = document.createElement('div');
    this.issueList.className = 'issue-list ui-status-note ui-status-note--danger hidden';
    this.panel.appendChild(this.issueList);

    this.buildButtonsAndKeybinds();
  }

  // 名称行(ラベル + テキスト入力)を組み立てて返す。
  private buildNameRow(): { element: HTMLElement; nameInput: HTMLInputElement } {
    const nameRow = buildLabeledRow('名称');
    const nameField = new ValueInput({ type: 'text', placeholder: '空欄で自動命名' }, () => {});
    nameRow.appendChild(nameField.element);
    return { element: nameRow, nameInput: nameField.element };
  }

  // 配置ボタンを this.panel に追加する。Enter でも確定できるので、ラベルに [Enter] を出す。
  private buildButtonsAndKeybinds(): void {
    const btnRow = document.createElement('div');
    btnRow.className = 'shipplacer-btn-row';
    btnRow.appendChild(new Button('配置 [Enter]', () => this.confirm()).element);
    this.panel.appendChild(btnRow);
  }

  // 種類を切り替える。基準天体の選択肢は種類にかかわらず全公転天体のままなので、
  // ここでは選択の反映だけを行う。
  private selectEntityKind(v: ObjectPlacementSelection): void {
    this.entityKindValue = v;
    this.entityKind.setSelected(v);
  }

  // 配置方法(軌道要素/ラグランジュ点)を切り替え、選ばれなかった側のセクションを隠す。
  private selectPlacementMode(mode: PlacementMode): void {
    this.placementModeValue = mode;
    this.placementMode.setSelected(mode);
    for (const [key, section] of Object.entries(this.sections) as [PlacementMode, PlacementSection][]) {
      section.element.classList.toggle('hidden', key !== mode);
    }
  }

  // フォームの現在値を読み、onConfirm へ通知する。
  private confirm(): void {
    const name = this.nameInput.value.trim();
    const form = this.getForm();
    this.onConfirm?.(name, form);
    this.close();
  }

  // 現在のフォームの値を読み取って ObjectPlacerForm へ組む。入力欄の値は表示中の
  // セクションが読み取る。
  public getForm(): ObjectPlacerForm {
    return { selection: this.entityKindValue, ...this.sections[this.placementModeValue].readForm() };
  }

  // PlacementFieldId をハイライト対象の行要素へ対応させる。行は各セクションが持つ。
  private fieldRowFor(field: PlacementFieldId): HTMLElement | null {
    return this.sections.elements.fieldRowFor(field) ?? this.sections.lagrange.fieldRowFor(field);
  }

  // 検証結果を差分反映する。前回と同じ内容なら DOM に触らない(該当欄の枠色とメッセージ一覧を
  // まとめて持つ)。
  public setIssues(issues: readonly PlacementFieldIssue[]): void {
    // 'eccentricity' が指す行は要素セクションのサイズ/形の選びで変わるので、メッセージの
    // 一致だけでなく解決した行の一致まで差分判定に含める。
    const rows = issues
      .map((issue) => this.fieldRowFor(issue.field))
      .filter((row): row is HTMLElement => row !== null);
    const key = issues.map((issue) => `${issue.field}:${issue.message}`).join('|');
    const sameRows = rows.length === this.issueRows.length && rows.every((row, i) => row === this.issueRows[i]);
    if (key === this.lastIssueKey && sameRows) return;
    this.lastIssueKey = key;

    for (const row of this.issueRows) row.classList.remove('field-issue');
    this.issueRows = rows;
    for (const row of this.issueRows) row.classList.add('field-issue');

    this.issueList.innerHTML = '';
    for (const issue of issues) {
      const line = document.createElement('div');
      line.className = 'issue-line';
      line.textContent = issue.message;
      this.issueList.appendChild(line);
    }
    this.issueList.classList.toggle('hidden', issues.length === 0);
  }

  // パネルを開く。preset があればその種別ぶんだけ事前入力してから開く。
  public open(preset?: ObjectPlacerPreset): void {
    // 事前入力の範囲は preset の種別で決まる。
    if (preset?.kind === 'form') {
      this.selectEntityKind(preset.selection);
      this.selectPlacementMode('elements');
      this.sections.elements.applyForm(preset.form);
    } else if (preset?.kind === 'selection') {
      this.selectEntityKind(preset.selection);
    } else if (preset?.kind === 'body') {
      // 基準天体になれない天体の id が来たときは何も触らない。
      if (this.sections.elements.selectCelestialBody(preset.celestialBody)) {
        this.selectPlacementMode('elements');
      }
    }
    this.panel.classList.remove('hidden');
    this.overlayManager.open(OVERLAY_ID, this.panel, this, {
      kind: 'window', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false,
    });
    // 開くたび右上(上部クロームの下)の既定位置から始める。
    this.placeAtDefault();
  }

  // 開いたときの既定位置へ置く。CSS の右上アンカーへ戻してから、実寸を測って left/top に
  // 焼き付ける(以後はドラッグ・クランプが left/top だけを扱えるようにするため)。
  private placeAtDefault(): void {
    if (isCompactViewport()) {
      this.moveTo(0, 0);
      return;
    }
    this.panel.style.left = '';
    this.panel.style.right = '';
    const rect = this.panel.getBoundingClientRect();
    this.moveTo(rect.left, rect.top);
  }

  // 要求座標をビューポート内へクランプして配置する。compact では下端シートの位置を CSS へ
  // 委ねる(前回の非 compact 時の left/top/right が残っていれば消す)。
  private moveTo(clientX: number, clientY: number): void {
    if (isCompactViewport()) {
      this.panel.style.left = '';
      this.panel.style.top = '';
      this.panel.style.right = '';
      return;
    }
    // CSS 側の既定 right と両方効くのを避けるため、left へ焼き付けるなら右アンカーは無効にする。
    this.panel.style.right = 'auto';
    placeOverlayAt(this.panel, { x: clientX, y: clientY });
  }

  // 現在位置を要求座標としてビューポート内へクランプし直す。
  private reclamp(): void {
    this.moveTo(this.panel.offsetLeft, this.panel.offsetTop);
  }

  // パネルを閉じ、オーバーレイの登録も外す。開いていなければ何も起きない。
  public close(): void {
    if (!this.isOpen) return;
    this.panel.classList.add('hidden');
    this.overlayManager.close(OVERLAY_ID);
  }

  public contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // パネル DOM と登録を取り除き、各セクションの選択ポップアップもあわせて片付ける。
  public dispose(): void {
    this.close();
    this.unsubscribeViewport();
    this.panel.remove();
    for (const section of Object.values(this.sections)) section.dispose();
  }

  // 項目ショートカットを受ける。Enter なら確定して true を返す。
  public handleShortcut(code: string): boolean {
    if (code !== 'Enter') return false;
    this.confirm();
    return true;
  }
}
