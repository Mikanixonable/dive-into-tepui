// #hud ルート・重なり順のレイヤ・モーダルの排他制御を持つ画面の器。
import { buildOverlayLayers, type OverlayLayers } from './overlay-layer';
import { OverlayManager } from './overlay-manager';
import { createHudElement } from './hud-element';

export class HudShell {
  public readonly root: HTMLElement;
  public readonly layers: OverlayLayers;
  public readonly overlayManager: OverlayManager;

  public constructor() {
    this.root = createHudElement('div', 'hud', document.body);
    this.layers = buildOverlayLayers(this.root);
    this.overlayManager = new OverlayManager(this.layers);
  }
}
