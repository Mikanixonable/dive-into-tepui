// 画面へ重ねるマーカーの装置。持ち主ごとの群を配り、群を跨いで重なったラベル・アイコンを
// 間引き、残ったラベルを押し出して引き出し線を引く。
import { LabelDeclutter } from './label-declutter';
import { LabelLayout } from './label-layout';
import { MarkerGroup, type MarkerRecord } from './marker-group';
import type { MarkerSink } from './marker-sink';
import { injectMarkerStructureStyle } from './marker-style';
import type { MarkerVisibility } from './marker-visibility';

// ラベルの引き出し線を描く SVG を root に重ねて返す。
function buildSvgOverlay(root: HTMLElement): SVGSVGElement {
  const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgOverlay.setAttribute('aria-hidden', 'true');
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.inset = '0';
  svgOverlay.style.width = '100%';
  svgOverlay.style.height = '100%';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '0';
  root.appendChild(svgOverlay);
  return svgOverlay;
}

export class MarkerDevice implements MarkerVisibility {
  private readonly svgOverlay: SVGSVGElement;
  private readonly labelLayout: LabelLayout;
  private readonly declutter = new LabelDeclutter();
  private readonly groups: MarkerGroup[] = [];
  private readonly activeScratch: MarkerRecord[] = [];

  // root はマーカー要素と引き出し線を置く層。
  public constructor(private readonly root: HTMLElement) {
    injectMarkerStructureStyle();
    this.svgOverlay = buildSvgOverlay(root);
    this.labelLayout = new LabelLayout(this.svgOverlay);
  }

  // 持ち主1人ぶんの群を作る。持ち主は使い終えた群を自分で dispose する。
  public createGroup(): MarkerSink {
    const group = new MarkerGroup(this.root, (g) => this.forget(g));
    this.groups.push(group);
    return group;
  }

  // その id のマーカーを直前のフレームで画面へ出したか。遮蔽で薄れている途中も出していない扱い。
  public shows(id: string): boolean {
    return this.groups.some((group) => group.shows(id));
  }

  // 重なったラベル・アイコンを hideCrowded のときだけ間引き、残ったラベルを重ならない位置へ
  // 置き直す。全ての群が同期を終えてから1度だけ呼ぶ。
  public resolveOverlaps(hideCrowded: boolean): void {
    const active = this.activeScratch;
    active.length = 0;
    for (const group of this.groups) group.collectActive(active);
    const hidden = this.declutter.compute(active, hideCrowded);
    // 間引きの結果を CSS へ渡し、次フレームのヒステリシスが読む直前の状態として書き戻す。
    for (const m of active) {
      m.prevLabelHidden = hidden.labels.has(m.id);
      m.sym.classList.toggle('priority-hidden', hidden.icons.has(m.id));
      m.lbl.classList.toggle('priority-hidden', m.prevLabelHidden);
    }
    this.labelLayout.sync(active, hidden.labels);
  }

  // 全ての群と引き出し線を取り除く。root 自体は残す。
  public dispose(): void {
    for (const group of [...this.groups]) group.dispose();
    this.labelLayout.dispose();
    this.svgOverlay.remove();
  }

  // 畳まれた群を配り先の一覧から外す。
  private forget(group: MarkerGroup): void {
    const index = this.groups.indexOf(group);
    if (index >= 0) this.groups.splice(index, 1);
  }
}
