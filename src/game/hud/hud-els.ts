// HUD DOM の静的要素を data-id で引く型付きレジストリ。利用する id は
// HUD_ELEMENT_IDS で列挙し、構築時に DOM 側の対応要素が揃っているか検証する。
// どちらか片方だけの改名は構築時点のエラーになる。

// HUD の静的 DOM が data-id で公開する要素の id 一覧。
export const HUD_ELEMENT_IDS = [
  'alt',
  'ammo',
  'ap',
  'ap-label',
  'burn-active-fuel-meter',
  'burn-active-fuel-value',
  'burn-management-panel',
  'burn-module-list',
  'burn-stage-count',
  'burn-state',
  'burn-total-mass',
  'camfollow',
  'center',
  'chase-reset',
  'construction-actions',
  'construction-category-tabs',
  'construction-completion',
  'construction-count',
  'construction-dock-name',
  'construction-hp',
  'construction-hp-meter',
  'construction-hp-preview',
  'construction-main-fuel',
  'construction-main-fuel-preview',
  'construction-mass',
  'construction-mass-preview',
  'construction-mobile-tabs',
  'construction-module-cards',
  'construction-power',
  'construction-power-preview',
  'construction-radiation',
  'construction-radiation-preview',
  'construction-rcs-fuel',
  'construction-rcs-fuel-preview',
  'construction-role',
  'construction-selected-module',
  'construction-selected-slot',
  'construction-ship-name',
  'construction-slots',
  'construction-thrust',
  'construction-thrust-preview',
  'construction-warning',
  'count',
  'elist',
  'fine',
  'gs-viewrow',
  'hud-enemies',
  'hud-orbit',
  'hud-target',
  'hud-vessel-status',
  'inc',
  'map-scale',
  'map-scale-ruler',
  'map-scale-value',
  'met',
  'node-warp-remain',
  'orbit-actions',
  'orbit-context',
  'orbit-qdyn-row',
  'pe',
  'pe-label',
  'prd',
  'prohold',
  'qdyn',
  'qdyn-meter',
  'qdyn-readout',
  'qdyn-row',
  'rcs',
  'rcs-fuel-meter',
  'rcs-fuel-value',
  'reference-row',
  'ship-construction-panel',
  'sim-speed',
  'spd',
  'status-actions',
  'status-throttle-touch',
  'temp',
  'temp-meter',
  'temp-row',
  'tgt-armor-meter',
  'tgt-armor-row',
  'tgt-armor-value',
  'tgt-closing',
  'tgt-dist',
  'tgt-integrity-value',
  'tgt-protein',
  'tgt-protein-phase',
  'tgt-protein-sites',
  'tgt-relative-speed',
  'tgtbody',
  'tgtname',
  'throttle-readout',
  'vessel-deploy-controls',
] as const;

export type HudElId = (typeof HUD_ELEMENT_IDS)[number];

export class HudEls {
  private readonly elements: ReadonlyMap<string, HTMLElement>;

  // root 以下の [data-id] 要素を集め、宣言した id が DOM に1件でも無ければ例外にする。
  public constructor(root: HTMLElement) {
    const found = new Map<string, HTMLElement>();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-id]'))) {
      found.set(el.dataset['id']!, el);
    }
    const missing = HUD_ELEMENT_IDS.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`HUD elements missing: ${missing.join(', ')}`);
    this.elements = found;
  }

  // id の要素を返す。構築時に存在が検証済みなので必ず返る。
  public get(id: HudElId): HTMLElement {
    return this.elements.get(id)!;
  }

  // id の要素へ、表示中の文字列と異なるときだけ書き込む。
  public setText(id: HudElId, text: string): void {
    const el = this.get(id);
    if (el.textContent !== text) el.textContent = text;
  }
}
