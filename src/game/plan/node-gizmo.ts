// 軌道計画ノードの対話的 DOM レイヤ。ノードハンドル・Δv アーム・コンテキストメニューを
// 画面座標に絶対配置し、pointer イベントを処理してコールバックを発火する。
import * as C from '../const';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, TEXT as INK, FONT } from '../theme';
import { ContextMenu } from '../hud/context-menu';
import { MenuAction, MenuCommon } from '../hud/menu-actions';

const STYLE = `
#hud #node-gizmo {
  position: fixed; inset: 0; pointer-events: none; z-index: 5;
  font-family: ${FONT}; user-select: none;
  -webkit-user-select: none;
}
#node-gizmo .gz-node {
  position: absolute; transform: translate(-50%, -50%);
  width: 22px; height: 22px; border-radius: 50%; touch-action: none;
  pointer-events: auto; cursor: grab;
  border: 2px solid ${ACCENT_SOFT}; background: rgba(${ACCENT_RGB}, 0.16);
}
#node-gizmo .gz-node.sel { border-color: ${ACCENT}; background: rgba(${ACCENT_RGB}, 0.38); }
#node-gizmo .gz-node .gz-lbl {
  position: absolute; top: 26px; left: 50%; transform: translateX(-50%);
  font-size: 10px; color: ${INK}; white-space: nowrap;
  text-shadow: 0 0 4px #000, 0 0 2px #000;
}
#node-gizmo .gz-axis {
  position: absolute; transform: translate(-50%, -50%);
  width: 44px; height: 44px; border-radius: 22px; touch-action: none;
  pointer-events: auto; cursor: grab;
  /* 背景は透明にしつつ、ラベルのテキストは表示する */
  background: transparent; border: none;
  color: ${INK}; font-size: 10px; font-weight: bold; letter-spacing: 1px;
  display: flex; align-items: center; justify-content: center;
  text-shadow: 0 0 2px #000, 0 0 4px #000;
}
#node-gizmo .gz-axis:active { cursor: grabbing; color: ${ACCENT_SOFT}; }
`;

export interface NodeHandleSpec {
  idx: number;
  x: number;
  y: number;
  selected: boolean;
  dvMag: number;
}

export interface AxisHandleSpec {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  x: number;
  y: number;
  dirx: number;
  diry: number;
  label: string;
}

// ラッチ中の Δv アーム。呼び出し側は毎フレーム読み、excessPx に応じたレートで積分する。
export interface AxisLatchState {
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  readonly excessPx: number;
}

interface NodeEntry {
  el: HTMLDivElement;
  lbl: HTMLDivElement;
}

let styleInjected = false;

export class NodeGizmo {
  private readonly root: HTMLDivElement;
  private readonly nodeLayer: HTMLDivElement;
  private readonly axisLayer: HTMLDivElement;
  private readonly menu: ContextMenu<number, MenuAction>;
  private readonly nodeEls = new Map<number, NodeEntry>();
  private readonly axisEls: HTMLDivElement[] = [];

  onNodeSelect: ((idx: number) => void) | null = null;
  onNodeDragMove: ((idx: number, clientX: number, clientY: number) => void) | null = null;
  onNodeContextMenu: ((clientX: number, clientY: number) => void) | null = null;
  onAxisDrag: ((axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number) => void) | null = null;
  onMenuWarpTo: ((idx: number) => void) | null = null;
  onMenuDelete: ((idx: number) => void) | null = null;
  onMenuFocus: ((idx: number) => void) | null = null;

  latch: AxisLatchState | null = null;
  activeAxis: { axis: 0 | 1 | 2, sign: 1 | -1 } | null = null;

  // DOM レイヤとコンテキストメニューを構築する。root はハンドル/アーム自体を置くレイヤ、
  // popupLayer はノードのコンテキストメニューを置くレイヤ(overlay-layer.ts のレイヤ構造に従う)。
  constructor(root: HTMLElement, popupLayer: HTMLElement) {
    if (!styleInjected) {
      styleInjected = true;
      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    this.root = document.createElement('div');
    this.root.id = 'node-gizmo';
    root.appendChild(this.root);

    this.nodeLayer = document.createElement('div');
    this.root.appendChild(this.nodeLayer);
    this.axisLayer = document.createElement('div');
    this.root.appendChild(this.axisLayer);

    this.menu = new ContextMenu<number, MenuAction>(popupLayer);
    // メニュー選択を対応するノード操作コールバックへ橋渡しする。
    this.menu.onSelect = (act, idx) => {
      if (act === 'warp') this.onMenuWarpTo?.(idx);
      else if (act === 'delete') this.onMenuDelete?.(idx);
      else if (act === 'focus') this.onMenuFocus?.(idx);
    };
  }

  // 指定ノードに対するコンテキストメニューを開く。
  openMenu(clientX: number, clientY: number, idx: number): void {
    this.menu.open(clientX, clientY, idx, [
      MenuCommon.warp(),
      MenuCommon.deleteNode(),
      MenuCommon.focus(),
      MenuCommon.cancel(),
    ]);
  }

  // コンテキストメニューを閉じる。
  closeMenu(): void {
    this.menu.close();
  }

  // ノードハンドル・Δv アームの DOM を渡された仕様に同期する。仕様に無くなった要素は破棄する。
  sync(nodes: NodeHandleSpec[], axes: AxisHandleSpec[] | null): void {
    const seen = new Set<number>();
    // ノードハンドルを仕様に合わせて追加・更新する。
    for (const n of nodes) {
      seen.add(n.idx);
      let entry = this.nodeEls.get(n.idx);
      if (!entry) {
        entry = this.createNodeEl(n.idx);
        this.nodeEls.set(n.idx, entry);
      }
      entry.el.style.left = `${n.x}px`;
      entry.el.style.top = `${n.y}px`;
      entry.el.classList.toggle('sel', n.selected);
      entry.lbl.textContent = `NODE${n.idx + 1} ${n.dvMag.toFixed(1)}m/s`;
    }
    for (const [idx, entry] of this.nodeEls) {
      if (!seen.has(idx)) {
        entry.el.remove();
        this.nodeEls.delete(idx);
      }
    }

    // Δv アームの要素数を仕様に合わせて増減し、位置・向きを更新する。
    const count = axes?.length ?? 0;
    while (this.axisEls.length > count) {
      this.axisEls.pop()!.remove();
    }
    if (axes) {
      axes.forEach((a, i) => {
        let el = this.axisEls[i];
        if (!el) {
          el = this.createAxisEl();
          this.axisEls[i] = el;
        }
        el.style.left = `${a.x}px`;
        el.style.top = `${a.y}px`;
        el.textContent = a.label;
        el.dataset['axis'] = String(a.axis);
        el.dataset['sign'] = String(a.sign);
        el.dataset['dirx'] = String(a.dirx);
        el.dataset['diry'] = String(a.diry);
      });
    }
  }

  // ノードハンドルの DOM を作り、ドラッグ移動・クリック選択・右クリックメニューの
  // イベント処理を配線して返す。
  private createNodeEl(idx: number): NodeEntry {
    const el = document.createElement('div');
    el.className = 'gz-node';
    const lbl = document.createElement('div');
    lbl.className = 'gz-lbl';
    el.appendChild(lbl);
    this.nodeLayer.appendChild(el);

    let dragging = false;
    let moved = 0;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button === 2) {
        e.preventDefault();
        this.onNodeContextMenu?.(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;
      dragging = true;
      moved = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (moved > C.NODE_GIZMO_DRAG_THRESHOLD_PX) this.onNodeDragMove?.(idx, e.clientX, e.clientY);
    });
    // ドラッグ量が閾値以下ならクリックとみなしてノード選択を発火する。
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      if (moved <= C.NODE_GIZMO_DRAG_THRESHOLD_PX) this.onNodeSelect?.(idx);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* すでに解放済みなら無視 */
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return { el, lbl };
  }

  // Δv アームハンドルの DOM を作り、軸方向へのドラッグ量を通知するイベント処理を
  // 配線して返す。
  private createAxisEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'gz-axis';
    this.axisLayer.appendChild(el);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let totalProj = 0;
    let latched = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const axis = Number(el.dataset['axis'] ?? 0) as 0 | 1 | 2;
      const sign = Number(el.dataset['sign'] ?? 1) as 1 | -1;
      dragging = true;
      latched = false;
      totalProj = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      this.activeAxis = { axis, sign };
      el.setPointerCapture(e.pointerId);
    });
    // 基点からの累積変位が DV_DRAG_LATCH_PX を超えるとラッチへ入る。ラッチ前は従来通り
    // 変位そのものを onAxisDrag へ渡し、ラッチ後は超過量を latch として公開するだけにする
    // (レートでの積分は毎フレーム呼び出し側が行う)。
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const dirx = Number(el.dataset['dirx'] ?? 0);
      const diry = Number(el.dataset['diry'] ?? 0);
      const axis = Number(el.dataset['axis'] ?? 0) as 0 | 1 | 2;
      const sign = Number(el.dataset['sign'] ?? 1) as 1 | -1;
      const proj = dx * dirx + dy * diry;
      totalProj += proj;
      if (!latched && Math.abs(totalProj) > C.DV_DRAG_LATCH_PX) latched = true;
      if (!latched) {
        this.onAxisDrag?.(axis, sign, proj);
      } else {
        this.latch = { axis, sign, excessPx: Math.abs(totalProj) - C.DV_DRAG_LATCH_PX };
      }
    });
    // ドラッグ終了時にポインタキャプチャを解放し、ラッチを解除する。
    const end = (e: PointerEvent): void => {
      dragging = false;
      latched = false;
      this.latch = null;
      this.activeAxis = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* すでに解放済みなら無視 */
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }
}
