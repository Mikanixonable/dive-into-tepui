// ドックビュー: 基地に接岸した際に開くフルスクリーンUI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Vessel, DockedVesselEntry } from '../vessel/vessel';
import type { AnyPart, Part, PartType, RcsTankPart } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from '../vessel/assembly';
import type { MountPoint, TreeNode } from '../vessel/tree';
import type { SectionPrimitivePatch } from '../vessel/assembly-editor';
import { Button, CloseButton, Meter, TabBar, ValueInput } from './widgets';
import { buildPartFrom, producibleParts } from '../vessel/default-blueprints';
import { baseFacilities, basePowerAvailable } from '../vessel/base-module';
import { producibility, type Requirement } from '../economy/producibility';
import {
  consumeProductionResources, partProductionBlueprintOf, productionResourceDemand,
  refuelBlueprintOf, repairAllBlueprintOf, repairBlueprintOf,
} from '../vessel/production';
import type { ProducibilityBlueprint } from '../economy/producibility';
import { RESOURCES, RESOURCE_IDS, type ResourceId } from '../economy/resource';
import { MQ_COMPACT, MQ_SHORT } from './breakpoints';
import { ObjectPicker, type ObjectPickerGroup } from './object-picker';
import type { OverlayManager } from './overlay-manager';

const STYLE = `
/* 戦闘・マップと対等な全画面ビュー。情報面は Solid を基調にし、
   選択中の艦とその整備コンテキストだけ Focus Glass へ持ち上げる。 */
#base-view.base-view-overlay {
  position: fixed; inset: 0;
  display: flex;
  box-sizing: border-box;
  background: rgba(5, 8, 12, 0.86);
  color: var(--body);
  font-family: var(--font-neutral, var(--font-family));
  pointer-events: auto;
  padding: max(var(--space-6), var(--safe-t)) max(var(--space-5), var(--safe-r)) max(var(--space-5), var(--safe-b)) max(var(--space-5), var(--safe-l));
}
#base-view .dock-panel {
  width: min(100%, 1160px); min-width: 0; min-height: 0; margin: 0 auto;
  display: flex; flex-direction: column;
}
#base-view .dock-header {
  display: grid; grid-template-columns: minmax(180px, 0.72fr) minmax(300px, 1.4fr) auto;
  align-items: center; gap: var(--space-6);
  flex: 0 0 auto; padding: 15px 17px 11px;
  border-radius: var(--radius-window) var(--radius-window) 0 0;
  background: var(--surface-1);
}
#base-view .dock-title-group { min-width: 0; }
#base-view .dock-kicker {
  display: block; margin-bottom: var(--space-2);
  color: var(--accent); font-size: var(--font-xs); line-height: 1.3;
}
#base-view .dock-title {
  display: block; margin: 0; color: var(--title);
  font-size: var(--font-2xl); font-weight: 500; line-height: 1; letter-spacing: -0.035em;
}
#base-view .dock-subtitle {
  display: block; margin-top: var(--space-2);
  color: var(--muted); font-size: var(--font-s); line-height: 1.4;
}
#base-view .dock-tabs { min-width: 0; justify-content: center; }
#base-view .dock-tabs .w-btn {
  min-height: 34px; padding: 7px 11px;
  border: 0; border-radius: var(--radius-control);
  background: transparent; color: var(--muted);
}
#base-view .dock-tabs .w-btn:hover { background: var(--surface-2); color: var(--accent-near); }
#base-view .dock-tabs .w-btn.on { background: var(--accent-fill); color: var(--accent); }
#base-view .w-close {
  width: 34px; height: 34px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--muted);
}
#base-view .w-close:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view .dock-status-bar {
  flex: 0 0 auto; padding: 0 17px 13px;
  border-radius: 0 0 var(--radius-window) var(--radius-window);
  background: var(--surface-1); color: var(--muted);
  font-size: var(--font-s); font-variant-numeric: tabular-nums;
}
#base-view .dock-status-bar::before {
  content: "∗"; margin-right: var(--space-3); color: var(--accent-secondary);
}
#base-view .dock-body {
  flex: 1 1 0; min-height: 0; margin-top: 9px; padding: var(--space-6) 0;
  overflow-y: auto; scrollbar-width: thin; outline: none;
}
#base-view .dock-workbench-stage {
  min-height: 250px; display: grid; place-items: center; margin: 4px 0 12px;
  border: 1px dashed var(--accent-secondary); border-radius: var(--radius-window);
  background: rgba(12, 18, 25, 0.62); color: var(--accent-near); text-align: center;
}
#base-view .dock-parts-actions { display: flex; justify-content: flex-end; gap: 7px; }
#base-view .dock-workbench-part-wrap { display: flex; flex-direction: column; gap: 4px; margin-bottom: 7px; }
#base-view .dock-workbench-transfer { display: flex; justify-content: flex-end; gap: 5px; }
#base-view .dock-workbench-targets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#base-view .dock-workbench-targets select { flex: 1 1 260px; min-width: 0; }
#base-view .dock-workbench-edit { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
#base-view .dock-workbench-edit label { display: flex; flex-direction: column; gap: 3px; color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-workbench-edit input { min-width: 0; }
#base-view .dock-workbench-edit-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
#base-view .dock-workbench-selection { padding: 10px 12px; border-radius: var(--radius-panel); background: var(--surface-1); color: var(--body); }
#base-view .dock-workbench-selection strong { color: var(--accent); }
#base-view .dock-part-property-window {
  position: fixed; right: max(var(--space-5), var(--safe-r)); bottom: max(var(--space-5), var(--safe-b));
  z-index: 3; min-width: 230px; padding: 13px 15px; border: 1px solid var(--accent-secondary);
  border-radius: var(--radius-window); background: var(--surface-1); color: var(--body);
  line-height: 1.65; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
#base-view .dock-body:focus-visible,
#base-view .dock-ship-select:focus-visible,
#base-view .dock-part-swap-select:focus-visible,
#base-view .w-btn:focus-visible,
#base-view .w-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
#base-view .dock-section { display: flex; flex-direction: column; gap: 9px; }
#base-view .dock-section-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-6);
  padding: 0 var(--space-2) var(--space-5);
}
#base-view .dock-section-copy { min-width: 0; }
#base-view .dock-section-title {
  margin: 0; color: var(--title); font-size: var(--font-xl); font-weight: 600; line-height: 1.3;
}
#base-view .dock-section-description {
  margin: var(--space-2) 0 0; color: var(--muted); font-size: var(--font-s); line-height: 1.55;
}
#base-view .dock-section-count {
  flex: 0 0 auto; padding: 5px 8px; border-radius: var(--radius-control);
  background: var(--surface-1); color: var(--muted); font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
#base-view .dock-empty {
  padding: var(--space-6); border-radius: var(--radius-panel);
  background: var(--surface-1); color: var(--muted); text-align: center; line-height: 1.8;
}
/* Ships tab */
#base-view .dock-ship-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-ship-row {
  position: relative; display: flex; align-items: center; gap: var(--space-5);
  padding: 9px 12px; border-radius: var(--radius-panel); background: var(--surface-1);
  transition: color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}
#base-view .dock-ship-row:hover:not(.is-selected) { background: var(--surface-2); }
#base-view .dock-ship-row.is-selected {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-row.is-selected::before {
  content: ""; position: absolute; top: 12px; bottom: 12px; left: 6px; width: 3px;
  border-radius: var(--radius-control); background: var(--accent);
}
#base-view .dock-ship-select {
  flex: 1 1 auto; min-width: 0; display: block; padding: var(--space-3) var(--space-4);
  border: 0; border-radius: var(--radius-control); background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
#base-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-ship-name { color: var(--title); font-size: var(--font-l); font-weight: 500; }
#base-view .dock-ship-row:not(.is-selected) .dock-ship-select:hover .dock-ship-name { color: var(--accent-near); }
#base-view .dock-ship-row.is-selected .dock-ship-name { color: var(--accent); }
#base-view .dock-ship-hp { color: var(--muted); font-size: var(--font-s); font-variant-numeric: tabular-nums; }
#base-view .dock-ship-row.is-critical .dock-ship-hp { color: var(--danger); }
#base-view .dock-ship-actions { display: flex; flex: 0 0 auto; gap: 5px; }
/* Parts tab */
#base-view .dock-parts-header {
  display: flex; align-items: center; gap: var(--space-5); padding: 11px 13px;
  border-radius: var(--radius-panel); background: var(--surface-1);
}
#base-view .dock-parts-header.dock-focus-panel {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-label { flex: 1; color: var(--body); font-size: var(--font-m); }
#base-view .dock-ship-label strong { color: var(--accent); font-weight: 600; }
#base-view .dock-part-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-part-row {
  display: flex; flex-direction: column; gap: var(--space-3); padding: 9px 11px;
  border-radius: var(--radius-panel); background: var(--surface-2);
}
#base-view .dock-part-info { display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-part-name { color: var(--title); font-size: var(--font-m); font-weight: 500; }
#base-view .dock-part-type { color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-part-hp-meter .w-meter-track { height: 7px; border-radius: var(--radius-control); overflow: hidden; }
#base-view .dock-part-hp-meter .w-meter-fill { border-radius: var(--radius-control); transition: width var(--transition-slow); }
#base-view .dock-part-hp-text { color: var(--muted); font-size: var(--font-s); text-align: right; font-variant-numeric: tabular-nums; }
#base-view .dock-part-row-main {
  display: grid; grid-template-columns: minmax(120px, 1fr) minmax(96px, 140px);
  align-items: center; gap: var(--space-5);
}
#base-view .dock-warehouse-row-main { grid-template-columns: minmax(120px, 1fr) auto; }
#base-view .dock-part-actions {
  grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex-wrap: wrap;
}
#base-view .dock-part-swap-row {
  display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3);
  border-radius: var(--radius-control); background: var(--surface-1);
  color: var(--muted); font-size: var(--font-s);
}
#base-view .dock-part-swap-select {
  flex: 1; min-width: 0; padding: 7px 9px;
  border: 0; border-radius: var(--radius-control);
  background: var(--surface-3); color: var(--title); font: inherit; font-size: var(--font-s);
}
#base-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
#base-view .dock-parts-col {
  display: flex; flex-direction: column; gap: var(--space-4); min-width: 0;
  padding: 13px; border-radius: var(--radius-window); background: var(--surface-1);
}
#base-view .dock-col-title { margin: 0; color: var(--title); font-size: var(--font-m); font-weight: 600; }
/* ドック内の操作は Borderless。主要操作、サービス完了系、補助操作の三段に分ける。 */
#base-view span.dock-btn {
  padding: 7px 10px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--body); white-space: nowrap;
}
#base-view span.dock-btn:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view span.dock-btn-primary { background: var(--accent-fill); color: var(--accent); }
#base-view span.dock-btn-primary:hover { background: var(--accent-fill-strong); color: var(--accent-near); }
#base-view span.dock-btn-service { color: var(--body); }
#base-view span.dock-btn-service:hover { background: var(--surface-3); color: var(--accent-near); }
#base-view span.dock-btn-complete.disabled { opacity: 0.72; color: var(--accent-secondary); }
#base-view span.dock-btn-quiet { color: var(--muted); }

@media ${MQ_COMPACT} {
  #base-view.base-view-overlay {
    align-items: flex-end; padding: max(var(--space-4), var(--safe-t)) 0 0;
  }
  #base-view .dock-panel {
    height: 94dvh; max-height: 100%; overflow: hidden; border-radius: var(--radius-window) var(--radius-window) 0 0;
    background: var(--surface-0);
  }
  #base-view .dock-header {
    grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4);
    padding: 13px 13px 9px;
  }
  #base-view .dock-title { font-size: var(--font-xl); }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-tabs {
    grid-column: 1 / -1; grid-row: 2; justify-content: flex-start;
    overflow-x: auto; scrollbar-width: none;
  }
  #base-view .dock-tabs::-webkit-scrollbar { display: none; }
  #base-view .dock-tabs .w-btn { flex: 1 0 auto; text-align: center; }
  #base-view .dock-status-bar { padding: 0 13px 11px; }
  #base-view .dock-body { margin-top: 0; padding: 13px; }
  #base-view .dock-section-head { align-items: flex-start; padding-inline: 0; }
  #base-view .dock-ship-row { align-items: stretch; flex-direction: column; gap: var(--space-3); }
  #base-view .dock-ship-actions { display: grid; grid-template-columns: 1fr 1fr; }
  #base-view .dock-ship-actions .dock-btn { justify-content: center; text-align: center; }
  #base-view .dock-parts-header { align-items: flex-start; flex-direction: column; }
  #base-view .dock-parts-header .dock-btn { align-self: stretch; text-align: center; }
  #base-view .dock-parts-columns { grid-template-columns: 1fr; }
  #base-view .dock-parts-col { padding: 11px; }
  #base-view .dock-part-row-main { grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); }
  #base-view .dock-part-row-main:not(.dock-warehouse-row-main) .dock-part-hp-meter { grid-column: 1 / -1; grid-row: 2; }
  #base-view .dock-warehouse-row-main .dock-part-actions { grid-column: 1 / -1; justify-content: flex-end; }
  #base-view .dock-part-swap-row { align-items: stretch; flex-wrap: wrap; }
  #base-view .dock-part-swap-select { flex-basis: calc(100% - 80px); }
}

@media ${MQ_SHORT} {
  #base-view.base-view-overlay { padding-top: var(--space-3); }
  #base-view .dock-header { padding-top: 9px; padding-bottom: 7px; }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-status-bar { padding-bottom: 9px; }
  #base-view .dock-body { padding-top: 9px; padding-bottom: 9px; }
}
`;

const RESOURCE_GRANT_GROUPS: readonly ObjectPickerGroup<ResourceId>[] = [
  { label: '', items: RESOURCE_IDS.map((id) => [id, `${RESOURCES[id].name} (${id})`] as const) },
];

let styleInjected = false;
// ドックビューのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export type DockTab = 'ships' | 'parts' | 'production' | 'workbench';

export type WorkbenchTargetKind = 'base' | 'vessel' | 'draft';

export interface WorkbenchTargetView {
  readonly id: string;
  readonly kind: WorkbenchTargetKind;
  readonly name: string;
  readonly vessel: Vessel | null;
  readonly assembly: VesselAssembly;
}

export interface WorkbenchSelectionInfo {
  readonly kind: 'part' | 'node' | 'edge' | 'skin';
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly part?: Part;
  readonly node?: TreeNode;
  readonly placement?: PartPlacement;
  readonly mount?: MountPoint;
}

const TAB_ITEMS: readonly (readonly [DockTab, string])[] = [
  ['ships', '格納艦艇'],
  ['parts', '部品'],
  ['production', '生産'],
  ['workbench', '3D作業台'],
];

// 資源1件の表示名と量。
function formatResourceAmount(id: string, mass: number): string {
  const def = RESOURCES[id as ResourceId];
  const name = def === undefined ? id : def.name;
  return `${name} ${mass < 1 ? mass.toFixed(3) : mass.toFixed(1)} kg`;
}

const PART_TYPE_LABELS: Readonly<Record<PartType, string>> = {
  hull: '船体',
  cockpit: '操縦区画',
  armor: '装甲',
  weapon: '武装',
  engine: '主機',
  rcs_thruster: 'RCS スラスタ',
  solar_panel: '太陽電池',
  radiator: '放熱器',
  combat_shield: '戦闘用シールド',
  heat_shield: '熱シールド',
  communication: '通信モジュール',
  robot_arm: 'ロボットアーム',
  docking_port: 'ドッキングポート',
  container_coupling: 'コンテナ接合部',
  oxidizer_tank: '酸化剤タンク',
  reductant_tank: '還元剤タンク',
  pressurant_tank: '加圧ガスタンク',
  rcs_tank: 'RCS タンク',
  water_tank: '水タンク',
  battery: 'バッテリー',
  fuel_cell: '燃料電池',
  rtg: '原子力電池',
  autopilot: '自動操縦装置',
  magazine: '弾薬庫',
  ammunition: '弾薬',
  plumbing: '配管',
  payload_bay: 'ペイロード倉庫',
  flywheel: 'フライホイール',
  magnetorquer: '磁気トルカ',
  base_module: '基地モジュール',
  farm: '農場',
  life_support: '生命維持装置',
  dock: 'ドック',
};

function formatPartMeta(part: Part): string {
  if (part.type !== 'rcs_tank') return PART_TYPE_LABELS[part.type];
  const tank = part as RcsTankPart;
  return `${PART_TYPE_LABELS[part.type]} · 燃料 ${Math.round(tank.fuel).toLocaleString()} / ${Math.round(tank.maxFuel).toLocaleString()} kg`;
}

export class BaseView {
  private readonly el: HTMLElement;
  private readonly tabBar: TabBar<DockTab>;
  private readonly statusLabel: HTMLElement;
  // デバッグ用の資源加算が、直前に何をどれだけ足したかの控え。
  private lastGrantText = '';
  private grantResourceId: ResourceId | null = null;
  private grantMass = 0;
  private readonly grantResourcePicker: ObjectPicker<ResourceId>;
  private readonly bodyEl: HTMLElement;
  private _visible = false;
  private currentBase: Vessel | null = null;
  private currentVessel: Vessel | null = null;
  private workbenchTargets: readonly WorkbenchTargetView[] = [];
  private currentWorkbenchTargetId: string | null = null;
  private workbenchSelection: WorkbenchSelectionInfo | null = null;
  private currentTab: DockTab = 'ships';
  private previouslyFocused: HTMLElement | null = null;

  // 外部コールバック
  public onLaunchVessel: ((ship: Vessel, base: Vessel) => void) | null = null;
  public onClose: (() => void) | null = null;
  public onWorkbenchDrop: ((base: Vessel, targetId: string, partId: string, fromInventory: boolean) => void) | null = null;
  public onWorkbenchRemove: ((base: Vessel, targetId: string, partId: string) => void) | null = null;
  public onWorkbenchPointer: ((base: Vessel, targetId: string, clientX: number, clientY: number) => void) | null = null;
  public onWorkbenchSelectTarget: ((base: Vessel, targetId: string) => void) | null = null;
  public onWorkbenchNodeEdit: ((base: Vessel, targetId: string, nodeId: string, x: number, y: number, z: number) => void) | null = null;
  public onWorkbenchPrimitiveEdit: ((base: Vessel, targetId: string, nodeId: string, primitiveId: string, patch: SectionPrimitivePatch) => void) | null = null;
  public onWorkbenchRemoveNode: ((base: Vessel, targetId: string, nodeId: string) => void) | null = null;
  public onWorkbenchRemoveEdge: ((base: Vessel, targetId: string, edgeId: string) => void) | null = null;
  public onWorkbenchAddNode: ((base: Vessel, targetId: string, parentNodeId: string) => void) | null = null;
  public onWorkbenchAddEdge: ((base: Vessel, targetId: string, nodeId: string) => void) | null = null;
  public onWorkbenchCreateDraft: ((base: Vessel) => void) | null = null;
  public onWorkbenchBuildDraft: ((base: Vessel, targetId: string) => void) | null = null;
  public onWorkbenchCommit: (() => void) | null = null;
  public onWorkbenchCancel: (() => void) | null = null;
  public onWorkbenchTransfer: ((base: Vessel, fromTargetId: string, toTargetId: string, partId: string) => void) | null = null;

  public get visible(): boolean { return this._visible; }
  public get element(): HTMLElement { return this.el; }

  public constructor(root: HTMLElement, overlayManager: OverlayManager) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.id = 'base-view';
    this.el.className = 'base-view-overlay';
    this.el.style.display = 'none';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'base-view-title');
    this.el.addEventListener('keydown', (event) => this.trapFocus(event));

    // popup レイヤは view レイヤより奥にあるので、このビュー自身を親にしてポップアップを最前面へ出す。
    this.grantResourcePicker = new ObjectPicker<ResourceId>(this.el, '資源 id', (id) => {
      this.grantResourceId = id;
      this.grantResourcePicker.setSelected(id);
    }, overlayManager);
    this.grantResourcePicker.setGroups(RESOURCE_GRANT_GROUPS);

    const panel = document.createElement('div');
    panel.className = 'dock-panel';

    const header = document.createElement('header');
    header.className = 'dock-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'dock-title-group';
    const kicker = document.createElement('span');
    kicker.className = 'dock-kicker';
    kicker.textContent = 'Base operations';
    const title = document.createElement('h1');
    title.id = 'base-view-title';
    title.className = 'dock-title';
    title.textContent = 'Base';
    const subtitle = document.createElement('span');
    subtitle.className = 'dock-subtitle';
    subtitle.textContent = '艦の整備、補給、調達';
    titleGroup.append(kicker, title, subtitle);
    header.appendChild(titleGroup);

    this.tabBar = new TabBar<DockTab>(TAB_ITEMS, (tab) => {
      this.currentTab = tab;
      this.refresh();
    });
    this.tabBar.element.classList.add('dock-tabs');
    this.tabBar.element.setAttribute('aria-label', 'ドックの区画');
    this.tabBar.element.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
      const item = TAB_ITEMS[index];
      if (!item) return;
      tab.id = `dock-tab-${item[0]}`;
      tab.setAttribute('aria-controls', 'dock-panel-content');
    });
    header.appendChild(this.tabBar.element);

    // 閉じる操作は要求を伝えるだけで、実際に閉じてポーズを解くのは onClose の受け手が行う。
    const closeBtn = new CloseButton(() => this.onClose?.());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    const statusBar = document.createElement('div');
    statusBar.className = 'dock-status-bar';
    statusBar.setAttribute('role', 'status');
    statusBar.setAttribute('aria-live', 'polite');
    this.statusLabel = document.createElement('span');
    this.statusLabel.textContent = '基地 ---';
    statusBar.appendChild(this.statusLabel);
    panel.appendChild(statusBar);

    this.bodyEl = document.createElement('main');
    this.bodyEl.id = 'dock-panel-content';
    this.bodyEl.className = 'dock-body';
    this.bodyEl.setAttribute('role', 'tabpanel');
    this.bodyEl.tabIndex = 0;
    panel.appendChild(this.bodyEl);

    this.el.appendChild(panel);
    root.appendChild(this.el);
  }

  // ドックビューを開く
  public open(base: Vessel, inspectShip: Vessel | null): void {
    if (!this._visible) {
      this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.currentBase = base;
    // inspectShip が基地に格納されていれば選択状態にする
    if (inspectShip && base.baseState!.dockedVessels.some((s) => s.id === inspectShip.id)) {
      this.currentVessel = inspectShip;
    } else {
      this.currentVessel = null;
    }
    this.currentTab = 'ships';
    this.refresh();
    this.el.style.display = 'flex';
    this._visible = true;
    this.focusEntry();
  }

  public openWorkbench(base: Vessel, targets: readonly WorkbenchTargetView[], selectedTargetId?: string): void {
    const selectedVessel = targets.find((target) => target.id === selectedTargetId)?.vessel ?? null;
    this.open(base, selectedVessel);
    this.workbenchTargets = targets;
    this.currentWorkbenchTargetId = selectedTargetId ?? targets[0]?.id ?? null;
    this.workbenchSelection = null;
    this.currentTab = 'workbench';
    this.refresh();
  }

  public showWorkbenchSelection(info: WorkbenchSelectionInfo | null): void {
    this.workbenchSelection = info;
    if (this.currentTab === 'workbench') this.refresh();
  }

  public close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.currentBase = null;
    this.currentVessel = null;
    this.workbenchTargets = [];
    this.currentWorkbenchTargetId = null;
    this.workbenchSelection = null;
    const focusTarget = this.previouslyFocused;
    this.previouslyFocused = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  }

  // aria-modal の宣言どおり、Tab移動を表示中のドック内部だけで循環させる。
  private trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this._visible) return;
    const focusable = Array.from(this.el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), '
      + '[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getAttribute('aria-disabled') !== 'true' && element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      this.bodyEl.focus({ preventScroll: true });
      return;
    }

    const active = document.activeElement;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (active === first || !this.el.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !this.el.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  private focusEntry(): void {
    const selectedTab = this.tabBar.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (selectedTab ?? this.bodyEl).focus({ preventScroll: true });
  }

  private refresh(): void {
    if (!this.currentBase) return;

    this.statusLabel.textContent =
      `${this.currentBase.name} · 在庫 ${this.currentBase.baseState!.resources.storedIds.length} 種`;
    this.tabBar.setSelected(this.currentTab);
    this.bodyEl.setAttribute('aria-labelledby', `dock-tab-${this.currentTab}`);

    this.bodyEl.innerHTML = '';
    switch (this.currentTab) {
      case 'ships': this.bodyEl.appendChild(this.buildVesselsTab()); break;
      case 'parts': this.bodyEl.appendChild(this.buildPartsTab()); break;
      case 'production': this.bodyEl.appendChild(this.buildProductionTab()); break;
      case 'workbench': this.bodyEl.appendChild(this.buildWorkbenchTab()); break;
    }
    // 操作した行を再構築してフォーカス要素がDOMから外れた場合も、背面HUDへ落とさない。
    if (this._visible && !this.el.contains(document.activeElement)) this.focusEntry();
  }

  private buildWorkbenchTab(): HTMLElement {
    const base = this.currentBase!;
    const target = this.workbenchTargets.find((candidate) => candidate.id === this.currentWorkbenchTargetId)
      ?? this.workbenchTargets[0];
    const section = document.createElement('section');
    section.className = 'dock-section';
    section.appendChild(this.buildSectionHeader(
      'ドック3D作業台',
      '基地本体・格納艦・新規船下書きを切り替え、3D上のノード、エッジ、外皮、部品を編集します。',
      target ? `${target.assembly.placements.length} 搭載 / ${base.baseState!.inventory.length} 倉庫` : '対象なし',
    ));
    if (this.workbenchTargets.length === 0 || !target) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '作業台の対象がありません。';
      section.appendChild(empty);
      return section;
    }
    const targetBar = document.createElement('div');
    targetBar.className = 'dock-workbench-targets';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = '編集対象';
    targetLabel.className = 'dock-part-type';
    const targetSelect = document.createElement('select');
    targetSelect.className = 'dock-part-swap-select';
    targetSelect.setAttribute('aria-label', '作業台の編集対象');
    for (const candidate of this.workbenchTargets) {
      const option = document.createElement('option');
      option.value = candidate.id;
      option.textContent = `${candidate.kind === 'base' ? '基地本体' : candidate.kind === 'draft' ? '新規船下書き' : 'ドック中の船'} · ${candidate.name}`;
      option.selected = candidate.id === target.id;
      targetSelect.appendChild(option);
    }
    targetSelect.addEventListener('change', () => {
      this.currentWorkbenchTargetId = targetSelect.value;
      this.workbenchSelection = null;
      this.onWorkbenchSelectTarget?.(base, targetSelect.value);
      this.refresh();
    });
    const newDraft = new Button('新規船下書き', () => this.onWorkbenchCreateDraft?.(base));
    newDraft.element.classList.add('dock-btn', 'dock-btn-primary');
    targetBar.append(targetLabel, targetSelect, newDraft.element);
    section.appendChild(targetBar);
    const actions = document.createElement('div');
    actions.className = 'dock-parts-actions';
    const commit = new Button('変更を確定', () => this.onWorkbenchCommit?.());
    commit.element.classList.add('dock-btn', 'dock-btn-primary');
    const cancel = new Button('変更を取消', () => this.onWorkbenchCancel?.());
    cancel.element.classList.add('dock-btn', 'dock-btn-quiet');
    actions.append(commit.element, cancel.element);
    section.appendChild(actions);
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'dock-part-swap-select';
    filter.placeholder = '部品を検索 (名前 / 種別 / partRef)';
    filter.setAttribute('aria-label', '作業台の部品を検索');
    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLocaleLowerCase();
      for (const row of Array.from(section.querySelectorAll<HTMLElement>('[data-workbench-part]'))) {
        row.hidden = query.length > 0 && !(row.dataset.searchText ?? '').includes(query);
      }
    });
    section.appendChild(filter);
    const stage = document.createElement('div');
    stage.className = 'dock-workbench-stage';
    stage.textContent = `3D作業領域 · ${target.name} · 接続口 / 外表面 / トラス取付点へスナップ`;
    stage.addEventListener('pointerdown', (event) => {
      this.onWorkbenchPointer?.(base, target.id, event.clientX, event.clientY);
    });
    stage.addEventListener('dragover', (event) => event.preventDefault());
    stage.addEventListener('drop', (event) => {
      event.preventDefault();
      const raw = event.dataTransfer?.getData('application/x-tepui-part') ?? '';
      if (!raw) return;
      const [partId, source] = raw.split(':');
      if (partId) this.onWorkbenchDrop?.(base, target.id, partId, source === 'inventory');
    });
    section.appendChild(stage);

    if (this.workbenchSelection) section.appendChild(this.buildWorkbenchSelection(base, target));
    section.appendChild(this.buildWorkbenchEditControls(base, target));

    const columns = document.createElement('div');
    columns.className = 'dock-parts-columns';
    const mounted = document.createElement('div');
    mounted.className = 'dock-parts-col';
    const mountedTitle = document.createElement('h3');
    mountedTitle.className = 'dock-col-title';
    mountedTitle.textContent = target.kind === 'base' ? '基地構成 / 搭載' : target.kind === 'draft' ? '下書き構成 / 搭載' : '仮構成 / 搭載';
    mounted.appendChild(mountedTitle);
    for (const placement of target.assembly.placements) {
      const part = placement.part;
      const row = this.buildWorkbenchPartRow(part, false);
      row.addEventListener('dblclick', () => this.onWorkbenchRemove?.(base, target.id, part.id));
      const wrapper = document.createElement('div');
      wrapper.className = 'dock-workbench-part-wrap';
      wrapper.append(row);
      if (target.kind !== 'base') wrapper.append(this.buildTransferControl(base, target.id, part.id));
      mounted.appendChild(wrapper);
    }
    const inventory = document.createElement('div');
    inventory.className = 'dock-parts-col';
    const inventoryTitle = document.createElement('h3');
    inventoryTitle.className = 'dock-col-title';
    inventoryTitle.textContent = '倉庫 / 分解部品';
    inventory.appendChild(inventoryTitle);
    for (const part of base.baseState!.inventory) inventory.appendChild(this.buildWorkbenchPartRow(part, true));
    columns.append(mounted, inventory);
    section.appendChild(columns);
    const hint = document.createElement('p');
    hint.className = 'dock-section-description';
    hint.textContent = '部品をダブルクリックすると取り外し、在庫からドラッグすると選択中のMountPointへ取り付けます。外皮は3D上で選択できます。';
    section.appendChild(hint);
    return section;
  }

  private buildWorkbenchSelection(base: Vessel, target: WorkbenchTargetView): HTMLElement {
    const info = this.workbenchSelection!;
    const panel = document.createElement('div');
    panel.className = 'dock-workbench-selection';
    const title = document.createElement('div');
    title.innerHTML = `<strong>${info.label}</strong> · ${info.kind}`;
    const detail = document.createElement('div');
    detail.textContent = info.detail;
    panel.append(title, detail);
    if (info.kind === 'part' && info.part) {
      const remove = new Button('取り外す', () => this.onWorkbenchRemove?.(base, target.id, info.part!.id));
      remove.element.classList.add('dock-btn', 'dock-btn-quiet');
      panel.appendChild(remove.element);
    }
    return panel;
  }

  private buildWorkbenchEditControls(base: Vessel, target: WorkbenchTargetView): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'dock-workbench-selection';
    const title = document.createElement('div');
    title.innerHTML = '<strong>形状編集</strong> · 数値入力 / 編集ボタン';
    panel.appendChild(title);
    const info = this.workbenchSelection;
    const selectedNode = info?.kind === 'node' ? info.node : null;
    const selectedEdgeId = info?.kind === 'edge' ? info.id : null;
    const selectedPrimitive = selectedNode?.section.primitives[0];

    if (selectedNode) {
      const grid = document.createElement('div');
      grid.className = 'dock-workbench-edit';
      const inputs = (['x', 'y', 'z'] as const).map((axis) => {
        const label = document.createElement('label');
        label.textContent = axis.toUpperCase();
        const input = document.createElement('input');
        input.type = 'number'; input.step = '0.5'; input.value = String(selectedNode.pos[axis]);
        input.dataset.nodeAxis = axis;
        label.appendChild(input); grid.appendChild(label); return input;
      });
      const save = new Button('ノード位置を更新', () => {
        const values = inputs.map((input) => Number(input.value));
        if (values.every(Number.isFinite)) this.onWorkbenchNodeEdit?.(base, target.id, selectedNode.id, values[0]!, values[1]!, values[2]!);
      });
      save.element.classList.add('dock-btn', 'dock-btn-primary');
      const add = new Button('子ノードを追加', () => this.onWorkbenchAddNode?.(base, target.id, selectedNode.id));
      add.element.classList.add('dock-btn', 'dock-btn-quiet');
      const remove = new Button('ノードを削除', () => this.onWorkbenchRemoveNode?.(base, target.id, selectedNode.id));
      remove.element.classList.add('dock-btn', 'dock-btn-quiet');
      const actions = document.createElement('div'); actions.className = 'dock-workbench-edit-actions';
      actions.append(save.element, add.element, remove.element);
      if (selectedPrimitive && (selectedPrimitive.shape.kind === 'circle' || selectedPrimitive.shape.kind === 'polygon' || selectedPrimitive.shape.kind === 'notched' || selectedPrimitive.shape.kind === 'ellipse')) {
        const radiusLabel = document.createElement('label'); radiusLabel.textContent = '断面半径';
        const radius = document.createElement('input'); radius.type = 'number'; radius.step = '0.1';
        radius.value = String(selectedPrimitive.shape.kind === 'ellipse' ? selectedPrimitive.shape.majorRadius : selectedPrimitive.shape.radius);
        const update = new Button('外皮断面を更新', () => {
          const value = Number(radius.value);
          if (!Number.isFinite(value) || value <= 0) return;
          const shape = selectedPrimitive.shape.kind === 'ellipse'
            ? { ...selectedPrimitive.shape, majorRadius: value }
            : { ...selectedPrimitive.shape, radius: value };
          this.onWorkbenchPrimitiveEdit?.(base, target.id, selectedNode.id, selectedPrimitive.id, { shape });
        });
        update.element.classList.add('dock-btn', 'dock-btn-primary');
        radiusLabel.appendChild(radius); actions.append(radiusLabel, update.element);
      }
      panel.append(grid, actions);
    } else if (selectedEdgeId) {
      const edge = target.assembly.tree.edges.find((candidate) => candidate.id === selectedEdgeId);
      if (edge) {
        const meta = document.createElement('div'); meta.textContent = `長さ ${edge.length.toFixed(1)} m · ${edge.kind.kind}`;
        const actions = document.createElement('div'); actions.className = 'dock-workbench-edit-actions';
        const remove = new Button('エッジを削除', () => this.onWorkbenchRemoveEdge?.(base, target.id, edge.id));
        remove.element.classList.add('dock-btn', 'dock-btn-quiet');
        const add = new Button('選択ノードへエッジ追加', () => this.onWorkbenchAddEdge?.(base, target.id, edge.a));
        add.element.classList.add('dock-btn', 'dock-btn-primary');
        actions.append(add.element, remove.element); panel.append(meta, actions);
      }
    } else {
      const help = document.createElement('div');
      help.textContent = 'ノードを選ぶと位置・断面、エッジを選ぶと削除、部品を選ぶと部品操作を編集できます。';
      panel.appendChild(help);
    }
    if (target.kind === 'draft') {
      const build = new Button('下書きを建造して格納', () => this.onWorkbenchBuildDraft?.(base, target.id));
      build.element.classList.add('dock-btn', 'dock-btn-primary');
      panel.appendChild(build.element);
    }
    return panel;
  }

  private buildTransferControl(base: Vessel, fromTargetId: string, partId: string): HTMLElement {
    const control = document.createElement('div');
    control.className = 'dock-workbench-transfer';
    const select = document.createElement('select');
    select.className = 'dock-part-swap-select';
    select.setAttribute('aria-label', '移送先の格納艦');
    for (const target of this.workbenchTargets) {
      if (target.id === fromTargetId || target.kind !== 'vessel') continue;
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.name || target.id;
      select.appendChild(option);
    }
    const button = new Button('船へ移送', () => {
      if (select.value) this.onWorkbenchTransfer?.(base, fromTargetId, select.value, partId);
    });
    button.element.classList.add('dock-btn', 'dock-btn-quiet');
    button.setEnabled(select.options.length > 0);
    control.append(select, button.element);
    return control;
  }

  private buildWorkbenchPartRow(part: Part, fromInventory: boolean): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.draggable = true;
    row.className = 'dock-part-row';
    row.dataset.workbenchPart = 'true';
    row.dataset.partId = part.id;
    row.dataset.fromInventory = String(fromInventory);
    row.dataset.searchText = `${part.name} ${part.type} ${part.id}`.toLocaleLowerCase();
    row.textContent = `${part.name} · ${PART_TYPE_LABELS[part.type]} · ${Math.round(part.weight)} kg · HP ${Math.round(part.hp)}/${Math.round(part.maxHp)}`;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-tepui-part', `${part.id}:${fromInventory ? 'inventory' : 'mounted'}`);
    });
    row.addEventListener('click', () => this.showPartProperties(part));
    return row;
  }

  private showPartProperties(part: Part): void {
    const existing = this.el.querySelector<HTMLElement>('.dock-part-property-window');
    existing?.remove();
    const window = document.createElement('aside');
    window.className = 'dock-part-property-window';
    window.setAttribute('role', 'dialog');
    window.innerHTML = `<strong>${part.name}</strong><br>${PART_TYPE_LABELS[part.type]}<br>partRef: ${part.id}<br>質量: ${part.weight} kg<br>HP: ${part.hp} / ${part.maxHp}`;
    this.el.appendChild(window);
  }

  private buildSectionHeader(titleText: string, descriptionText: string, countText: string): HTMLElement {
    const header = document.createElement('header');
    header.className = 'dock-section-head';

    const copy = document.createElement('div');
    copy.className = 'dock-section-copy';
    const title = document.createElement('h2');
    title.className = 'dock-section-title';
    title.textContent = titleText;
    const description = document.createElement('p');
    description.className = 'dock-section-description';
    description.textContent = descriptionText;
    copy.append(title, description);

    const count = document.createElement('span');
    count.className = 'dock-section-count';
    count.textContent = countText;
    header.append(copy, count);
    return header;
  }

  // ─── 格納艦艇タブ ───────────────────────────────────────────
  private buildVesselsTab(): HTMLElement {
    const base = this.currentBase!;
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    const ships = base.baseState!.dockedVessels;
    frag.appendChild(this.buildSectionHeader(
      '格納艦艇',
      '発進する艦を選択するか、整備画面で搭載部品を確認します。',
      `${ships.length} / ${base.dockCapacity} 隻`,
    ));
    if (ships.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦艇はありません。ランデブー後に収容するか、新造してください。';
      frag.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'dock-ship-list';
      list.setAttribute('role', 'list');
      ships.forEach((s, i) => list.appendChild(this.buildVesselRow(s, i)));
      frag.appendChild(list);
    }
    return frag;
  }

  private buildVesselRow(s: DockedVesselEntry, i: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-ship-row';
    row.setAttribute('role', 'listitem');
    const selected = this.currentVessel?.id === s.id;
    row.classList.toggle('is-selected', selected);
    const hpRatio = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    row.classList.toggle('is-critical', hpRatio <= 0.3);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'dock-ship-select';
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `${s.name || `艦 ${i + 1}`}を選択`);
    select.addEventListener('click', () => {
      this.currentVessel = s.vessel;
      this.refresh();
    });

    const info = document.createElement('div');
    info.className = 'dock-ship-info';
    const name = document.createElement('span');
    name.className = 'dock-ship-name';
    name.textContent = `${s.name || `艦 #${i + 1}`} [ドック ${s.slotIndex + 1}]`;
    const hp = document.createElement('span');
    hp.className = 'dock-ship-hp';
    hp.textContent = `HP ${Math.round(s.hp ?? 0).toLocaleString()} / ${Math.round(s.maxHp ?? 0).toLocaleString()}`;
    info.append(name, hp);
    select.appendChild(info);
    row.appendChild(select);

    const actions = document.createElement('div');
    actions.className = 'dock-ship-actions';
    const launchBtn = new Button('発進', () => this.handleLaunch(i));
    launchBtn.element.classList.add('dock-btn', 'dock-btn-primary');
    const inspectBtn = new Button('部品を見る', () => this.handleInspect(i));
    inspectBtn.element.classList.add('dock-btn', 'dock-btn-quiet');
    actions.append(launchBtn.element, inspectBtn.element);
    row.appendChild(actions);
    return row;
  }

  // ─── 部品タブ ───────────────────────────────────────────
  // 搭載部品(修理・換装・補給)と倉庫(在庫確認・売却・補給)を左右に並べ、
  // 同じ種類の部品を見比べながら換装先を選べるようにする。
  private buildPartsTab(): HTMLElement {
    const base = this.currentBase!;
    // 選択艦がなければ最初の艦を表示。倉庫は基地の持ち物なので、格納艦が居なくても出す。
    const ship = this.currentVessel ?? null;
    const shipData = (ship ? base.baseState!.dockedVessels.find((s) => s.id === ship.id) : undefined)
      ?? base.baseState!.dockedVessels[0]
      ?? null;

    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
      '部品と倉庫',
      '選択艦を修理・補給し、同じ種類の倉庫部品へ換装できます。',
      `${base.baseState!.inventory.length} 点を保管`,
    ));
    if (shipData) frag.appendChild(this.buildRepairAllHeader(base, shipData));

    const columns = document.createElement('div');
    columns.className = 'dock-parts-columns';

    const installedCol = document.createElement('div');
    installedCol.className = 'dock-parts-col';
    const installedTitle = document.createElement('h3');
    installedTitle.className = 'dock-col-title';
    installedTitle.textContent = '搭載部品';
    installedCol.appendChild(installedTitle);
    if (shipData) {
      const list = document.createElement('div');
      list.className = 'dock-part-list';
      list.setAttribute('role', 'list');
      shipData.parts.forEach((p, i) => list.appendChild(this.buildInstalledPartRow(base, shipData, p, i)));
      installedCol.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '格納艦がありません。ランデブー後に収容すると、ここで整備できます。';
      installedCol.appendChild(empty);
    }
    columns.appendChild(installedCol);

    const warehouseCol = document.createElement('div');
    warehouseCol.className = 'dock-parts-col';
    const warehouseTitle = document.createElement('h3');
    warehouseTitle.className = 'dock-col-title';
    warehouseTitle.textContent = '倉庫';
    warehouseCol.appendChild(warehouseTitle);
    warehouseCol.appendChild(this.buildWarehouseList(base));
    columns.appendChild(warehouseCol);

    frag.appendChild(columns);
    return frag;
  }

  // 艦の全部品をまとめて修理するボタンの行。
  private buildRepairAllHeader(base: Vessel, shipData: DockedVesselEntry): HTMLElement {
    const damaged = (shipData.parts as AnyPart[]).filter((p) => p.hp < p.maxHp);
    const request = repairAllBlueprintOf(damaged);
    const enabled = damaged.length > 0 && this.canAfford(base, request);
    const row = document.createElement('div');
    row.className = 'dock-parts-header dock-focus-panel';
    const label = document.createElement('span');
    label.className = 'dock-ship-label';
    label.append('整備対象 ');
    const shipName = document.createElement('strong');
    shipName.textContent = shipData.name || '名称未設定の艦';
    label.appendChild(shipName);
    row.appendChild(label);
    const btn = new Button(
      damaged.length > 0 ? `全部品を修理 · ${this.formatCost(request)}` : '全部品は正常',
      () => this.handleRepairAll(shipData.id),
    );
    btn.element.classList.add('dock-btn', 'dock-btn-service');
    btn.element.classList.toggle('dock-btn-complete', damaged.length === 0);
    btn.setEnabled(enabled);
    row.appendChild(btn.element);
    return row;
  }

  // 搭載部品1件の行を作る。同じ type の在庫があれば換装欄を、rcs_tank なら補給ボタンを添える。
  private buildInstalledPartRow(base: Vessel, shipData: DockedVesselEntry, p: Part, i: number): HTMLElement {
    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    const repairRequest = repairBlueprintOf(p as AnyPart);
    const damaged = p.hp < p.maxHp;
    const canRepair = damaged && this.canAfford(base, repairRequest);

    const row = document.createElement('div');
    row.className = 'dock-part-row';
    row.setAttribute('role', 'listitem');
    const main = document.createElement('div');
    main.className = 'dock-part-row-main';

    const info = document.createElement('div');
    info.className = 'dock-part-info';
    const name = document.createElement('span');
    name.className = 'dock-part-name';
    name.textContent = p.name;
    const type = document.createElement('span');
    type.className = 'dock-part-type';
    type.textContent = formatPartMeta(p);
    info.append(name, type);
    main.appendChild(info);

    const meter = new Meter();
    meter.element.classList.add('dock-part-hp-meter');
    meter.setRatio(hpPct / 100);
    // 3段階だった健全時/中間の色分けは Meter の「危険=DANGER」1本の規約へ統一する。
    meter.setDanger(hpPct <= 30);
    meter.setLabel(`${Math.round(p.hp)}/${p.maxHp}`);
    meter.element.setAttribute('role', 'progressbar');
    meter.element.setAttribute('aria-label', `${p.name}の耐久`);
    meter.element.setAttribute('aria-valuemin', '0');
    meter.element.setAttribute('aria-valuemax', String(p.maxHp));
    meter.element.setAttribute('aria-valuenow', String(Math.round(p.hp)));
    main.appendChild(meter.element);

    const actions = document.createElement('div');
    actions.className = 'dock-part-actions';
    const repairBtn = new Button(
      damaged ? `修理 · ${this.formatCost(repairRequest)}` : '正常',
      () => this.handleRepairPart(shipData.id, i),
    );
    repairBtn.element.classList.add('dock-btn', 'dock-btn-service');
    repairBtn.element.classList.toggle('dock-btn-complete', !damaged);
    repairBtn.setEnabled(canRepair);
    actions.appendChild(repairBtn.element);
    if (p.type === 'rcs_tank') {
      actions.appendChild(this.buildRefuelButton(base, p as RcsTankPart, () => this.handleRefuelInstalled(shipData.id, i)));
    }
    main.appendChild(actions);
    row.appendChild(main);

    const candidates = base.baseState!.inventory.filter((inv) => inv.type === p.type);
    if (candidates.length > 0) row.appendChild(this.buildSwapRow(shipData.id, i, candidates));
    return row;
  }

  // 換装候補の選択欄(<select>)と換装ボタンの行。
  private buildSwapRow(shipId: string, partIdx: number, candidates: readonly AnyPart[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dock-part-swap-row';
    const label = document.createElement('span');
    label.textContent = '換装候補';
    row.appendChild(label);
    const select = document.createElement('select');
    select.className = 'dock-part-swap-select';
    for (const c of candidates) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} · 耐久 ${Math.round(c.hp)}/${c.maxHp}`;
      select.appendChild(opt);
    }
    row.appendChild(select);
    const swapBtn = new Button('換装', () => this.handleSwapPart(shipId, partIdx, select.value));
    swapBtn.element.classList.add('dock-btn', 'dock-btn-primary');
    row.appendChild(swapBtn.element);
    return row;
  }

  // 倉庫にある在庫部品の一覧。売却と、rcs_tank ならその場での補給を提供する。
  private buildWarehouseList(base: Vessel): HTMLElement {
    const inventory = base.baseState!.inventory;
    if (inventory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '倉庫は空です。生産タブで部品を作るか、艦から部品を外すと入ります。';
      return empty;
    }
    const list = document.createElement('div');
    list.className = 'dock-part-list';
    list.setAttribute('role', 'list');
    for (const p of inventory) {
      const row = document.createElement('div');
      row.className = 'dock-part-row';
      row.setAttribute('role', 'listitem');
      const main = document.createElement('div');
      main.className = 'dock-part-row-main dock-warehouse-row-main';

      const info = document.createElement('div');
      info.className = 'dock-part-info';
      const name = document.createElement('span');
      name.className = 'dock-part-name';
      name.textContent = p.name;
      const type = document.createElement('span');
      type.className = 'dock-part-type';
      type.textContent = formatPartMeta(p);
      info.append(name, type);
      main.appendChild(info);

      const hpText = document.createElement('span');
      hpText.className = 'dock-part-hp-text';
      hpText.textContent = `耐久 ${Math.round(p.hp)}/${p.maxHp}`;
      main.appendChild(hpText);

      const actions = document.createElement('div');
      actions.className = 'dock-part-actions';
      if (p.type === 'rcs_tank') {
        actions.appendChild(this.buildRefuelButton(base, p as RcsTankPart, () => this.handleRefuelInventory(p.id)));
      }
      main.appendChild(actions);
      row.appendChild(main);
      list.appendChild(row);
    }
    return list;
  }

  // rcs_tank 用の補給ボタンを作る。
  private buildRefuelButton(base: Vessel, tank: RcsTankPart, onClick: () => void): HTMLElement {
    const missing = Math.max(0, tank.maxFuel - tank.fuel);
    const request = refuelBlueprintOf(tank.propellant, missing);
    const canRefuel = missing > 0 && this.canAfford(base, request);
    const btn = new Button(
      missing > 0 ? `燃料補給 · ${this.formatCost(request)}` : '燃料は満タン',
      onClick,
    );
    btn.element.classList.add('dock-btn', 'dock-btn-service');
    btn.element.classList.toggle('dock-btn-complete', missing <= 0);
    btn.setEnabled(canRefuel);
    return btn.element;
  }

  // ─── ショップタブ ───────────────────────────────────────
  private handleLaunch(idx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels[idx];
    if (!shipData) return;
    this.onLaunchVessel?.(shipData.vessel, base);
    base.baseState!.dockedVessels.splice(idx, 1);
    if (this.currentVessel === shipData.vessel) this.currentVessel = null;
    this.refresh();
  }

  // 何が足りないか。空配列なら要求を満たしている。
  private shortfall(base: Vessel, request: ProducibilityBlueprint): readonly Requirement[] {
    return producibility(request, base.baseState!.resources, baseFacilities(base), basePowerAvailable(base));
  }

  private canAfford(base: Vessel, request: ProducibilityBlueprint): boolean {
    return this.shortfall(base, request).length === 0;
  }

  // 資源を引く。足りなければ何も引かずに false を返す。
  private spend(base: Vessel, request: ProducibilityBlueprint): boolean {
    if (!this.canAfford(base, request)) return false;
    return consumeProductionResources(request, base.baseState!.resources);
  }

  // 要求のうち資源だけを「アルミ 12.0 kg・電子機器 3.0 kg」の形に畳む。ボタンの但し書き用。
  private formatCost(request: ProducibilityBlueprint): string {
    const demand = productionResourceDemand(request, this.currentBase!.baseState!.resources);
    const parts = [...demand].map(([id, mass]) => formatResourceAmount(id, mass));
    return parts.length === 0 ? '資源なし' : parts.join('・');
  }

  // ─── 生産タブ ───────────────────────────────────────────
  // 完成船の設計からの直接生産は停止し、部品を倉庫へ作る機能だけを提供する。
  private buildProductionTab(): HTMLElement {
    const base = this.currentBase!;
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
      '生産', '完成船の直接生産は停止中です。部品を倉庫へ作り、3D作業台でドック中の船へ取り付けます。', '部品中心'));
    const unavailable = document.createElement('div');
    unavailable.className = 'dock-empty';
    unavailable.textContent = '新規船は3D作業台で下書きを作成し、資源を確認してから建造・格納します。ここでは部品単体を生産します。';
    frag.appendChild(unavailable);
    frag.appendChild(this.buildPartProductionSection(base));
    frag.appendChild(this.buildInventorySection(base));
    frag.appendChild(this.buildGrantSection(base));
    return frag;
  }

  // 搭載要素を1つだけ作って倉庫へ入れる。見本は既定の設計が実際に積んでいる要素そのものなので、
  // 換装しても推力や耐久の桁が既定艦とずれない。
  private buildPartProductionSection(base: Vessel): HTMLElement {
    const samples = producibleParts();
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
      '部品の生産', '搭載要素を1つ作り、この基地の倉庫へ入れます。', `${samples.length} 種`));
    const list = document.createElement('div');
    list.className = 'dock-part-list';
    for (const sample of samples) {
      const request = partProductionBlueprintOf(sample);
      const row = document.createElement('div');
      row.className = 'dock-part-row';
      const main = document.createElement('div');
      main.className = 'dock-part-row-main';
      const info = document.createElement('div');
      info.className = 'dock-part-info';
      const name = document.createElement('span');
      name.className = 'dock-part-name';
      name.textContent = sample.name;
      const meta = document.createElement('span');
      meta.className = 'dock-part-type';
      meta.textContent = `${formatPartMeta(sample)} · ${this.formatCost(request)}`;
      info.append(name, meta);
      main.appendChild(info);
      const actions = document.createElement('div');
      actions.className = 'dock-part-actions';
      const btn = new Button('生産して倉庫へ', () => this.handleProducePart(sample));
      btn.element.classList.add('dock-btn', 'dock-btn-primary');
      btn.setEnabled(this.canAfford(base, request));
      actions.appendChild(btn.element);
      main.appendChild(actions);
      row.appendChild(main);
      list.appendChild(row);
    }
    frag.appendChild(list);
    return frag;
  }

  private handleProducePart(sample: AnyPart): void {
    const base = this.currentBase;
    if (!base) return;
    if (!this.spend(base, partProductionBlueprintOf(sample))) return;
    base.baseState!.inventory.push(buildPartFrom(sample));
    this.refresh();
  }

  private buildInventorySection(base: Vessel): HTMLElement {
    const ledger = base.baseState!.resources;
    const ids = ledger.storedIds;
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader('在庫', 'この基地が保有する資源。', `${ids.length} 種`));
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = '在庫は空です。';
      frag.appendChild(empty);
      return frag;
    }
    const list = document.createElement('div');
    list.className = 'dock-part-list';
    for (const id of ids) {
      const line = document.createElement('div');
      line.className = 'dock-part-row';
      line.textContent = formatResourceAmount(id, ledger.amountOf(id));
      list.appendChild(line);
    }
    frag.appendChild(list);
    return frag;
  }

  // 資源をゲーム内で確保する手段(月面の採掘・敵のドロップ)は、この段階より後にある。
  // 生産が最初に動くための足場であり、着陸と採掘が入った時点で削除する。
  private buildGrantSection(base: Vessel): HTMLElement {
    const frag = document.createElement('section');
    frag.className = 'dock-section';
    frag.appendChild(this.buildSectionHeader(
      '資源の加算(デバッグ)', '資源を選び、質量を指定して、この基地の在庫へ加算します。', ''));
    const row = document.createElement('div');
    row.className = 'dock-parts-header';
    const massInput = new ValueInput(
      { type: 'number', min: 0, placeholder: 'kg' }, (value) => { this.grantMass = Number(value); });
    const btn = new Button('加算', () => this.handleGrantResource(base));
    btn.element.classList.add('dock-btn', 'dock-btn-primary');
    row.append(this.grantResourcePicker.element, massInput.element, btn.element);
    frag.appendChild(row);
    const result = document.createElement('div');
    result.className = 'dock-part-type';
    result.textContent = this.lastGrantText;
    frag.appendChild(result);
    return frag;
  }

  private handleGrantResource(base: Vessel): void {
    const id = this.grantResourceId;
    const mass = this.grantMass;
    if (id === null || !Number.isFinite(mass) || mass <= 0) {
      this.lastGrantText = `加算できません: ${id ?? '(未選択)'} ${mass}`;
      this.refresh();
      return;
    }
    base.baseState!.resources.add(id, mass);
    this.lastGrantText = `加算しました: ${formatResourceAmount(id, mass)}`;
    this.refresh();
  }

  private handleInspect(idx: number): void {
    const shipData = this.currentBase?.baseState!.dockedVessels[idx];
    if (!shipData) return;
    this.currentVessel = shipData.vessel;
    this.currentTab = 'parts';
    this.refresh();
  }

  private handleRepairPart(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;

    const part: Part | undefined = shipData.parts[partIdx];
    if (!part || part.hp >= part.maxHp) return;
    if (!this.spend(base, repairBlueprintOf(part as AnyPart))) return;
    part.hp = part.maxHp;
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRepairAll(shipId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    if (!shipData) return;

    const parts = shipData.parts;
    const damaged = (parts as AnyPart[]).filter((p) => p.hp < p.maxHp);
    if (damaged.length === 0) return;
    if (!this.spend(base, repairAllBlueprintOf(damaged))) return;
    parts.forEach((p) => { p.hp = p.maxHp; });
    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  // 格納中は shipData.parts が艦本体の parts 配列と同一参照なので、修理は艦へ直接反映される。
  // hp/maxHp の集計スナップショットだけは別に持っているので、艦一覧タブの表示用にここで揃える。
  private syncDockedSnapshot(shipData: DockedVesselEntry): void {
    shipData.vessel.refreshFromParts();
    shipData.hp = shipData.vessel.hp;
    shipData.maxHp = shipData.vessel.maxHp;
  }

  // 搭載部品を、選択中の倉庫在庫(同じ type)と入れ替える。外した部品は倉庫へ戻す。
  // shipData.parts は player.parts と同一参照なので、splice による差し替えは艦の性能集計へ即反映される。
  private handleSwapPart(shipId: string, partIdx: number, invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    const installed = shipData?.parts[partIdx];
    if (!shipData || !installed) return;

    const invIdx = base.baseState!.inventory.findIndex((p) => p.id === invId);
    const incoming = base.baseState!.inventory[invIdx];
    if (!incoming || incoming.type !== installed.type) return;

    shipData.parts.splice(partIdx, 1, incoming);
    base.baseState!.inventory.splice(invIdx, 1, installed as AnyPart);

    this.syncDockedSnapshot(shipData);
    this.refresh();
  }

  private handleRefuelInstalled(shipId: string, partIdx: number): void {
    const base = this.currentBase;
    if (!base) return;
    const shipData = base.baseState!.dockedVessels.find((s) => s.id === shipId);
    const part = shipData?.parts[partIdx];
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part as RcsTankPart);
    this.refresh();
  }

  private handleRefuelInventory(invId: string): void {
    const base = this.currentBase;
    if (!base) return;
    const part = base.baseState!.inventory.find((p) => p.id === invId);
    if (!part || part.type !== 'rcs_tank') return;
    this.refuelTank(base, part);
    this.refresh();
  }

  private refuelTank(base: Vessel, tank: RcsTankPart): void {
    const missing = Math.max(0, tank.maxFuel - tank.fuel);
    if (missing <= 0) return;
    if (!this.spend(base, refuelBlueprintOf(tank.propellant, missing))) return;
    tank.fuel = tank.maxFuel;
  }

  public dispose(): void {
    this.grantResourcePicker.dispose();
    this.el.remove();
  }
}
