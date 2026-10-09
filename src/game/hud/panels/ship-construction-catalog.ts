// 建造部品のカテゴリとカード表示を同期し、部品を選ぶ操作を通知する。
import { Button, buildSpan, TabBar } from '../../../hud/widgets';
import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';
import { formatConstructionMetric, formatConstructionNumber } from './ship-construction-format';
import type { ShipModuleCategory, ShipModuleDefinition } from '../../ship/ship-module-definition';

const CATEGORY_ITEMS: readonly (readonly [ShipModuleCategory, string])[] = [
  ['command', '指令'], ['fuel', '燃料'], ['propulsion', '推進'], ['combat', '戦闘'], ['utility', '設備'],
];

const CATEGORY_BY_KIND: Readonly<Record<ShipModuleDefinition['kind'], ShipModuleCategory>> = {
  cockpit: 'command', dock: 'command', docking_port: 'utility', tank: 'fuel', booster: 'propulsion',
  thruster: 'propulsion', rcs: 'propulsion', weapon: 'combat', armor: 'combat', radiator: 'utility',
  solar_panel: 'utility', decoupler: 'utility',
};

export class ShipConstructionCatalog {
  private readonly categoryTabs: TabBar<ShipModuleCategory>;
  private readonly definitions: readonly ShipModuleDefinition[] = SHIP_MODULE_CATALOG.all();
  private activeCategory: ShipModuleCategory = 'command';
  private moduleSignature = '';
  private readonly moduleButtons = new Map<string, Button>();

  // カテゴリとカードの表示領域を受け取り、選択した部品の識別子を通知する。
  public constructor(
    categoryRoot: HTMLElement,
    private readonly moduleCards: HTMLElement,
    private readonly onSelectionChange: (definitionId: string) => void,
  ) {
    this.categoryTabs = new TabBar(CATEGORY_ITEMS, (category) => {
      this.activeCategory = category;
      this.moduleSignature = '';
      this.renderModules('');
    });
    this.categoryTabs.element.classList.add('construction-category-tabs');
    categoryRoot.appendChild(this.categoryTabs.element);
  }

  // 表示カテゴリと選択中の部品を反映する。
  public sync(selectedDefinitionId: string): void {
    this.categoryTabs.setSelected(this.activeCategory);
    this.renderModules(selectedDefinitionId);
  }

  // カード一覧と選択表示を同期し、同じ一覧では表示資源を維持する。
  private renderModules(selectedId: string): void {
    const definitions = this.definitions.filter(definition => moduleCategory(definition) === this.activeCategory);
    const signature = `${this.activeCategory}:${definitions.map(definition => definition.id).join(',')}`;
    if (signature !== this.moduleSignature) {
      // 表示カテゴリの部品を並べる。
      this.moduleCards.replaceChildren();
      this.moduleButtons.clear();
      for (const definition of definitions) {
        const card = document.createElement('div');
        card.className = 'construction-module-card';
        const button = new Button('', () => this.onSelectionChange(definition.id), undefined, 'secondary');
        button.element.title = moduleDescription(definition);
        // 名称・寸法・主要能力をカードへ載せる。
        button.element.replaceChildren(
          buildSpan('construction-module-name', definition.name),
          buildSpan(
            'construction-module-spec',
            `${formatDimension(definition.length)} m · ${formatConstructionMetric(definition.dryMass, 'kg')} · HP ${formatConstructionNumber(definition.maxHp)}`,
          ),
          buildSpan('construction-module-ability', moduleCardAbility(definition)),
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
