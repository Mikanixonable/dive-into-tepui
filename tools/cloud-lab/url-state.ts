// 実験環境の状態と URL の query の対応。モード・写し・時刻・両方の見る範囲・天気図の層を
// query へ載せて、開き直し・共有・撮影の再現を効かせる。知らないキー(撮影の駆動が使う
// capture-only など)は書き換えずに保持する — ここが触るのはここに書いたキーだけ。
import type { Framing } from './synoptic-map';

// URL に載る状態。どれも省略可 — 省略した項は既定のまま。
export interface LabState {
  readonly mode?: 'cloud' | 'synoptic';
  readonly view?: string; // 写しの id(モードが写しのとき)
  readonly hours?: number; // 表示時刻 [h]
  readonly cap?: Framing; // 写しの cap の中心・半径 [°]
  readonly map?: Framing; // 天気図の窓 [°]
  // ON の層のキー。省略時は既定の層構成(DEFAULT_LAYERS)。層のキー名は LAYER_LABELS が正本。
  readonly layers?: readonly string[];
}

const numberAt = (params: URLSearchParams, key: string): number | undefined => {
  const value = params.get(key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const framingAt = (params: URLSearchParams, prefix: 'cap' | 'map'): Framing | undefined => {
  const latitude = numberAt(params, `${prefix}Lat`);
  const longitude = numberAt(params, `${prefix}Lon`);
  const radius = numberAt(params, `${prefix}R`);
  return latitude === undefined || longitude === undefined || radius === undefined
    ? undefined : { latitude, longitude, radius };
};

// location.search から状態を読む。値が欠けたり壊れたりした項は未定義のまま(既定へ戻す)。
export function parseLabState(search: string): LabState {
  const params = new URLSearchParams(search);
  const mode = params.get('mode');
  const layers = params.get('layers');
  return {
    mode: mode === 'cloud' || mode === 'synoptic' ? mode : undefined,
    view: params.get('view') ?? undefined,
    hours: numberAt(params, 'h'),
    cap: framingAt(params, 'cap'),
    map: framingAt(params, 'map'),
    layers: layers === null ? undefined : layers.split(',').filter((key) => key !== ''),
  };
}

const framingInto = (params: URLSearchParams, prefix: 'cap' | 'map', framing: Framing | undefined): void => {
  const set = (key: string, value: number | undefined): void => {
    if (value === undefined) params.delete(`${prefix}${key}`);
    else params.set(`${prefix}${key}`, String(value));
  };
  set('Lat', framing?.latitude);
  set('Lon', framing?.longitude);
  set('R', framing?.radius);
};

// 状態を query へ書く。既存の search を元に組むので、知らないキーはそのまま残る。
export function labStateQuery(state: LabState, search: string): string {
  const params = new URLSearchParams(search);
  if (state.mode === undefined) params.delete('mode'); else params.set('mode', state.mode);
  if (state.view === undefined) params.delete('view'); else params.set('view', state.view);
  if (state.hours === undefined) params.delete('h'); else params.set('h', String(state.hours));
  framingInto(params, 'cap', state.cap);
  framingInto(params, 'map', state.map);
  if (state.layers === undefined) params.delete('layers'); else params.set('layers', state.layers.join(','));
  return params.toString();
}
