// 軌道計画ノードの対話的 DOM レイヤ。ノードハンドル・Δv アーム・コンテキストメニューを
// 画面座標に絶対配置し、pointer イベントを処理してコールバックを発火する。
import * as C from '../const';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, TEXT as INK } from '../theme';
import { ContextMenu } from '../hud/context-menu';

const SURFACE = 'rgba(13, 15, 18, 0.85)';
const EDGE = 'rgba(255, 255, 255, 0.16)';

const STYLE = `
#node-gizmo {
  position: fixed; inset: 0; pointer-events: none; z-index: 9;
  font-family: 'Consolas', 'Courier New', monospace; user-select: none;
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
  min-width: 30px; padding: 2px 7px; text-align: center; touch-action: none;
  pointer-events: auto; cursor: grab;
  border: 1px solid ${EDGE}; border-radius: 4px; background: ${SURFACE};
  color: ${INK}; font-size: 10px; letter-spacing: 1px;
}
#node-gizmo .gz-axis:active { border-color: ${ACCENT}; color: ${ACCENT_SOFT}; }
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

interface NodeEntry {
  el: HTMLDivElement;
  lbl: HTMLDivElement;
}

let styleInjected = false;

export class NodeGizmo {
  private readonly root: HTMLDivElement;
  private readonly nodeLayer: HTMLDivElement;
  private readonly axisLayer: HTMLDivElement;
  private readonly menu = new ContextMenu();
  private readonly nodeEls = new Map<number, NodeEntry>();
  private readonly axisEls: HTMLDivElement[] = [];
  private menuNodeIdx: number | null = null;

  onNodeSelect: ((idx: number) => void) | null = null;
  onNodeDragMove: ((idx: number, clientX: number, clientY: number) => void) | null = null;
  onNodeContextMenu: ((clientX: number, clientY: number) => void) | null = null;
  onAxisDrag: ((axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number) => void) | null = null;
  onMenuWarpTo: ((idx: number) => void) | null = null;
  onMenuDelete: ((idx: number) => void) | null = null;

  constructor() {
    if (!styleInjected) {
      styleInjected = true;
      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    this.root = document.createElement('div');
    this.root.id = 'node-gizmo';
    document.body.appendChild(this.root);

    this.nodeLayer = document.createElement('div');
    this.root.appendChild(this.nodeLayer);
    this.axisLayer = document.createElement('div');
    this.root.appendChild(this.axisLayer);

    this.menu.onSelect = (act) => {
      const idx = this.menuNodeIdx;
      this.menuNodeIdx = null;
      if (act === 'warp' && idx !== null) this.onMenuWarpTo?.(idx);
      else if (act === 'delete' && idx !== null) this.onMenuDelete?.(idx);
    };
  }

  openMenu(clientX: number, clientY: number, idx: number): void {
    this.menuNodeIdx = idx;
    this.menu.open(clientX, clientY, [
      { label: 'この時刻まで自動ワープ', act: 'warp' },
      { label: 'ノードを削除', act: 'delete' },
      { label: 'キャンセル', act: 'cancel' },
    ]);
  }

  closeMenu(): void {
    this.menu.close();
    this.menuNodeIdx = null;
  }

  sync(nodes: NodeHandleSpec[], axes: AxisHandleSpec[] | null): void {
    const seen = new Set<number>();
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

  private createAxisEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'gz-axis';
    this.axisLayer.appendChild(el);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
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
      this.onAxisDrag?.(axis, sign, proj);
    });
    const end = (e: PointerEvent): void => {
      dragging = false;
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
