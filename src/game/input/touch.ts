// タッチデバイス用の仮想操作パッド。DOM ボタンを画面下部に重ね、
// Input.setVirtualKey へ物理キーボードと同じキーコードを流し込む。
// 押しっぱなし系(並進・回転・射撃・ズーム)とエッジトリガ系(トグル類)を
// 同じ仕組みで扱える。マウス+キーボード環境では生成しない。
import { Input } from '../input/input';
import { KEY_MAPPING as K, KeyBinding } from '../input/key-mapping';
import { ACCENT, ACCENT_RGB, TEXT_DIM } from '../theme';

// SURFACE/EDGE はこのファイル固有の不透明度(0.66 / 0.14)を使うため、
// theme.ts の SURFACE(0.82)/EDGE(0.09)とは別定数のまま保持する。
const SURFACE = 'rgba(13, 15, 18, 0.66)';
const EDGE = 'rgba(255, 255, 255, 0.14)';

const STYLE = `
/* z-index 9: システムウィンドウ(ESC メニュー・終了画面・ヘルプ)より下に置く */
#touch-ui {
  position: fixed; inset: 0; pointer-events: none; z-index: 9;
  font-family: 'Consolas', 'Courier New', monospace; user-select: none;
  -webkit-user-select: none;
}
#touch-ui .tbtn {
  pointer-events: auto; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 8px;
  color: #cfd6dd; line-height: 1.1;
}
#touch-ui .tbtn .g { font-size: 16px; }
#touch-ui .tbtn .l { font-size: 9px; color: ${TEXT_DIM}; margin-top: 1px; }
#touch-ui .tbtn.held { background: rgba(${ACCENT_RGB}, 0.28); border-color: ${ACCENT}; color: #fff; }
/* .on: 押下中かどうかに関わらず、モードが実際に ON の間ずっと点灯させる
   (制動・微動・ホールドなどのトグル系ボタン向け。.held と見た目は同じでよい) */
#touch-ui .tbtn.on { background: rgba(${ACCENT_RGB}, 0.28); border-color: ${ACCENT}; color: #fff; }
#touch-ui .mini-col {
  position: absolute; display: grid; gap: 6px; grid-template-rows: repeat(2, 52px);
}
#touch-ui .mini-col .tbtn { width: 46px; }
#touch-ui .pad {
  position: absolute; display: grid; gap: 6px;
  grid-template-columns: repeat(3, 52px); grid-auto-rows: 52px;
}
#touch-pad-move { left: 10px; bottom: 12px; }
#touch-pad-rot { right: 10px; bottom: 12px; }
#touch-mode-col { right: 186px; bottom: 12px; }
#touch-fire {
  position: absolute; right: 22px; bottom: 138px;
  width: 74px; height: 74px; border-radius: 50% !important;
  border-color: rgba(${ACCENT_RGB}, 0.55) !important; color: ${ACCENT} !important;
}
#touch-zoom {
  position: absolute; right: 112px; bottom: 148px;
  width: 54px; height: 54px; border-radius: 50% !important;
}
#touch-util {
  position: absolute; left: 10px; bottom: 138px;
  display: flex; gap: 6px; flex-wrap: wrap; max-width: 46vw;
}
#touch-util .tbtn { width: 46px; height: 42px; }

/* 横画面(高さが低い端末): navball を画面下部中央に収め、パッドを詰めて
   縦方向の衝突を避ける */
@media (orientation: landscape) and (max-height: 500px) {
  #navball { bottom: 4px !important; width: 88px !important; height: 88px !important; }
  #touch-pad-move, #touch-pad-rot {
    grid-template-columns: repeat(3, 40px); grid-auto-rows: 40px; gap: 4px;
  }
  #touch-pad-move { left: 6px; bottom: 6px; }
  #touch-pad-rot { right: 6px; bottom: 6px; }
  #touch-mode-col { right: 140px; bottom: 6px; grid-template-rows: repeat(2, 40px); }
  #touch-mode-col .tbtn { width: 38px; }
  #touch-fire { width: 56px; height: 56px; right: 14px; bottom: 116px; }
  #touch-zoom { width: 44px; height: 44px; right: 76px; bottom: 124px; }
  #touch-util { bottom: 110px; max-width: 40vw; }
  #touch-util .tbtn { width: 38px; height: 34px; }
}
`;

interface Btn {
  key: KeyBinding;
  glyph: string;
  label: string;
}

export class TouchControls {
  // トグル系ボタン: タップの押下フィードバック(.held)とは独立に実際のモード状態で光らせる。
  private readonly toggleButtons = new Map<KeyBinding, HTMLElement>();

  // 現在の端末がタッチ操作に対応しているかを返す。
  static isTouchDevice(): boolean {
    return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  }

  // トグル系ボタンの点灯を実際のモード状態へ合わせる。毎フレーム呼ぶ。
  syncModeButtons(rcsDamp: boolean, fineAttitude: boolean, progradeHold: boolean): void {
    this.setActive(K.rcsDampToggle, rcsDamp);
    this.setActive(K.fineAttitudeToggle, fineAttitude);
    this.setActive(K.progradeHoldToggle, progradeHold);
  }

  // key に対応するトグルボタンの点灯状態を on に合わせる。
  private setActive(key: KeyBinding, on: boolean): void {
    this.toggleButtons.get(key)?.classList.toggle('on', on);
  }

  // マップモード中は並進・回転・射撃・ズームのパッドを隠す。
  setMapMode(active: boolean): void {
    for (const id of ['touch-pad-rot', 'touch-pad-move', 'touch-fire', 'touch-zoom']) {
      const e = document.getElementById(id);
      if (e) e.style.display = active ? 'none' : '';
    }
  }

  // 仮想パッド一式の DOM を組み立てる。
  constructor(private readonly input: Input) {
    const root = this.buildRoot();
    this.buildTranslationPad(root);
    this.buildRotationPad(root);
    this.buildModeColumn(root);
    this.makeButton(root, { key: K.fire, glyph: 'FIRE', label: '' }, 'touch-fire');
    this.buildZoomToggle(root);
    this.buildUtilRow(root);
  }

  // スタイルシートと仮想パッドのルート要素を document へ追加し、ルート要素を返す。
  private buildRoot(): HTMLElement {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'touch-ui';
    document.body.appendChild(root);
    return root;
  }

  // b.key を押しっぱなし操作するボタンを1つ組み立てて parent へ追加する。
  // isToggle なら toggleButtons に登録し、syncModeButtons の点灯対象にする。
  private makeButton(parent: HTMLElement, b: Btn, id = '', isToggle = false): HTMLElement {
    const e = document.createElement('div');
    e.className = 'tbtn';
    if (id) e.id = id;
    e.innerHTML = `<span class="g">${b.glyph}</span>${b.label ? `<span class="l">${b.label}</span>` : ''}`;
    // 押下中は仮想キーを ON にし続ける
    const down = (ev: PointerEvent) => {
      ev.preventDefault();
      e.setPointerCapture(ev.pointerId);
      e.classList.add('held');
      this.input.setVirtualKey(b.key, true);
    };
    // 指を離したら仮想キーを OFF に戻す
    const up = () => {
      e.classList.remove('held');
      this.input.setVirtualKey(b.key, false);
    };
    e.addEventListener('pointerdown', down);
    e.addEventListener('pointerup', up);
    e.addEventListener('pointercancel', up);
    e.addEventListener('contextmenu', (ev) => ev.preventDefault());
    parent.appendChild(e);
    if (isToggle) this.toggleButtons.set(b.key, e);
    return e;
  }

  // btns を並べた1つのパッドを id で root へ追加する。
  private makePad(root: HTMLElement, id: string, btns: Btn[]): void {
    const pad = document.createElement('div');
    pad.id = id;
    pad.className = 'pad';
    root.appendChild(pad);
    for (const b of btns) this.makeButton(pad, b);
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
    ]);
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
    this.makeButton(modeCol, { key: K.rcsDampToggle, glyph: K.rcsDampToggle.label, label: '制動' }, '', true);
    this.makeButton(modeCol, { key: K.fineAttitudeToggle, glyph: K.fineAttitudeToggle.label, label: '微動' }, '', true);
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
      zoomBtn.classList.toggle('held', zoomOn);
      this.input.setVirtualKey(K.gunsightZoom, zoomOn);
    });
    zoomBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    root.appendChild(zoomBtn);
  }

  // warp・マップ・ヘルプ等の雑多なボタンを1列に組み立てる。
  private buildUtilRow(root: HTMLElement): void {
    const util = document.createElement('div');
    util.id = 'touch-util';
    root.appendChild(util);
    for (const b of [
      { key: K.warpSlower, glyph: '«', label: 'warp' },
      { key: K.warpFaster, glyph: '»', label: 'warp' },
      { key: K.toggleMapMode, glyph: K.toggleMapMode.label, label: '計画' },
      { key: K.autoWarpToNode, glyph: K.autoWarpToNode.label, label: 'ノードへ' },
      { key: K.help, glyph: K.help.label, label: 'ヘルプ' },
    ]) {
      this.makeButton(util, b);
    }
    // ホールドはトグルボタンとして登録する
    this.makeButton(util, { key: K.progradeHoldToggle, glyph: K.progradeHoldToggle.label, label: 'ホールド' }, '', true);
  }
}
