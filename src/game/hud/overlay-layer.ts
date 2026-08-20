// #hud 直下の重なり順を決める固定レイヤ群。z-index を持つのはこのモジュールだけであり、
// 各ウィジェットは自分がどのレイヤの子になるかを選ぶだけで、レイヤ内の前後は DOM 順(bringToFront)で決まる。
// gate は入力ゲート用の遮蔽幕(OverlayManager が構築する #hud-overlay-shield)専用の層で、
// ゲートの対象(marker/panel/window/popup)より上、ゲートを開く側になり得るモーダル
// (view の資源融通ダイアログ、system のヘルプ・一時停止・セーブブラウザ)より下に置く —
// 遮蔽幕自身がモーダルの上に乗って操作を奪うことがないようにするため。
export type OverlayLayerName = 'marker' | 'panel' | 'window' | 'popup' | 'gate' | 'view' | 'notify' | 'system';

export type OverlayLayers = Readonly<Record<OverlayLayerName, HTMLDivElement>>;

const LAYER_ORDER: readonly OverlayLayerName[] =
  ['marker', 'panel', 'window', 'popup', 'gate', 'view', 'notify', 'system'];

export const OVERLAY_LAYER_STYLE = LAYER_ORDER
  .map((name, i) => `#hud-layer-${name} { position: absolute; inset: 0; pointer-events: none; z-index: ${10 + i}; }`
    + `#hud-layer-${name}.hud-overlay-gate { pointer-events: auto; }`)
  .join('\n');

// root の直下にレイヤ div を奥から手前の順に生成し、名前で引けるレイヤ集合を返す。
export function buildOverlayLayers(root: HTMLElement): OverlayLayers {
  const layers = {} as Record<OverlayLayerName, HTMLDivElement>;
  for (const name of LAYER_ORDER) {
    const div = document.createElement('div');
    div.id = `hud-layer-${name}`;
    root.appendChild(div);
    layers[name] = div;
  }
  return layers;
}

// 要素を同じ親の末尾へ移動し、同一レイヤ内で最前面にする。
export function bringToFront(el: HTMLElement): void {
  el.parentElement?.appendChild(el);
}
