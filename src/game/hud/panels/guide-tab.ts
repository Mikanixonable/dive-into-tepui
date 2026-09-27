// 表示パネル(マップモード左レール)のガイドタブ。天球グリッド(参照面:黄道・赤道・月軌道・
// 月赤道、環境:星空)のトグルと、ゼロ速度曲線節を持つ。対象タブと同じ行の形
// (見出し+トグル列)を流用し、面/極/網/縮尺を1つの表にまとめる。
import { DIRECTION_GLYPH } from '../../marker/marker-identity';
import { Button } from '../../../hud/widgets';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';
import type { LagrangeLabel } from '../../../physics/lagrange';
import type { ZeroVelocitySettings } from '../../viewer/orbit-guide-settings';
import { DEFAULT_ORBIT_GUIDE_SETTINGS } from '../../viewer/orbit-guide-settings';
import { ZeroVelocitySection } from './zero-velocity-section';

// 天球グリッドの1行分。面/極/網/縮尺の4列のうち、月軌道・月赤道は縮尺しか持たないため
// 該当列は null(セル自体を空にする)。categoryKey が null の行(月軌道・月赤道)は面・極・網の
// ゲートを持たず、行見出し自身が縮尺トグルを兼ねる。
interface GridRow {
  readonly label: string;
  readonly categoryKey: keyof CelestialGridVisibility | null;
  readonly planeKey: keyof CelestialGridVisibility | null;
  readonly poleKey: keyof CelestialGridVisibility | null;
  readonly gridKey: keyof CelestialGridVisibility | null;
  readonly scaleKey: keyof CelestialGridVisibility;
}

const GRID_ROWS: readonly GridRow[] = [
  { label: '黄道', categoryKey: 'ecliptic', planeKey: 'eclipticPlane', poleKey: 'eclipticPole', gridKey: 'eclipticGrid', scaleKey: 'eclipticScaleGrid' },
  { label: '赤道', categoryKey: 'equator', planeKey: 'equatorPlane', poleKey: 'equatorPole', gridKey: 'equatorGrid', scaleKey: 'equatorScaleGrid' },
  { label: '月軌道面', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonOrbitScaleGrid' },
  { label: '月赤道面', categoryKey: null, planeKey: null, poleKey: null, gridKey: null, scaleKey: 'moonEquatorScaleGrid' },
];

interface ViewOptionColumn {
  readonly glyph: string;
  readonly label: string;
}

const GRID_COLUMNS: readonly ViewOptionColumn[] = [
  { glyph: '⌒', label: '面' },
  { glyph: DIRECTION_GLYPH.axis, label: '極' },
  { glyph: '⊞', label: '網' },
  { glyph: '十', label: '縮尺' },
];

// トグルのグリフと意味を並記する列見出し(天球グリッドの面/極/網/縮尺の凡例)。
function appendColumnLegend(parent: HTMLElement, columns: readonly ViewOptionColumn[]): void {
  const heading = document.createElement('div');
  heading.className = 'view-options-section-heading';
  const legend = document.createElement('span');
  legend.className = 'view-options-column-legend';
  // 各列のグリフとラベルを並べる。
  for (const column of columns) {
    const item = document.createElement('span');
    item.className = 'view-options-column';
    item.textContent = `${column.glyph} ${column.label}`;
    legend.appendChild(item);
  }
  // 見出し行を親へ組み込む。
  heading.appendChild(legend);
  parent.appendChild(heading);
}

export class GuideTab {
  // 天球グリッド・星空のトグルが切り替わるたびに、その項目と ON/OFF で呼ばれる。
  public onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  // ゼロ速度曲線節が編集されるたびに、書き換わった項目だけを載せて呼ばれる。
  public onZeroVelocityChange: ((change: Partial<ZeroVelocitySettings>) => void) | null = null;
  // ゼロ速度曲線節のラグランジュ点ボタンが押されたときに、その点で呼ばれる。
  public onSnapToLagrange: ((point: LagrangeLabel) => void) | null = null;

  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
  private readonly gridCategoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[];
  private readonly starsButton: Button;
  private readonly gridCurrent = new Map<keyof CelestialGridVisibility, boolean>();
  private readonly zeroVelocitySection: ZeroVelocitySection;

  // parent(ガイドタブの本体)の末尾へタブの内容を組み込む。
  public constructor(parent: HTMLElement) {
    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const gridCategories: (readonly [keyof CelestialGridVisibility, Button, HTMLElement])[] = [];

    // 天球グリッド各行: 見出し(面カテゴリまたは縮尺)+ 面/極/網/縮尺のアイコンボタン列。
    appendColumnLegend(parent, GRID_COLUMNS);
    for (const row of GRID_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row grid-class-row';
      const titleKey = row.categoryKey ?? row.scaleKey;
      const title = this.toggleButton(row.label, `${row.label}を表示`, titleKey);
      title.element.classList.add('body-class-title');
      rowEl.appendChild(title.element);
      if (row.categoryKey === null) gridButtons.push([row.scaleKey, title]);
      else gridCategories.push([row.categoryKey, title, rowEl]);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);
      for (const [key, glyph, itemTitle] of [
        [row.planeKey, '⌒', `${row.label}面`],
        [row.poleKey, DIRECTION_GLYPH.axis, `${row.label}極`],
        [row.gridKey, '⊞', `${row.label}グリッド`],
        [row.scaleKey, '十', `${row.label}の縮尺グリッド`],
      ] as const) {
        if (key === null || (row.categoryKey === null && key === row.scaleKey)) {
          btnsEl.appendChild(document.createElement('span')).className = 'body-class-icon-btn-empty';
          continue;
        }
        const button = this.toggleButton(glyph, itemTitle, key);
        button.element.classList.add('body-class-icon-btn');
        btnsEl.appendChild(button.element);
        gridButtons.push([key, button]);
      }
      parent.appendChild(rowEl);
    }

    // 星空トグルと、ゼロ速度曲線節(独立部品として埋め込む)。
    const starsRow = document.createElement('div');
    starsRow.className = 'body-class-row grid-class-row';
    const starsTitle = document.createElement('span');
    starsTitle.className = 'body-class-title';
    starsTitle.textContent = '星空';
    starsRow.appendChild(starsTitle);
    const starsButton = this.toggleButton('✦', '星空を表示', 'stars');
    starsButton.element.classList.add('body-class-icon-btn');
    const starsControls = document.createElement('div');
    starsControls.className = 'body-class-btns';
    starsControls.appendChild(starsButton.element);
    starsRow.appendChild(starsControls);
    parent.appendChild(starsRow);

    this.zeroVelocitySection = new ZeroVelocitySection(DEFAULT_ORBIT_GUIDE_SETTINGS.zeroVelocity);
    this.zeroVelocitySection.onChange = (change) => this.onZeroVelocityChange?.(change);
    this.zeroVelocitySection.onSnapToLagrange = (point) => this.onSnapToLagrange?.(point);
    parent.appendChild(this.zeroVelocitySection.element);

    this.gridButtons = gridButtons;
    this.gridCategoryButtons = gridCategories;
    this.starsButton = starsButton;
  }

  // 天球グリッドのトグル表示状態を現在値へ合わせる。
  public syncGrid(visibility: CelestialGridVisibility): void {
    // 星空トグル。
    this.gridCurrent.set('stars', visibility.stars);
    this.starsButton.setOn(visibility.stars);
    // 面/極/網/縮尺の個別トグル。
    for (const [key, btn] of this.gridButtons) {
      const on = visibility[key];
      this.gridCurrent.set(key, on);
      btn.setOn(on);
    }
    // 行見出しの点灯と、ゲートを閉じた行のグレーアウト。
    for (const [key, category, row] of this.gridCategoryButtons) {
      const on = visibility[key];
      this.gridCurrent.set(key, on);
      category.setOn(on);
      row.classList.toggle('category-off', !on);
    }
  }

  // ゼロ速度曲線節の表示状態を現在値へ合わせる。
  public syncZeroVelocity(s: ZeroVelocitySettings): void {
    this.zeroVelocitySection.sync(s);
  }

  // クリックのたびに点灯を反転する小型トグルボタンを組む。description はホバー説明とタッチ向け
  // aria-label の両方に使う。gridCurrent は反転元として読む鏡映しで、ここで直接更新する。
  private toggleButton(glyph: string, description: string, key: keyof CelestialGridVisibility): Button {
    const btn = new Button(glyph, () => {
      const next = !(this.gridCurrent.get(key) ?? false);
      this.gridCurrent.set(key, next);
      btn.setOn(next);
      this.onGridToggle?.(key, next);
    });
    btn.element.title = description;
    btn.element.setAttribute('aria-label', description);
    return btn;
  }
}
