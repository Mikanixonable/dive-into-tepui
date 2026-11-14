// 建造部品のカテゴリとカード表示を同期し、部品を選ぶ操作と、カードを画面へ
// 持ち上げるドラッグを通知する。設計図カテゴリは棚の一覧から組む。
import { Button, buildSpan, TabBar, ValueInput } from '../../../hud/widgets';
import { CLICK_MOVE_THRESHOLD } from '../../../input/input';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';
import { formatConstructionMetric, formatConstructionNumber } from './ship-construction-format';
import { moduleThumbnailUrl } from './ship-module-thumbnails';
import type { ShipModuleCategory, ShipModuleDefinition } from '../../ship/ship-module-definition';
import type { ConstructionCardDragEvent, ShipBlueprintCardView } from '../../ship/ship-construction-types';

// タッチがカードを持ち上げるまでの押し続け時間 [ms]。
const TOUCH_CARD_LIFT_MS = 300;

// カタログのタブ。設計図は部品のカテゴリではないが、同じ一覧面を切り替える。
type CatalogTab = ShipModuleCategory | 'blueprints';

// カテゴリタブは選ぶキー(1〜6)をキーキャップで、カテゴリを示すアイコンを添える。
const CATEGORY_ITEMS: readonly (readonly [CatalogTab, string, string?, string?])[] = [
  ['command', '指令', K.constructionCategory1.label, '◉'],
  ['fuel', '燃料', K.constructionCategory2.label, '▮'],
  ['propulsion', '推進', K.constructionCategory3.label, '▲'],
  ['combat', '戦闘', K.constructionCategory4.label, '⌖'],
  ['utility', '設備', K.constructionCategory5.label, '⬡'],
  ['blueprints', '設計図', K.constructionCategory6.label, '⧉'],
];

const CATEGORY_BY_KIND: Readonly<Record<ShipModuleDefinition['kind'], ShipModuleCategory>> = {
  cockpit: 'command', dock: 'command', docking_port: 'utility', tank: 'fuel', booster: 'propulsion',
  thruster: 'propulsion', rcs: 'propulsion', weapon: 'combat', armor: 'combat', radiator: 'utility',
  solar_panel: 'utility', decoupler: 'utility',
};

// カードの通知先。tap は押しただけ(動かさず離す)で手に取る操作。
interface ShipConstructionCatalogCallbacks {
  readonly onSelectModule: (definitionId: string) => void;
  readonly onSelectBlueprint: (blueprintId: string) => void;
  readonly onRenameBlueprint: (id: string, name: string) => void;
  readonly onDeleteBlueprint: (id: string) => void;
  readonly onCardDrag: (event: ConstructionCardDragEvent) => void;
}

export class ShipConstructionCatalog {
  private readonly categoryTabs: TabBar<CatalogTab>;
  private readonly definitions: readonly ShipModuleDefinition[] = SHIP_MODULE_CATALOG.all();
  private activeCategory: CatalogTab = 'command';
  private moduleSignature = '';
  private blueprintSignature = '';
  private readonly moduleButtons = new Map<string, Button>();
  private readonly blueprintHeld = new Map<string, Button>();
  // 改名中の設計図 id。表示資源を組み直すときだけ編集中のカードへ値入力を差す。
  private renamingId: string | null = null;
  private lastBlueprints: readonly ShipBlueprintCardView[] = [];

  // カテゴリとカードの表示領域を受け取り、選択とドラッグを通知する。
  public constructor(
    categoryRoot: HTMLElement,
    private readonly moduleCards: HTMLElement,
    private readonly callbacks: ShipConstructionCatalogCallbacks,
  ) {
    this.categoryTabs = new TabBar(CATEGORY_ITEMS, (category) => {
      this.activeCategory = category;
      this.renderModules(null);
      this.renderBlueprints(null, this.lastBlueprints);
    });
    this.categoryTabs.element.classList.add('construction-category-tabs');
    categoryRoot.appendChild(this.categoryTabs.element);
  }

  // タブの並び順の index のカテゴリを選ぶ。範囲外は無視する。
  public selectCategory(index: number): void {
    const item = CATEGORY_ITEMS[index];
    if (item === undefined) return;
    this.activeCategory = item[0];
    this.renderModules(null);
    this.renderBlueprints(null, this.lastBlueprints);
  }

  // 表示カテゴリと選択中の部品・設計図を反映する。
  public sync(
    selectedDefinitionId: string | null, heldBlueprintId: string | null,
    blueprints: readonly ShipBlueprintCardView[],
  ): void {
    this.categoryTabs.setSelected(this.activeCategory);
    this.lastBlueprints = blueprints;
    this.renderModules(selectedDefinitionId);
    this.renderBlueprints(heldBlueprintId, blueprints);
  }

  // 表示カテゴリの部品カードを組み、選択中の部品を押下表示にする。カードの並びが
  // 変わったときだけ DOM を組み直す。
  private renderModules(selectedId: string | null): void {
    if (this.activeCategory === 'blueprints') return;
    const definitions = this.definitions.filter(definition => moduleCategory(definition) === this.activeCategory);
    const signature = `modules:${this.activeCategory}:${definitions.map(definition => definition.id).join(',')}`;
    if (this.moduleSignature !== signature) {
      this.moduleCards.replaceChildren();
      this.moduleButtons.clear();
      for (const definition of definitions) {
        const card = document.createElement('div');
        card.className = 'construction-module-card';
        card.dataset['id'] = definition.id;
        // click の解釈は wireCardDrag 側の tap が担う(ドラッグ後の click を抑制するため、
        // Button の活性化と二重に呼ばない)。
        const button = new Button('', () => {}, undefined, 'secondary');
        button.element.title = moduleDescription(definition);
        // タイルはサムネイルと名称を常に出し、寸法・質量・主要能力は副行と title で読める。
        button.element.replaceChildren(
          ...withThumbnail(
            moduleThumbnail(definition.modelId),
            buildSpan('construction-module-name', definition.name),
            buildSpan(
              'construction-module-spec',
              `${formatDimension(definition.length)} m · ${formatConstructionMetric(definition.dryMass, 'kg')} · HP ${formatConstructionNumber(definition.maxHp)}`,
            ),
            buildSpan('construction-module-ability', moduleCardAbility(definition)),
          ),
        );
        this.wireCardDrag(
          button.element, () => this.callbacks.onSelectModule(definition.id),
          (phase, x, y) => this.callbacks.onCardDrag({
            source: { kind: 'module', definitionId: definition.id }, phase, clientX: x, clientY: y,
          }),
        );
        card.appendChild(button.element);
        this.moduleCards.appendChild(card);
        this.moduleButtons.set(definition.id, button);
      }
      this.moduleSignature = signature;
    }
    // 選択中の部品を押下表示にする。
    for (const [id, button] of this.moduleButtons) button.setOn(id === selectedId);
  }

  // 設計図カードを組み、手持ちの設計図を押下表示にする。カードの並びが変わった
  // ときだけ DOM を組み直す。
  private renderBlueprints(heldId: string | null, blueprints: readonly ShipBlueprintCardView[]): void {
    if (this.activeCategory !== 'blueprints') return;
    const signature = `blueprints:${this.renamingId ?? ''}:${
      blueprints.map(entry => `${entry.id}:${entry.name}:${entry.modelId ?? ''}:${entry.moduleCount}:${entry.mass}`).join(',')
    }`;
    if (this.blueprintSignature !== signature) {
      this.moduleCards.replaceChildren();
      this.moduleButtons.clear();
      this.blueprintHeld.clear();
      // 一覧が空なら案内の1行だけを出す。
      if (blueprints.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'construction-blueprint-empty';
        empty.textContent = '記録された設計図がここに並びます';
        this.moduleCards.appendChild(empty);
      }
      for (const blueprint of blueprints) {
        this.moduleCards.appendChild(this.blueprintCard(blueprint));
      }
      this.blueprintSignature = signature;
    }
    // 手持ちの設計図を押下表示にする。
    for (const [id, button] of this.blueprintHeld) button.setOn(id === heldId);
  }

  // 設計図1件のカード。押す/ドラッグで手に取り、改名・削除はカード内の操作で行う。
  private blueprintCard(blueprint: ShipBlueprintCardView): HTMLElement {
    const card = document.createElement('div');
    card.className = 'construction-module-card construction-blueprint-card';
    card.dataset['id'] = blueprint.id;
    // click の解釈は wireCardDrag 側の tap が担う。
    const body = new Button('', () => {}, undefined, 'secondary');
    body.element.title = `${blueprint.name} を手に取る`;
    this.wireCardDrag(
      body.element, () => this.callbacks.onSelectBlueprint(blueprint.id),
      (phase, x, y) => this.callbacks.onCardDrag({
        source: { kind: 'blueprint', blueprintId: blueprint.id }, phase, clientX: x, clientY: y,
      }),
    );
    // サムネイルは根元のモジュールのもので、モジュール数をバッジで添える。
    const thumb = moduleThumbnail(blueprint.modelId);
    if (thumb !== null) {
      thumb.appendChild(buildSpan('construction-module-count', `×${blueprint.moduleCount}`));
    }
    const nameEl = buildSpan('construction-module-name', blueprint.name);
    const specEl = buildSpan(
      'construction-module-spec',
      `${blueprint.moduleCount} 個の部品 · ${formatConstructionMetric(blueprint.mass, 'kg')}`,
    );
    if (this.renamingId === blueprint.id) {
      const input = new ValueInput(
        { type: 'text', placeholder: '設計図の名前' },
        (name) => {
          this.renamingId = null;
          this.callbacks.onRenameBlueprint(blueprint.id, name);
        },
        () => { this.renamingId = null; this.blueprintSignature = ''; this.renderBlueprints(null, this.lastBlueprints); },
      );
      input.setValue(blueprint.name);
      input.element.classList.add('construction-blueprint-rename');
      body.element.replaceChildren(...withThumbnail(thumb, input.element, specEl));
      requestAnimationFrame(() => input.element.focus());
    } else {
      body.element.replaceChildren(...withThumbnail(thumb, nameEl, specEl));
    }
    card.appendChild(body.element);

    const tools = document.createElement('div');
    tools.className = 'construction-blueprint-tools';
    const rename = new Button('改名', () => {
      this.renamingId = blueprint.id;
      this.blueprintSignature = '';
      this.renderBlueprints(null, this.lastBlueprints);
    }, undefined, 'dense');
    const remove = new Button('削除', () => this.callbacks.onDeleteBlueprint(blueprint.id), undefined, 'dense');
    tools.append(rename.element, remove.element);
    card.appendChild(tools);
    this.blueprintHeld.set(blueprint.id, body);
    return card;
  }

  // カードへ pointerdown → setPointerCapture のドラッグを配線する。マウスはクリック
  // 判定の閾値を超えて動いたら、タッチは TOUCH_CARD_LIFT_MS 押し続けたら持ち上げる。
  // 動かさず離しただけなら tap() を呼ぶ。ドラッグ後の click は抑制する。
  private wireCardDrag(
    element: HTMLElement, tap: () => void,
    notify: (phase: 'start' | 'move' | 'end', clientX: number, clientY: number) => void,
  ): void {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let dragging = false;
    let suppressClick = false;
    let liftTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelLift = (): void => {
      if (liftTimer !== null) clearTimeout(liftTimer);
      liftTimer = null;
    };

    element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointerId !== null) return;
      // カード内の入力欄・他のボタンを掴んだときはドラッグを始めない。
      if (e.target instanceof Element && e.target.closest('.w-input, .construction-blueprint-tools')) return;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      dragging = false;
      suppressClick = false;
      element.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        liftTimer = setTimeout(() => {
          if (pointerId === null) return;
          dragging = true;
          notify('start', lastX, lastY);
        }, TOUCH_CARD_LIFT_MS);
      }
    });

    element.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      lastX = e.clientX;
      lastY = e.clientY;
      if (!dragging && e.pointerType !== 'touch'
        && Math.hypot(e.clientX - startX, e.clientY - startY) >= CLICK_MOVE_THRESHOLD) {
        cancelLift();
        dragging = true;
        notify('start', e.clientX, e.clientY);
      }
      if (dragging) notify('move', e.clientX, e.clientY);
    });

    // ポインタを離したときの処理。ドラッグ中なら 'end' を通知し、直後の click を抑制する。
    const end = (e: PointerEvent): void => {
      if (pointerId !== e.pointerId) return;
      cancelLift();
      if (dragging) {
        notify('end', e.clientX, e.clientY);
        suppressClick = true;
      }
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        /* すでに解放済みなら無視 */
      }
      pointerId = null;
      dragging = false;
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    // click は pointerdown/up から独立して届く。ドラッグを終えた直後の click だけ
    // 握りつぶし、それ以外は「押して手に取る」として tap へ回す。
    element.addEventListener('click', (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.stopImmediatePropagation();
        return;
      }
    }, true);
    element.addEventListener('click', (e) => {
      if (suppressClick) return;
      e.stopPropagation();
      tap();
    });
  }
}

// modelId のサムネイル画像を包む要素。画像が無い modelId では null。
// カードのドラッグはポインタ操作で行うので、画像固有のドラッグは止める。
function moduleThumbnail(modelId: string | null): HTMLElement | null {
  const url = modelId === null ? null : moduleThumbnailUrl(modelId);
  if (url === null) return null;
  const wrap = document.createElement('span');
  wrap.className = 'construction-module-thumb';
  const image = document.createElement('img');
  image.src = url;
  image.alt = '';
  image.draggable = false;
  wrap.appendChild(image);
  return wrap;
}

// カードの中身の先頭へサムネイル(あれば)を乗せた子要素の列を返す。
function withThumbnail(thumb: HTMLElement | null, ...children: HTMLElement[]): HTMLElement[] {
  return thumb === null ? children : [thumb, ...children];
}

// カテゴリ指定が省略された部品にも分類を与える。
function moduleCategory(definition: ShipModuleDefinition): ShipModuleCategory {
  return definition.category ?? CATEGORY_BY_KIND[definition.kind];
}

// カードでは主要能力を1行に圧縮し、詳細は title へ残す。
function moduleCardAbility(definition: ShipModuleDefinition): string {
  const abilities = definition.abilities;
  const values: string[] = [];
  // 推進と燃料の能力。
  if (abilities.thrust !== undefined) values.push(`推力 ${formatConstructionMetric(abilities.thrust, 'N')}`);
  if (abilities.fuelCapacity !== undefined) {
    values.push(`${abilities.fuelKind === 'rcs' ? 'RCS' : '主'}燃料 ${formatConstructionMetric(abilities.fuelCapacity, '')}`);
  }
  // 電力・放熱と戦闘の能力。
  if (abilities.powerGeneration !== undefined) values.push(`発電 ${formatConstructionMetric(abilities.powerGeneration, 'W')}`);
  if (abilities.radiationArea !== undefined) values.push(`放熱 ${formatConstructionMetric(abilities.radiationArea, 'm²')}`);
  if (abilities.weaponDamage !== undefined) values.push(`威力 ${formatConstructionNumber(abilities.weaponDamage)}`);
  if (abilities.armorReduction !== undefined) values.push(`装甲 ${Math.round(abilities.armorReduction * 100)}%`);
  return values.slice(0, 2).join(' · ') || '構造モジュール';
}

// ホバー/読み上げ用に、部品が持つ主要能力を短い説明へまとめる。
function moduleDescription(definition: ShipModuleDefinition): string {
  const abilities = definition.abilities;
  const values: string[] = [];
  if (abilities.thrust !== undefined) values.push(`推力 ${formatConstructionMetric(abilities.thrust, 'N')}`);
  if (abilities.fuelCapacity !== undefined) values.push(`容量 ${formatConstructionMetric(abilities.fuelCapacity, '')}`);
  if (abilities.powerGeneration !== undefined) values.push(`発電 ${formatConstructionMetric(abilities.powerGeneration, 'W')}`);
  if (abilities.radiationArea !== undefined) values.push(`放熱面積 ${formatConstructionMetric(abilities.radiationArea, 'm²')}`);
  return values.length === 0 ? definition.name : values.join(' / ');
}

// 長さ [m] は整数なら小数点を省き、それ以外は小数1桁に丸める。
function formatDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
