// 軌道計画ノードの対話的 DOM レイヤ。ノードハンドル(ドラッグ円)・選択中ノードの
// Δv アーム 6 個・ノードのコンテキストメニュー(ワープ/削除)を担当する。
//
// アーキテクチャ方針: キャンバス上でのヒットテストではなく、専用の
// pointer-events:auto な DOM 要素を画面座標に絶対配置する。呼び出し側(plan-editor)は
// 毎フレーム画面座標を渡すだけで、このクラスは DOM 生成・pointer イベント処理・
// コールバック発火だけを担当する。
// DOM 要素側の pointerdown で stopPropagation して Input のキャンバスドラッグ
// (視点回転)へイベントが漏れないようにする。
import * as C from '../const';
import { ACCENT, ACCENT_SOFT, ACCENT_RGB, TEXT as INK } from '../theme';
import { ContextMenu } from '../map-mode/context-menu';

// SURFACE/EDGE はこのファイル固有の不透明度を使うため、theme.ts とは別定数のまま保持する。
const SURFACE = 'rgba(13, 15, 18, 0.85)';
const EDGE = 'rgba(255, 255, 255, 0.16)';

// z-index は #hud(10)より下、キャンバス(0)より上の 9(context-menu.ts と同方針)。
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

// axis: 0=プログレード軸(dv.x) 1=法線軸(dv.y) 2=動径軸(dv.z)。
// sign: このハンドル自身の向きが正規の軸の正方向と同じなら+1、逆なら-1
// (例: PRO=+1 / RET=-1、いずれも dv の同じ成分を操作する)。
// dirx/diry: ノードからこのハンドルへ向かう単位方向(スクリーン座標)。
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

  // ノードハンドル: クリック=選択、ドラッグ=時刻移動、右クリック/右ボタン押下=コンテキストメニュー要求。
  onNodeSelect: ((idx: number) => void) | null = null;
  onNodeDragMove: ((idx: number, clientX: number, clientY: number) => void) | null = null;
  onNodeContextMenu: ((clientX: number, clientY: number) => void) | null = null;
  // Δv アーム: ドラッグの度に、ハンドル自身の向きへの射影量(符号付き px)を渡す。
  onAxisDrag: ((axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number) => void) | null = null;
  // コンテキストメニュー項目(キャンセルはメニューを閉じるだけなのでコールバック不要)。
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

  // 毎フレーム呼ぶ: ノードハンドル群(前フレームに存在したが今回無いものは破棄)と、
  // 選択中ノードがあれば Δv アーム 6 個(無ければ全破棄)を反映する。
  update(nodes: NodeHandleSpec[], axes: AxisHandleSpec[] | null): void {
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
