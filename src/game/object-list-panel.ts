import { hudDock } from './hud/dom';
import { MapPickable, MapPickKind } from './map-pick';

const SECTIONS: readonly { kind: MapPickKind; label: string }[] = [
  { kind: 'body', label: '天体' },
  { kind: 'player', label: '自艦' },
  { kind: 'ship', label: '敵' },
  { kind: 'ammo', label: '弾薬' },
  { kind: 'base', label: '基地' },
];

interface Section {
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly rows: Map<string, HTMLElement>;
  expanded: boolean;
}

// マップビュー右部に常設の軌道オブジェクト一覧ウィンドウ。種別ごとの区画にタブ見出しで
// 開閉し、行クリックで onSelect に id を渡す。
export class ObjectListPanel {
  onSelect: ((id: string) => void) | null = null;
  onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly sections = new Map<MapPickKind, Section>();

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-object-list';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h3');
    title.textContent = '軌道オブジェクト';
    this.panel.appendChild(title);

    for (const { kind } of SECTIONS) {
      const header = document.createElement('div');
      header.className = 'dock-tab-btn object-list-section-header';
      const body = document.createElement('div');
      body.className = 'object-list-section-body';
      const section: Section = { header, body, rows: new Map(), expanded: true };
      header.addEventListener('click', () => {
        section.expanded = !section.expanded;
        this.applyExpanded(section);
      });
      this.sections.set(kind, section);
      this.panel.appendChild(header);
      this.panel.appendChild(body);
      this.applyExpanded(section);
    }

    hudDock(root, 'right').appendChild(this.panel);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 種別ごとの区画へ、既存行は使い回しつつ id 差分だけ足し引きする。行のクリックリスナーは
  // 生成時の1回だけ張るので、ここで毎フレーム innerHTML を書き換えてはいけない
  // (張り直しになり、クリック中に要素が消えてイベントが発火しなくなる)。
  // depthOf に載っている id は、その深さぶん字下げして親子関係を出す(天体セクション)。
  // focusId が undefined(フォーカス中の天体が無い)なら、どの行も強調しない。
  sync(items: readonly MapPickable[], focusId: string | undefined, depthOf: ReadonlyMap<string, number>): void {
    const byKind = new Map<MapPickKind, MapPickable[]>();
    for (const item of items) {
      const list = byKind.get(item.kind);
      if (list) list.push(item); else byKind.set(item.kind, [item]);
    }

    for (const { kind, label } of SECTIONS) {
      const section = this.sections.get(kind)!;
      const list = byKind.get(kind) ?? [];
      section.header.style.display = list.length === 0 ? 'none' : '';
      section.header.textContent = `${label} (${list.length}) ${section.expanded ? '▾' : '▸'}`;

      const seen = new Set<string>();
      for (const item of list) {
        seen.add(item.id);
        let row = section.rows.get(item.id);
        if (!row) {
          row = document.createElement('div');
          row.className = 'erow';
          row.addEventListener('click', () => this.onSelect?.(item.id));
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.onSelectRight?.(item.id, e.clientX, e.clientY);
          });
          section.rows.set(item.id, row);
          section.body.appendChild(row);
        }
        if (row.textContent !== item.name) row.textContent = item.name;
        const indent = 4 + (depthOf.get(item.id) ?? 0) * 10;
        if (row.style.paddingLeft !== `${indent}px`) row.style.paddingLeft = `${indent}px`;
        row.classList.toggle('tgt', item.id === focusId);
      }
      for (const [id, row] of section.rows) {
        if (!seen.has(id)) {
          row.remove();
          section.rows.delete(id);
        }
      }
    }
  }

  private applyExpanded(section: Section): void {
    section.body.style.display = section.expanded ? '' : 'none';
    section.header.classList.toggle('active', section.expanded);
  }
}
