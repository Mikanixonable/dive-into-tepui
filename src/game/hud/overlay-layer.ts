// #hud 直下の重なり順を決める固定レイヤ群。z-index を持つのはこのモジュールだけであり、
// 各ウィジェットは自分がどのレイヤの子になるかを選ぶだけで、レイヤ内の前後は DOM 順(bringToFront)で決まる。
export type OverlayLayerName = 'marker' | 'panel' | 'window' | 'popup' | 'view' | 'notify' | 'system';

export type OverlayLayers = Readonly<Record<OverlayLayerName, HTMLDivElement>>;

const LAYER_ORDER: readonly OverlayLayerName[] = ['marker', 'panel', 'window', 'popup', 'view', 'notify', 'system'];

export const OVERLAY_LAYER_STYLE = LAYER_ORDER
  .map((name, i) => `#hud-layer-${name} { position: absolute; inset: 0; pointer-events: none; z-index: ${10 + i}; }`)
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
