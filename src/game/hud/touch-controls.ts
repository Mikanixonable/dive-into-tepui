// タッチデバイス用の仮想操作パッド。DOM ボタンを画面下部に重ね、
// Input.setVirtualKey へ物理キーボードと同じキーコードを流し込む。
// 押しっぱなし系(並進・回転・射撃・ズーム)とエッジトリガ系(トグル類)を同じ仕組みで扱える。
// 常設で構築し、表示そのものは setPointerKind が渡す直近の入力種別に従う。長押しの手応えの
// マーカーの宣言も組む。レールの無い幅(スマホ横持ち)では、推力段の縦4段・制動/微動/ホールドと
// 計器シートの取っ手のドックまでをここが持つ。
import type { Input, PointerKind } from '../../input/input';
import type { ViewMode } from '../view/view-mode';
import { KEY_MAPPING as K, type KeyBinding } from '../../input/key-mapping';
import type { ThrustDirection } from '../dynamic/dynamic-entity/pilot-controls';
import { MQ_COARSE_SHORT } from '../../hud/breakpoints';
import { THROTTLE_LABELS } from '../player/throttle';
import {
  FONT_FAMILY, FONT_XXS, FONT_XL, SPACE_1, TRANSITION_SLOW, Z_TOUCH_UI,
} from '../../theme';
import { injectCommonUiStyle } from '../../hud/style/common-ui-style';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import type { MarkerDeclaration } from '../../marker/marker-declaration';

const STYLE = `
/* システムウィンドウ(ESC メニュー・終了画面・ヘルプ)より下に置く。
   初回タッチまでは不可視・無反応(.shown が無い間 opacity:0 かつボタンも無効)にし、
   以後マウス操作を検出するたびに .faded で半透明化する(ハイブリッド端末での両立)。
   寸法はすべてタップ最小寸法と余白トークンから導き、座標は端の余白(--safe-*)の内側へ置く。 */
#touch-ui {
  --touch-cell: var(--hit-target-min);
  --touch-gap: var(--space-2);
  --touch-edge: var(--space-4);
  --touch-pad-h: calc(var(--touch-cell) * 2 + var(--touch-gap));
  --touch-fire: calc(var(--touch-cell) * 7 / 4);
  --touch-above-pad: calc(var(--safe-b) + var(--touch-edge) + var(--touch-pad-h) + var(--touch-edge));
  position: fixed; inset: 0; pointer-events: none; z-index: ${Z_TOUCH_UI};
  font-family: ${FONT_FAMILY}; user-select: none;
  -webkit-user-select: none;
  opacity: 0; transition: opacity ${TRANSITION_SLOW};
}
#touch-ui.shown { opacity: 1; }
#touch-ui.shown.faded { opacity: 0.35; }
#touch-ui .tbtn {
  pointer-events: none; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--text-muted); line-height: 1.1;
}
#touch-ui.shown .tbtn { pointer-events: auto; }
#touch-ui .tbtn .g { font-size: ${FONT_XL}; }
#touch-ui .tbtn .l { font-size: ${FONT_XXS}; color: var(--text-dim); margin-top: ${SPACE_1}; }
#touch-ui .tbtn.pressed { background: var(--color-primary-fill-strong); color: var(--text-strong); }
/* .on: 押下中かどうかに関わらず、モードが実際に ON の間ずっと点灯させる
   (制動・微動・ホールド・推力段・推力ラッチなどの向け。.pressed と見た目は同じでよい) */
#touch-ui .tbtn.on { background: var(--color-primary-fill-strong); color: var(--text-strong); }
#touch-ui .mini-col {
  position: absolute; display: grid; gap: var(--touch-gap);
}
#touch-ui .mini-col .tbtn { width: var(--touch-cell); height: var(--touch-cell); }
#touch-ui .pad {
  position: absolute; display: grid; gap: var(--touch-gap);
  grid-template-columns: repeat(3, var(--touch-cell)); grid-auto-rows: var(--touch-cell);
}
#touch-pad-move { left: calc(var(--safe-l) + var(--touch-edge)); bottom: calc(var(--safe-b) + var(--touch-edge)); }
#touch-pad-rot { right: calc(var(--safe-r) + var(--touch-edge)); bottom: calc(var(--safe-b) + var(--touch-edge)); }
/* モード列(制動・微動・ホールド)。ドックの中では横一列、ドックを持たない幅では下中央の縦列。 */
#touch-mode-col {
  left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--touch-edge));
  grid-template-rows: repeat(3, var(--touch-cell));
}
#touch-fire {
  position: absolute; right: calc(var(--safe-r) + var(--touch-edge)); bottom: var(--touch-above-pad);
  width: var(--touch-fire); height: var(--touch-fire); border-radius: 50% !important;
  color: var(--color-primary) !important;
}
#touch-zoom .g { font-size: var(--font-xs); }
#touch-zoom {
  position: absolute; right: calc(var(--safe-r) + var(--touch-edge) * 2 + var(--touch-fire));
  bottom: var(--touch-above-pad);
  width: var(--touch-cell); height: var(--touch-cell); border-radius: 50% !important;
}
#touch-util {
  position: absolute; left: calc(var(--safe-l) + var(--touch-edge)); bottom: var(--touch-above-pad);
  display: flex; gap: var(--touch-gap); flex-wrap: wrap;
  max-width: calc(50vw - var(--touch-cell) / 2 - var(--touch-edge) * 2 - var(--touch-gap));
}
#touch-util .tbtn { width: var(--touch-cell); height: var(--touch-cell); }
#touch-ui.map-mode #touch-util {
  left: 50%; right: auto; bottom: calc(var(--safe-b) + var(--touch-edge)); transform: translateX(-50%);
  flex-wrap: nowrap; max-width: calc(100vw - var(--touch-edge) * 2);
}
#touch-ui.map-mode #touch-util .tbtn { flex: 0 1 var(--touch-cell); min-width: var(--touch-cell); }
/* ドックは、レールを持たない幅(下の @media)でだけ箱になる。それ以外では子がそれぞれ自分の座標を持つ。 */
#touch-dock { display: contents; }
/* 推力段(左端の縦4段)と計器シートの取っ手は、レールを持たない幅でだけ出る。 */
#touch-throttle-col, #touch-sheet-btn { display: none; }

/* スマホ横持ち: 左右のレールは無く(計器は下から出るシート)、親指の届く下の両端が操作面になる。
   左は推力段の縦4段と並進パッド、右は回転パッドと FIRE。中央は1本指ドラッグ(カメラ)のために空け、
   下中央のドックへ制動・微動・ホールドと計器シートの取っ手を横一列に並べる。 */
@media ${MQ_COARSE_SHORT} {
  #touch-throttle-col {
    display: grid; grid-template-rows: repeat(4, var(--touch-cell)); gap: var(--touch-gap);
    position: absolute; left: calc(var(--safe-l) + var(--touch-edge)); bottom: calc(var(--safe-b) + var(--touch-edge));
  }
  #touch-throttle-col .tbtn { width: var(--touch-cell); height: var(--touch-cell); }
  #touch-pad-move { left: calc(var(--safe-l) + var(--touch-edge) * 2 + var(--touch-cell)); }
  #touch-dock {
    display: flex; gap: var(--touch-gap); align-items: flex-end; pointer-events: none;
    position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(var(--safe-b) + var(--touch-edge));
  }
  #touch-dock > #touch-mode-col { position: static; display: flex; gap: var(--touch-gap); transform: none; }
  #touch-dock > #touch-util { position: static; gap: var(--touch-gap); transform: none; }
  #touch-dock #touch-mode-col .tbtn, #touch-dock #touch-util .tbtn, #touch-sheet-btn {
    width: var(--hud-dock-btn-w); height: var(--touch-cell);
  }
  #touch-sheet-btn { display: flex; }
  /* 常に見る操作は下の両端と上のストリップが持つので、戦闘では時間加速・ヘルプ・計画への行は出さない。 */
  #touch-dock > #touch-util { display: none; }
  #touch-ui.map-mode #touch-dock { left: auto; right: calc(var(--safe-r) + var(--touch-edge)); transform: none; }
  #touch-ui.map-mode #touch-dock #touch-util { display: flex; transform: none; max-width: none; }
  #touch-ui.map-mode #touch-dock #touch-util .tbtn { flex: 0 0 var(--hud-dock-btn-w); min-width: 0; }
  #touch-ui #touch-util .touch-util-aux { display: none; }
}
`;

// マップ切替ボタンの語。戦闘ビューでは計画へ入る入口、マップビューでは戦闘へ戻る出口として読む。
const MAP_TOGGLE_LABEL_IN_COMBAT = '計画';
const MAP_TOGGLE_LABEL_ON_MAP = '戦闘へ';

interface Btn {
  key: KeyBinding;
  glyph: string;
  label: string;
}

export class TouchControls {
  private readonly root: HTMLElement;
  private readonly styleEl: HTMLStyleElement;
  // トグル系ボタン: タップの押下フィードバック(.pressed)とは独立に実際のモード状態で光らせる。
  private readonly toggleButtons = new Map<KeyBinding, HTMLElement>();
  // 並進6方向ボタン: ラッチ中かどうかを syncModeButtons が .on で反映する。
  private readonly thrustButtons = new Map<ThrustDirection, HTMLElement>();
  // 推力段ボタン: 段の添字で引き、いま選ばれている段を syncModeButtons が .on で反映する。
  private readonly throttleButtons: HTMLElement[] = [];
  private readonly releaseCallbacks: (() => void)[] = [];
  // 計器シートの取っ手が押されたときに呼ぶ。シートを持つ側(HUD)が差し込む。
  public onSheetToggle: (() => void) | null = null;
  // マップ切替ボタンのラベル。ビューに応じて「計画」と「戦闘へ」を切り替える。
  private mapToggleLabel: HTMLElement | null = null;
  // 一度タッチされたら真のまま保つ。以後のマウス操作では半透明にする。
  private shown = false;

  // 直近の入力種別に応じて表示を切り替える。タッチなら表示して起こし、マウス/キーボードなら
  // (既に表示済みであれば)半透明化する。
  public setPointerKind(kind: PointerKind): void {
    if (kind === 'touch') {
      this.shown = true;
      this.root.classList.remove('faded');
    } else if (this.shown) {
      this.root.classList.add('faded');
    }
    this.root.classList.toggle('shown', this.shown);
    document.body.classList.toggle('touch-ui-active', this.shown);
  }

  // トグル系ボタン・推力ラッチの点灯を実際の状態へ合わせる。毎フレーム呼ぶ。
  public syncModeButtons(
    rcsDamp: boolean, fineAttitude: boolean, progradeHold: boolean, throttleIdx: number,
    isThrustLatched: (direction: ThrustDirection) => boolean,
  ): void {
    this.throttleButtons.forEach((el, idx) => el.classList.toggle('on', idx === throttleIdx));
    this.setActive(K.rcsDampToggle, rcsDamp);
    this.setActive(K.fineAttitudeToggle, fineAttitude);
    this.setActive(K.progradeHoldToggle, progradeHold);
    for (const [direction, el] of this.thrustButtons) el.classList.toggle('on', isThrustLatched(direction));
  }

  // 長押しの手応えのマーカーの宣言。長押し中の点が無いフレームも、伏せた宣言として返す。
  public longPressDeclaration(): MarkerDeclaration {
    const point = this.input.longPressPoint;
    return {
      id: 'longpress', cls: 'mk-longpress', sym: '',
      x: point?.x ?? 0, y: point?.y ?? 0, front: point !== null,
      priority: MARKER_PRIORITY.NONE,
    };
  }

  // key に対応するトグルボタンの点灯状態を on に合わせる。
  private setActive(key: KeyBinding, on: boolean): void {
    this.toggleButtons.get(key)?.classList.toggle('on', on);
  }

  // マップビュー中は並進・回転・射撃・ズーム・制動/微動のパッドを隠す。
  public setView(view: ViewMode): void {
    const active = view === 'map';
    this.root.classList.toggle('map-mode', active);
    if (this.mapToggleLabel) this.mapToggleLabel.textContent = active ? MAP_TOGGLE_LABEL_ON_MAP : MAP_TOGGLE_LABEL_IN_COMBAT;
    for (const id of ['touch-pad-rot', 'touch-pad-move', 'touch-fire', 'touch-zoom', 'touch-mode-col', 'touch-throttle-col']) {
      const e = document.getElementById(id);
      if (e) e.style.display = active ? 'none' : '';
    }
  }

  // 仮想パッド一式の DOM を組み立てる。
  public constructor(private readonly input: Input) {
    injectCommonUiStyle();
    const built = this.buildRoot();
    this.root = built.root;
    this.styleEl = built.style;
    window.addEventListener('tepui-release-touch-inputs', this.handleReleaseTouchInputs);
    // 並進・回転・射撃・ズーム・雑多ボタンの各領域を組み立てる。
    this.buildTranslationPad(this.root);
    this.buildRotationPad(this.root);
    this.buildThrottleColumn(this.root);
    this.makeButton(this.root, { key: K.fire, glyph: 'FIRE', label: '' }, 'touch-fire');
    this.buildZoomToggle(this.root);
    // ドックは、レールの無い幅でだけ制動・微動・ホールド・シートの取っ手・マップ操作を1つの箱に収める。
    const dock = document.createElement('div');
    dock.id = 'touch-dock';
    this.root.appendChild(dock);
    this.buildModeColumn(dock);
    this.buildUtilRow(dock);
    this.buildSheetButton(dock);
  }

  private readonly handleReleaseTouchInputs = (): void => this.releaseAllInputs();

  // 押下中の仮想キーをすべて離す。
  private releaseAllInputs(): void {
    for (const release of this.releaseCallbacks) release();
  }

  // スタイルシートと仮想パッドのルート要素を document へ追加し、両方を返す。
  private buildRoot(): { root: HTMLElement; style: HTMLStyleElement } {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'touch-ui';
    document.body.appendChild(root);
    return { root, style };
  }

  // window に張ったリスナーを外し、追加したスタイルシート・仮想パッド一式の DOM を取り除く。
  public dispose(): void {
    window.removeEventListener('tepui-release-touch-inputs', this.handleReleaseTouchInputs);
    this.root.remove();
    this.styleEl.remove();
  }

  // b.key を押しっぱなし操作するボタンを1つ組み立てて parent へ追加する。registry を渡すと
  // そこへ b.key で登録し、syncModeButtons が点灯対象として読む。
  private makeButton(parent: HTMLElement, b: Btn, id = '', registry?: Map<KeyBinding, HTMLElement>): HTMLElement {
    const e = document.createElement('div');
    e.className = 'tbtn ui-surface-quiet';
    if (id) e.id = id;
    e.innerHTML = `<span class="g">${b.glyph}</span>${b.label ? `<span class="l">${b.label}</span>` : ''}`;
    // 押下中は仮想キーを ON にし続ける
    const down = (ev: PointerEvent) => {
      ev.preventDefault();
      e.setPointerCapture(ev.pointerId);
      e.classList.add('pressed');
      this.input.setVirtualKey(b.key, true);
    };
    // 指を離したら仮想キーを OFF に戻す
    const up = () => {
      e.classList.remove('pressed');
      this.input.setVirtualKey(b.key, false);
    };
    e.addEventListener('pointerdown', down);
    e.addEventListener('pointerup', up);
    e.addEventListener('pointercancel', up);
    this.releaseCallbacks.push(up);
    e.addEventListener('contextmenu', (ev) => ev.preventDefault());
    parent.appendChild(e);
    if (registry) registry.set(b.key, e);
    return e;
  }

  // ボタンを並べる器となるパッドを1つ id で root へ追加して返す。
  private makePad(root: HTMLElement, id: string): HTMLElement {
    const pad = document.createElement('div');
    pad.id = id;
    pad.className = 'pad';
    root.appendChild(pad);
    return pad;
  }

  // 並進6方向のパッドを組み立てる。ラッチの点灯を反映できるよう、押す方向でボタンを控える。
  private buildTranslationPad(root: HTMLElement): void {
    const buttons: readonly { readonly direction: ThrustDirection; readonly btn: Btn }[] = [
      { direction: 'up', btn: { key: K.thrustUp, glyph: '▲', label: '上' } },
      { direction: 'forward', btn: { key: K.thrustForward, glyph: '●', label: '前' } },
      { direction: 'down', btn: { key: K.thrustDown, glyph: '▼', label: '下' } },
      { direction: 'left', btn: { key: K.thrustLeft, glyph: '◀', label: '左' } },
      { direction: 'backward', btn: { key: K.thrustBackward, glyph: '○', label: '後' } },
      { direction: 'right', btn: { key: K.thrustRight, glyph: '▶', label: '右' } },
    ];
    const pad = this.makePad(root, 'touch-pad-move');
    for (const { direction, btn } of buttons) this.thrustButtons.set(direction, this.makeButton(pad, btn));
  }

  // 回転3軸のパッドを組み立てる。
  private buildRotationPad(root: HTMLElement): void {
    const pad = this.makePad(root, 'touch-pad-rot');
    for (const b of [
      { key: K.rollLeft, glyph: '⟲', label: 'ロール' },
      { key: K.pitchDown, glyph: '↓', label: 'ピッチ' },
      { key: K.rollRight, glyph: '⟳', label: 'ロール' },
      { key: K.yawRight, glyph: '→', label: 'ヨー' },
      { key: K.pitchUp, glyph: '↑', label: 'ピッチ' },
      { key: K.yawLeft, glyph: '←', label: 'ヨー' },
    ]) {
      this.makeButton(pad, b);
    }
  }

  // 推力段(1〜4)の縦4段を組み立てる。上が最大の段。押すと物理キーの 1〜4 と同じ入力になる。
  private buildThrottleColumn(root: HTMLElement): void {
    const column = document.createElement('div');
    column.id = 'touch-throttle-col';
    root.appendChild(column);
    const keys = [K.throttleMax, K.throttleHigh, K.throttleMid, K.throttleLow];
    keys.forEach((key, i) => {
      const idx = keys.length - 1 - i;
      this.throttleButtons[idx] = this.makeButton(column, { key, glyph: key.label, label: THROTTLE_LABELS[idx]! });
    });
  }

  // 制動・微動・進行方向ホールドのトグルボタン列を組み立てる。
  private buildModeColumn(root: HTMLElement): void {
    const modeCol = document.createElement('div');
    modeCol.id = 'touch-mode-col';
    modeCol.className = 'mini-col';
    root.appendChild(modeCol);
    this.makeButton(modeCol, { key: K.rcsDampToggle, glyph: K.rcsDampToggle.label, label: '制動' }, '', this.toggleButtons);
    this.makeButton(modeCol, { key: K.fineAttitudeToggle, glyph: K.fineAttitudeToggle.label, label: '微動' }, '', this.toggleButtons);
    this.makeButton(
      modeCol, { key: K.progradeHoldToggle, glyph: K.progradeHoldToggle.label, label: 'ホールド' }, '', this.toggleButtons,
    );
  }

  // 計器シートを開く取っ手を組む。レールの無い幅でだけ CSS が出す。
  private buildSheetButton(root: HTMLElement): void {
    const button = document.createElement('div');
    button.id = 'touch-sheet-btn';
    button.className = 'tbtn ui-surface-quiet';
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', '計器を開く');
    button.innerHTML = `<span class="g">計器 ⌃</span>`;
    button.addEventListener('click', () => this.onSheetToggle?.());
    button.addEventListener('contextmenu', (ev) => ev.preventDefault());
    root.appendChild(button);
  }

  // ズームの ON/OFF トグルを組む。タップのたびに切り替わり、指を離しても保持する。
  private buildZoomToggle(root: HTMLElement): void {
    const zoomBtn = document.createElement('div');
    zoomBtn.id = 'touch-zoom';
    zoomBtn.className = 'tbtn ui-surface-quiet';
    zoomBtn.innerHTML = `<span class="g">ZOOM</span>`;
    let zoomOn = false;
    // タップのたびに ON/OFF を反転させる
    zoomBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      zoomOn = !zoomOn;
      zoomBtn.classList.toggle('on', zoomOn);
      this.input.setVirtualKey(K.gunsightZoom, zoomOn);
    });
    // ズームを OFF へ戻す。
    const releaseZoom = (): void => {
      zoomOn = false;
      zoomBtn.classList.remove('on');
      this.input.setVirtualKey(K.gunsightZoom, false);
    };
    zoomBtn.addEventListener('pointercancel', releaseZoom);
    this.releaseCallbacks.push(releaseZoom);
    zoomBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    root.appendChild(zoomBtn);
  }

  // warp・マップ・ノード送り・ヘルプの雑多なボタンを1列に組み立てる。時間加速とヘルプは上のストリップと
  // ヘルプのバッジにも常設があるので、レールの無い幅ではこの行から外す(touch-util-aux)。
  private buildUtilRow(root: HTMLElement): void {
    const util = document.createElement('div');
    util.id = 'touch-util';
    root.appendChild(util);
    const aux = (button: HTMLElement): void => button.classList.add('touch-util-aux');
    aux(this.makeButton(util, { key: K.warpSlower, glyph: '«', label: '減速' }));
    aux(this.makeButton(util, { key: K.warpFaster, glyph: '»', label: '加速' }));
    this.makeButton(util, { key: K.autoWarpToNode, glyph: K.autoWarpToNode.label, label: 'ノードへ' });
    const mapToggle = this.makeButton(util, { key: K.toggleMapMode, glyph: K.toggleMapMode.label, label: MAP_TOGGLE_LABEL_IN_COMBAT });
    this.mapToggleLabel = mapToggle.querySelector<HTMLElement>('.l');
    aux(this.makeButton(util, { key: K.help, glyph: K.help.label, label: 'ヘルプ' }));
  }
}
