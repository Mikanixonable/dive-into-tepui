// タッチデバイス用の仮想操作パッド。DOM ボタンを画面下部に重ね、
// Input.setVirtualKey へ物理キーボードと同じキーコードを流し込む。
// 押しっぱなし系(並進・回転・射撃・ズーム)とエッジトリガ系(トグル類)を同じ仕組みで扱える。
// 常設で構築し、表示そのものは setPointerKind が渡す直近の入力種別に従う。
import { Input, PointerKind } from '../input/input';
import { KEY_MAPPING as K, KeyBinding } from '../input/key-mapping';
import { MQ_COARSE, MQ_COMPACT, MQ_SHORT } from '../hud/breakpoints';
import {
  FONT_FAMILY, FONT_XXS, FONT_XL, RADIUS_L, SPACE_1, TRANSITION_SLOW,
} from '../theme';

const STYLE = `
/* z-index 9: システムウィンドウ(ESC メニュー・終了画面・ヘルプ)より下に置く。
   初回タッチまでは不可視・無反応(.shown が無い間 opacity:0 かつボタンも無効)にし、
   以後マウス操作を検出するたびに .faded で半透明化する(ハイブリッド端末での両立)。 */
#touch-ui {
  position: fixed; inset: 0; pointer-events: none; z-index: 9;
  font-family: ${FONT_FAMILY}; user-select: none;
  -webkit-user-select: none;
  opacity: 0; transition: opacity ${TRANSITION_SLOW};
}
#touch-ui.shown { opacity: 1; }
#touch-ui.shown.faded { opacity: 0.35; }
#touch-ui .tbtn {
  pointer-events: none; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--surface); border: 1px solid var(--edge); border-radius: ${RADIUS_L};
  color: var(--text-muted); line-height: 1.1;
}
#touch-ui.shown .tbtn { pointer-events: auto; }
#touch-ui .tbtn .g { font-size: ${FONT_XL}; }
#touch-ui .tbtn .l { font-size: ${FONT_XXS}; color: var(--text-dim); margin-top: ${SPACE_1}; }
#touch-ui .tbtn.pressed { background: var(--color-primary-fill-strong); border-color: var(--color-primary); color: var(--text-strong); }
/* .on: 押下中かどうかに関わらず、モードが実際に ON の間ずっと点灯させる
   (制動・微動・ホールド・推力ラッチなどの向け。.pressed と見た目は同じでよい) */
#touch-ui .tbtn.on { background: var(--color-primary-fill-strong); border-color: var(--color-primary); color: var(--text-strong); }
#touch-ui .mini-col {
  position: absolute; display: grid; gap: 6px; grid-template-rows: repeat(2, 52px);
}
#touch-ui .mini-col .tbtn { width: 46px; }
#touch-ui .pad {
  position: absolute; display: grid; gap: 6px;
  grid-template-columns: repeat(3, 52px); grid-auto-rows: 52px;
}
#touch-pad-move { left: calc(10px + var(--safe-l)); bottom: calc(12px + var(--safe-b)); }
#touch-pad-rot { right: calc(10px + var(--safe-r)); bottom: calc(12px + var(--safe-b)); }
#touch-mode-col { right: calc(186px + var(--safe-r)); bottom: calc(12px + var(--safe-b)); }
#touch-fire {
  position: absolute; right: calc(22px + var(--safe-r)); bottom: calc(138px + var(--safe-b));
  width: 74px; height: 74px; border-radius: 50% !important;
  border-color: var(--color-primary-edge) !important; color: var(--color-primary) !important;
}
#touch-zoom {
  position: absolute; right: calc(112px + var(--safe-r)); bottom: calc(148px + var(--safe-b));
  width: 54px; height: 54px; border-radius: 50% !important;
}
#touch-util {
  position: absolute; left: calc(10px + var(--safe-l)); bottom: calc(138px + var(--safe-b));
  display: flex; gap: 6px; flex-wrap: wrap; max-width: 46vw;
}
#touch-util .tbtn { width: 46px; height: 42px; }
#touch-ui.map-mode #touch-util {
  left: 50%; right: auto; bottom: 8px; transform: translateX(-50%);
  flex-wrap: nowrap; max-width: calc(100vw - 16px);
}
#touch-ui.map-mode #touch-util .tbtn { flex: 0 1 46px; min-width: 34px; }

@media ${MQ_COARSE} {
  #touch-pad-move, #touch-pad-rot {
    grid-template-columns: repeat(3, 36px) !important; grid-auto-rows: 36px !important; gap: 4px;
  }
  #touch-pad-move { left: 6px; bottom: 6px; }
  #touch-pad-rot { right: 6px; bottom: 6px; }
  #touch-mode-col {
    right: auto; left: calc(50% - 34px); bottom: 6px;
    grid-template-rows: repeat(2, 36px) !important; gap: 4px;
  }
  #touch-mode-col .tbtn { width: 38px !important; }
  #touch-util { max-width: 42vw; }
  #navball { bottom: 240px !important; left: 75% !important; }
  #hud-chase-reset { left: calc(50% + 20px) !important; }
}

/* 横画面(高さが低い端末): navball を画面下部中央に収め、パッドを詰めて
   縦方向の衝突を避ける */
@media ${MQ_SHORT} {
  #navball {
    top: auto !important; bottom: 44px !important; left: 50% !important;
    transform: translateX(-50%) !important; width: 72px !important; height: 72px !important;
  }
  #touch-pad-move, #touch-pad-rot {
    grid-template-columns: repeat(3, 40px) !important; grid-auto-rows: 40px !important; gap: 4px;
  }
  #touch-pad-move { left: 6px; bottom: 6px; }
  #touch-pad-rot { right: 6px; bottom: 6px; }
  #touch-mode-col { right: auto; left: 180px; bottom: 6px; grid-template-rows: repeat(2, 40px) !important; }
  #touch-mode-col .tbtn { width: 38px !important; }
  #touch-fire { width: 56px; height: 56px; right: 14px; bottom: 116px; }
  #touch-zoom { width: 44px; height: 44px; right: 76px; bottom: 124px; }
  #touch-util { bottom: 110px; max-width: 40vw; }
  #touch-util .tbtn { width: 38px; height: 34px; }
  #touch-ui.map-mode #touch-util { bottom: 4px; max-width: calc(100vw - 12px); }
}
@media ${MQ_COMPACT} {
  #touch-pad-move, #touch-pad-rot {
    grid-template-columns: repeat(3, 36px) !important; grid-auto-rows: 36px !important; gap: 4px;
  }
  #touch-pad-move { left: 6px; bottom: 6px; }
  #touch-pad-rot { right: 6px; bottom: 6px; }
  #touch-mode-col {
    right: auto; left: calc(50% - 34px); bottom: 6px;
    grid-template-rows: repeat(2, 36px) !important; gap: 4px;
  }
  #touch-mode-col .tbtn { width: 38px !important; }
  #navball { bottom: 240px !important; left: 75% !important; }
  #hud-chase-reset { left: calc(50% + 20px) !important; }
}
`;

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
  private readonly thrustButtons = new Map<KeyBinding, HTMLElement>();
  private readonly releaseCallbacks: (() => void)[] = [];
  // 一度でも .shown になったら真のまま保つ — 以後のマウス操作は .faded で半透明化するだけで、
  // 再び隠しはしない(触ったことがある端末である事実は変わらないため)。
  private shown = false;

  // 直近の入力種別に応じて表示を切り替える。タッチなら表示して起こし、マウス/キーボードなら
  // (既に表示済みであれば)半透明化する。Input.onPointerKindChange から呼ばれる想定。
  setPointerKind(kind: PointerKind): void {
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
  syncModeButtons(
    rcsDamp: boolean, fineAttitude: boolean, progradeHold: boolean,
    isThrustLatched: (key: KeyBinding) => boolean,
  ): void {
    this.setActive(K.rcsDampToggle, rcsDamp);
    this.setActive(K.fineAttitudeToggle, fineAttitude);
    this.setActive(K.progradeHoldToggle, progradeHold);
    for (const [key, el] of this.thrustButtons) el.classList.toggle('on', isThrustLatched(key));
  }

  // key に対応するトグルボタンの点灯状態を on に合わせる。
  private setActive(key: KeyBinding, on: boolean): void {
    this.toggleButtons.get(key)?.classList.toggle('on', on);
  }

  // マップモード中は並進・回転・射撃・ズーム・制動/微動のパッドを隠す。
  setMapMode(active: boolean): void {
    this.root.classList.toggle('map-mode', active);
    for (const id of ['touch-pad-rot', 'touch-pad-move', 'touch-fire', 'touch-zoom', 'touch-mode-col']) {
      const e = document.getElementById(id);
      if (e) e.style.display = active ? 'none' : '';
    }
  }

  // 仮想パッド一式の DOM を組み立てる。
  constructor(private readonly input: Input) {
    const built = this.buildRoot();
    this.root = built.root;
    this.styleEl = built.style;
    window.addEventListener('tepui-release-touch-inputs', this.handleReleaseTouchInputs);
    // 並進・回転・射撃・ズーム・雑多ボタンの各領域を組み立てる。
    this.buildTranslationPad(this.root);
    this.buildRotationPad(this.root);
    this.buildModeColumn(this.root);
    this.makeButton(this.root, { key: K.fire, glyph: 'FIRE', label: '' }, 'touch-fire');
    this.buildZoomToggle(this.root);
    this.buildUtilRow(this.root);
  }

  private readonly handleReleaseTouchInputs = (): void => this.releaseAllInputs();

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
  dispose(): void {
    window.removeEventListener('tepui-release-touch-inputs', this.handleReleaseTouchInputs);
    this.root.remove();
    this.styleEl.remove();
  }

  // b.key を押しっぱなし操作するボタンを1つ組み立てて parent へ追加する。registry を渡すと
  // そこへ b.key で登録し、syncModeButtons が点灯対象として読む(トグル・推力ラッチ共通)。
  private makeButton(parent: HTMLElement, b: Btn, id = '', registry?: Map<KeyBinding, HTMLElement>): HTMLElement {
    const e = document.createElement('div');
    e.className = 'tbtn';
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

  // btns を並べた1つのパッドを id で root へ追加する。
  private makePad(root: HTMLElement, id: string, btns: Btn[], registry?: Map<KeyBinding, HTMLElement>): void {
    const pad = document.createElement('div');
    pad.id = id;
    pad.className = 'pad';
    root.appendChild(pad);
    for (const b of btns) this.makeButton(pad, b, '', registry);
  }

  // 並進6方向のパッドを組み立てる。
  private buildTranslationPad(root: HTMLElement): void {
    this.makePad(root, 'touch-pad-move', [
      { key: K.thrustUp, glyph: '▲', label: '上' },
      { key: K.thrustForward, glyph: '●', label: '前' },
      { key: K.thrustDown, glyph: '▼', label: '下' },
      { key: K.thrustLeft, glyph: '◀', label: '左' },
      { key: K.thrustBackward, glyph: '○', label: '後' },
      { key: K.thrustRight, glyph: '▶', label: '右' },
    ], this.thrustButtons);
  }

  // 回転3軸のパッドを組み立てる。
  private buildRotationPad(root: HTMLElement): void {
    this.makePad(root, 'touch-pad-rot', [
      { key: K.rollLeft, glyph: '⟲', label: 'ロール' },
      { key: K.pitchDown, glyph: '↓', label: '機首下げ' },
      { key: K.rollRight, glyph: '⟳', label: 'ロール' },
      { key: K.yawRight, glyph: '→', label: 'ヨー' },
      { key: K.pitchUp, glyph: '↑', label: '機首上げ' },
      { key: K.yawLeft, glyph: '←', label: 'ヨー' },
    ]);
  }

  // 制動・微動のトグルボタン列を組み立てる。
  private buildModeColumn(root: HTMLElement): void {
    const modeCol = document.createElement('div');
    modeCol.id = 'touch-mode-col';
    modeCol.className = 'mini-col';
    root.appendChild(modeCol);
    this.makeButton(modeCol, { key: K.rcsDampToggle, glyph: K.rcsDampToggle.label, label: '制動' }, '', this.toggleButtons);
    this.makeButton(modeCol, { key: K.fineAttitudeToggle, glyph: K.fineAttitudeToggle.label, label: '微動' }, '', this.toggleButtons);
  }

  // ズームは長押しでなく ON/OFF トグル(タップのたびに切り替え、指を離しても保持)
  private buildZoomToggle(root: HTMLElement): void {
    const zoomBtn = document.createElement('div');
    zoomBtn.id = 'touch-zoom';
    zoomBtn.className = 'tbtn';
    zoomBtn.innerHTML = `<span class="g">ZOOM</span>`;
    let zoomOn = false;
    // タップのたびに ON/OFF を反転させる
    zoomBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      zoomOn = !zoomOn;
      zoomBtn.classList.toggle('pressed', zoomOn);
      this.input.setVirtualKey(K.gunsightZoom, zoomOn);
    });
    const releaseZoom = (): void => {
      zoomOn = false;
      zoomBtn.classList.remove('pressed');
      this.input.setVirtualKey(K.gunsightZoom, false);
    };
    zoomBtn.addEventListener('pointercancel', releaseZoom);
    this.releaseCallbacks.push(releaseZoom);
    zoomBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    root.appendChild(zoomBtn);
  }

  // warp・マップ・ノード送り・ヘルプの雑多なボタンを1列に組み立てる。
  private buildUtilRow(root: HTMLElement): void {
    const util = document.createElement('div');
    util.id = 'touch-util';
    root.appendChild(util);
    for (const b of [
      { key: K.warpSlower, glyph: '«', label: '減速' },
      { key: K.warpFaster, glyph: '»', label: '加速' },
      { key: K.toggleMapMode, glyph: K.toggleMapMode.label, label: '計画' },
      { key: K.autoWarpToNode, glyph: K.autoWarpToNode.label, label: 'ノードへ' },
      { key: K.help, glyph: K.help.label, label: 'ヘルプ' },
    ]) {
      this.makeButton(util, b);
    }
    // ホールドはトグルボタンとして登録する
    this.makeButton(util, { key: K.progradeHoldToggle, glyph: K.progradeHoldToggle.label, label: 'ホールド' }, '', this.toggleButtons);
  }
}
