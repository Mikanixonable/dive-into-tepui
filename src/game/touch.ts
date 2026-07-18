// タッチデバイス用の仮想操作パッド。DOM ボタンを画面下部に重ね、
// Input.setVirtualKey へ物理キーボードと同じキーコードを流し込む。
// 押しっぱなし系(並進・回転・射撃・ズーム)とエッジトリガ系(トグル類)を
// 同じ仕組みで扱える。マウス+キーボード環境では生成しない。
import { Input } from './input';
import { ACCENT, ACCENT_RGB, TEXT_DIM } from './theme';

// SURFACE/EDGE はこのファイル固有の不透明度(0.66 / 0.14)を使うため、
// theme.ts の SURFACE(0.82)/EDGE(0.09)とは別定数のまま保持する。
const SURFACE = 'rgba(13, 15, 18, 0.66)';
const EDGE = 'rgba(255, 255, 255, 0.14)';

const STYLE = `
#touch-ui {
  position: fixed; inset: 0; pointer-events: none; z-index: 11;
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
  code: string;
  glyph: string;
  label: string;
}

export class TouchControls {
  // ON/OFF 状態を反映させるトグル系ボタン(制動・微動・ホールド等)。
  // タップの押下フィードバック(.held)とは独立に、実際のモード状態で光らせる。
  private readonly toggleButtons = new Map<string, HTMLElement>();

  static isTouchDevice(): boolean {
    return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  }

  // ゲーム側のモード状態(RCS制動・微調整・進行方向ホールド等)が変化した際に
  // 呼び、対応するボタンの ON/OFF 表示を同期する。該当ボタンが無ければ何もしない。
  setActive(code: string, on: boolean): void {
    this.toggleButtons.get(code)?.classList.toggle('on', on);
  }

  // マップモード(軌道計画)中は並進・回転・射撃・ズームのパッドを隠す
  // (mapgizmo.ts の DOM ハンドルと画面下部で重なるため)。M/N/H 等の
  // トグル系ボタンが並ぶ util 行はそのまま表示を続ける。
  setMapMode(active: boolean): void {
    for (const id of ['touch-pad-rot', 'touch-pad-move', 'touch-fire', 'touch-zoom']) {
      const e = document.getElementById(id);
      if (e) e.style.display = active ? 'none' : '';
    }
  }

  constructor(input: Input) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'touch-ui';
    document.body.appendChild(root);

    const mkBtn = (parent: HTMLElement, b: Btn, id = '', isToggle = false): HTMLElement => {
      const e = document.createElement('div');
      e.className = 'tbtn';
      if (id) e.id = id;
      e.innerHTML = `<span class="g">${b.glyph}</span>${b.label ? `<span class="l">${b.label}</span>` : ''}`;
      const down = (ev: PointerEvent) => {
        ev.preventDefault();
        e.setPointerCapture(ev.pointerId);
        e.classList.add('held');
        input.setVirtualKey(b.code, true);
      };
      const up = () => {
        e.classList.remove('held');
        input.setVirtualKey(b.code, false);
      };
      e.addEventListener('pointerdown', down);
      e.addEventListener('pointerup', up);
      e.addEventListener('pointercancel', up);
      e.addEventListener('contextmenu', (ev) => ev.preventDefault());
      parent.appendChild(e);
      if (isToggle) this.toggleButtons.set(b.code, e);
      return e;
    };

    const mkPad = (id: string, btns: Btn[]): void => {
      const pad = document.createElement('div');
      pad.id = id;
      pad.className = 'pad';
      root.appendChild(pad);
      for (const b of btns) mkBtn(pad, b);
    };

    // 並進 (RCS): 上段 = 上/前/下, 下段 = 左/後/右
    mkPad('touch-pad-move', [
      { code: 'KeyQ', glyph: '▲', label: '上' },
      { code: 'KeyW', glyph: '●', label: '前' },
      { code: 'KeyE', glyph: '▼', label: '下' },
      { code: 'KeyA', glyph: '◀', label: '左' },
      { code: 'KeyS', glyph: '○', label: '後' },
      { code: 'KeyD', glyph: '▶', label: '右' },
    ]);

    // 回転: 上段 = ロール左/ピッチ下げ/ロール右, 下段 = ヨー左/ピッチ上げ/ヨー右
    mkPad('touch-pad-rot', [
      { code: 'KeyU', glyph: '⟲', label: 'ロール' },
      { code: 'KeyI', glyph: '↓', label: '機首下げ' },
      { code: 'KeyO', glyph: '⟳', label: 'ロール' },
      { code: 'KeyJ', glyph: '→', label: 'ヨー' },
      { code: 'KeyK', glyph: '↑', label: '機首上げ' },
      { code: 'KeyL', glyph: '←', label: 'ヨー' },
    ]);

    // 姿勢制御パッドのすぐ近くに、姿勢まわりのモード切替(制動・微動)をまとめる。
    // ON の間は色が変わる(タップの瞬間だけ光る .held とは別に .on を常時反映)。
    const modeCol = document.createElement('div');
    modeCol.id = 'touch-mode-col';
    modeCol.className = 'mini-col';
    root.appendChild(modeCol);
    mkBtn(modeCol, { code: 'KeyT', glyph: 'T', label: '制動' }, '', true);
    mkBtn(modeCol, { code: 'KeyV', glyph: 'V', label: '微動' }, '', true);

    mkBtn(root, { code: 'Space', glyph: 'FIRE', label: '' }, 'touch-fire');

    // ズームは長押しでなく ON/OFF トグル(タップのたびに切り替え、指を離しても保持)
    const zoomBtn = document.createElement('div');
    zoomBtn.id = 'touch-zoom';
    zoomBtn.className = 'tbtn';
    zoomBtn.innerHTML = `<span class="g">ZOOM</span>`;
    let zoomOn = false;
    zoomBtn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      zoomOn = !zoomOn;
      zoomBtn.classList.toggle('held', zoomOn);
      input.setVirtualKey('KeyZ', zoomOn);
    });
    zoomBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());
    root.appendChild(zoomBtn);

    const util = document.createElement('div');
    util.id = 'touch-util';
    root.appendChild(util);
    for (const b of [
      { code: 'Tab', glyph: 'TGT', label: '切替' },
      { code: 'Comma', glyph: '«', label: 'warp' },
      { code: 'Period', glyph: '»', label: 'warp' },
      { code: 'KeyM', glyph: 'M', label: '計画' },
      { code: 'KeyN', glyph: 'N', label: 'ノードへ' },
      { code: 'KeyH', glyph: 'H', label: 'ヘルプ' },
    ]) {
      mkBtn(util, b);
    }
    // 進行方向ホールドも ON/OFF 表示を反映するトグルボタンとして登録する
    mkBtn(util, { code: 'KeyC', glyph: 'C', label: 'ホールド' }, '', true);
  }
}
