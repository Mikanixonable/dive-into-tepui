// 起動時のステージ選択画面 GUI。
// デザインは DEVELOP/TYPOGRAPHY_LOGOTYPE_SYMBOL_PROPOSAL_V3.md(第三版)の表示場面規則
// (Scene first / 単一アクセント / 変則改行ロゴタイプ / 外周線なしの境界)に従い、
// リッチ面 — 3D風生成背景の上に浮かぶ角丸グラスウィンドウ — は第五版
// (DEVELOP/UI_DESIGN_REFERENCE_V5.md §6.2/§7)を参照する。
// 配色・書体は第三版標本自身の値であり、theme.ts への統合は移行計画 Phase 1 の仕事。
import { STAGE_CLASSES } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import type { StageClass } from './stages/stage';
import { StageDebug } from './stages/stage-debug';
import { TabBar } from './hud/widgets';
import { MQ_COMPACT } from './hud/breakpoints';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';

// 第三版標本のダーク面パレット(§7.1)とアクセント hsl(12 100% 56%) = #FF4B1F。
const PAGE = '#07080a';
const TITLE_INK = '#eeeaf5';
const MUTED_INK = '#89838f';
const FAINT_INK = '#5f5a65';
const ACCENT_V3 = '#ff4b1f';
const ACCENT_HUE = 12;
const ACCENT_SAT = 100;
const ACCENT_LIT = 56;

// 第三版の書体スタック(§3)。WOFF2 自己配信前はローカルフォールバックで成立させる。
const FONT_SANS = '"Arimo","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
const FONT_SERIF = '"Cormorant Garamond","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const FONT_MONO = '"IBM Plex Mono","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",monospace';

const STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: 100; overflow: hidden; isolation: isolate;
  background: ${PAGE}; color: ${TITLE_INK}; font-family: ${FONT_SANS};
}
#stage-select .ss-canvas {
  position: absolute; inset: -12px; z-index: -3;
  width: calc(100% + 24px); height: calc(100% + 24px);
  filter: blur(5px) contrast(1.08) saturate(0.9);
  image-rendering: pixelated; transform: scale(1.02);
}
#stage-select .ss-vignette {
  position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background:
    linear-gradient(90deg, rgb(7 8 10 / 0.30), transparent 58%),
    linear-gradient(0deg, rgb(7 8 10 / 0.85), transparent 36%),
    radial-gradient(circle at 42% 44%, transparent 30%, rgb(7 8 10 / 0.42) 100%);
}
#stage-select .ss-grid {
  position: relative; height: 100%; box-sizing: border-box;
  display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 440px);
  gap: clamp(20px, 4vw, 64px); align-items: center;
  padding: clamp(24px, 6vh, 64px) clamp(20px, 5vw, 72px);
  padding: clamp(24px, 6dvh, 64px) clamp(20px, 5vw, 72px);
}
#stage-select .ss-hero { min-width: 0; }
#stage-select .ss-eyebrow {
  display: flex; align-items: center; gap: 10px; margin: 0 0 14px;
  color: ${MUTED_INK}; font-family: ${FONT_MONO};
  font-size: 11px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
}
#stage-select .ss-eyebrow::before {
  content: ""; width: 28px; height: 3px; border-radius: 999px; background: ${ACCENT_V3};
}
#stage-select .ss-logotype {
  margin: 0; color: #fff; font-weight: 400;
  font-size: clamp(48px, 9vw, 128px);
  letter-spacing: -0.065em; line-height: 0.74; text-transform: uppercase;
  mix-blend-mode: difference;
}
#stage-select .ss-line { position: relative; display: block; width: fit-content; white-space: nowrap; }
#stage-select .ss-line:nth-child(2) { margin-left: 0.42em; }
#stage-select .ss-line:nth-child(3) { margin-left: 0.84em; }
#stage-select .ss-orn {
  position: absolute; left: calc(100% + 12px); color: #fff;
  font-family: ${FONT_MONO}; font-size: clamp(10px, 1.3vw, 17px);
  font-weight: 500; letter-spacing: 0.08em; line-height: 1;
}
#stage-select .ss-line:nth-child(1) .ss-orn { top: 0.02em; }
#stage-select .ss-line:nth-child(2) .ss-orn { bottom: 0.04em; }
#stage-select .ss-line:nth-child(3) .ss-orn { top: 0.02em; }
#stage-select .ss-sub {
  width: fit-content; margin: clamp(18px, 2.8vw, 32px) 0 0 0.12em;
  color: ${ACCENT_V3}; font-family: ${FONT_SERIF};
  font-size: clamp(22px, 3vw, 42px); font-weight: 300; line-height: 1;
  mix-blend-mode: difference;
}
#stage-select .ss-sub-ja {
  width: fit-content; margin: 6px 0 0 0.22em;
  color: ${ACCENT_V3}; font-family: ${FONT_SERIF};
  font-size: clamp(15px, 1.55vw, 20px); font-weight: 400; line-height: 1.3;
  mix-blend-mode: difference;
}
#stage-select .ss-window {
  min-height: 0; max-height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 12px;
  padding: 20px;
  background: rgb(13 15 19 / 0.58); border-radius: 34px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.3);
  backdrop-filter: blur(24px) saturate(115%);
  -webkit-backdrop-filter: blur(24px) saturate(115%);
}
#stage-select .ss-window-title {
  margin: 0 0 2px 6px; color: ${MUTED_INK};
  font-size: 15px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .ss-list {
  min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 0;
}
#stage-select .ss-stage {
  box-sizing: border-box; padding: 14px 20px; border-radius: 22px;
  background: rgb(24 27 33 / 0.62); cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
#stage-select .ss-stage:hover { background: rgb(34 38 46 / 0.74); }
#stage-select .ss-stage.locked { opacity: 0.45; cursor: default; }
#stage-select .ss-stage.locked:hover { background: rgb(24 27 33 / 0.62); }
#stage-select .ss-stage-label {
  display: flex; align-items: baseline; gap: 10px;
  color: ${TITLE_INK}; font-size: 20px; letter-spacing: 0.04em; line-height: 1.4;
}
#stage-select .ss-stage:not(.locked):hover .ss-stage-label { color: ${ACCENT_V3}; }
#stage-select .ss-stage.locked .ss-stage-label { color: ${FAINT_INK}; }
#stage-select .ss-stage-key { font-family: ${FONT_MONO}; font-size: 11px; font-weight: 500; color: ${MUTED_INK}; }
#stage-select .ss-stage-sub { margin-top: 3px; color: ${MUTED_INK}; font-size: 12px; line-height: 1.55; }
#stage-select .ss-corner {
  position: absolute; right: clamp(16px, 3vw, 40px); bottom: clamp(14px, 3vh, 32px);
  width: 84px; opacity: 0.72; image-rendering: pixelated;
}
#stage-select .ss-debug {
  position: absolute; bottom: 12px; left: 16px;
  color: ${FAINT_INK}; font-family: ${FONT_MONO}; font-size: 11px; cursor: pointer;
}
@media ${MQ_COMPACT} {
  #stage-select { overflow-y: auto; }
  #stage-select .ss-grid {
    grid-template-columns: minmax(0, 1fr); align-items: start; height: auto; min-height: 100%;
    gap: 24px;
  }
  #stage-select .ss-window { max-height: none; border-radius: 26px; padding: 16px; }
  #stage-select .ss-corner { display: none; }
}
`;

// 標本 HTML と同じパターンの一回注入(dock-view.ts / save-browser.ts と同型)。
function ensureStyle(): void {
  if (document.getElementById('stage-select-style')) return;
  const style = document.createElement('style');
  style.id = 'stage-select-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 第三版標本 §8 の生成背景: 低解像度 Canvas に球・カプセル・軌道線・粒子・ノイズを合成し、
// CSS 側の拡大+ぼかしでモザイクを作る。戻り値は後片付け関数。
function startGenerativeBackground(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frameId = 0;
  let w = 0;
  let h = 0;

  let seedState = 17431;
  // 決定的な線形合同法の [0,1) 乱数。毎回同じ構図から漂流を始めるための固定シード。
  const random = () => {
    seedState = (seedState * 1664525 + 1013904223) >>> 0;
    return seedState / 4294967296;
  };
  const particles = Array.from({ length: 54 }, () => ({
    x: random(), y: random(),
    radius: 0.6 + random() * 2.2,
    phase: random() * Math.PI * 2,
    speed: 0.08 + random() * 0.2,
    depth: 0.25 + random() * 0.75,
  }));

  const accentHsla = (lit: number, alpha: number) =>
    `hsla(${ACCENT_HUE}, ${ACCENT_SAT}%, ${lit}%, ${alpha})`;

  // 球状の放射グラデーション(抽象的な天体)を1つ描く。座標・半径は Canvas 内部解像度基準。
  const drawBlob = (x: number, y: number, radius: number, alpha: number) => {
    const g = context.createRadialGradient(x - radius * 0.28, y - radius * 0.32, radius * 0.05, x, y, radius);
    g.addColorStop(0, accentHsla(70, alpha));
    g.addColorStop(0.34, accentHsla(42, alpha * 0.72));
    g.addColorStop(1, 'rgba(4, 5, 8, 0)');
    context.fillStyle = g;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  };

  // 中心 (x, y) に角度 angle で置いた両端半円のカプセルを、端が透ける線形グラデーションで描く。
  const drawCapsule = (x: number, y: number, length: number, width: number, angle: number, alpha: number) => {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    const g = context.createLinearGradient(-length / 2, 0, length / 2, 0);
    g.addColorStop(0, 'rgba(238, 234, 245, 0)');
    g.addColorStop(0.4, `rgba(238, 234, 245, ${alpha})`);
    g.addColorStop(0.62, accentHsla(ACCENT_LIT, alpha * 0.82));
    g.addColorStop(1, 'rgba(238, 234, 245, 0)');
    context.fillStyle = g;
    // 両端の半円2つを弧でつないだ閉路がカプセル形になる。
    const r = width / 2;
    context.beginPath();
    context.arc(-length / 2 + r, 0, r, Math.PI / 2, -Math.PI / 2);
    context.arc(length / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
    context.closePath();
    context.fill();
    context.restore();
  };

  // 1フレーム分の全構図(背景→球→カプセル→軌道線→粒子→ノイズ)を描く。timestamp はミリ秒。
  const render = (timestamp: number) => {
    const time = reduced.matches ? 0 : timestamp / 1000;
    const bg = context.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#050609');
    bg.addColorStop(0.54, '#11141a');
    bg.addColorStop(1, '#06070a');
    context.fillStyle = bg;
    context.fillRect(0, 0, w, h);

    drawBlob(w * (0.74 + Math.sin(time * 0.13) * 0.05), h * (0.3 + Math.cos(time * 0.11) * 0.05), Math.min(w, h) * 0.42, 0.88);
    drawBlob(w * (0.42 + Math.cos(time * 0.09) * 0.06), h * (0.75 + Math.sin(time * 0.12) * 0.04), Math.min(w, h) * 0.26, 0.46);

    drawCapsule(w * 0.7, h * 0.57, w * 0.42, Math.max(8, h * 0.08), -0.36 + Math.sin(time * 0.15) * 0.08, 0.48);
    drawCapsule(w * 0.34, h * 0.3, w * 0.28, Math.max(6, h * 0.045), 0.58 + Math.cos(time * 0.12) * 0.06, 0.26);

    context.save();
    context.translate(w * 0.67, h * 0.48);
    context.rotate(-0.28 + time * 0.012);
    context.strokeStyle = accentHsla(ACCENT_LIT, 0.46);
    context.lineWidth = Math.max(0.7, w / 700);
    context.beginPath();
    context.ellipse(0, 0, w * 0.3, h * 0.18, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();

    for (const p of particles) {
      const drift = time * p.speed;
      const x = (p.x * w + drift * w * 0.035 * p.depth) % w;
      const y = p.y * h + Math.sin(drift + p.phase) * h * 0.035;
      const alpha = 0.12 + p.depth * 0.42;
      context.fillStyle = p.depth > 0.68 ? accentHsla(ACCENT_LIT, alpha) : `rgba(238, 234, 245, ${alpha})`;
      context.fillRect(x, y, p.radius, p.radius);
    }

    // 低密度の明暗セルを位相に応じて更新するピクセルノイズ(毎フレーム全画素は書き換えない)。
    for (let i = 0; i < 90; i += 1) {
      const x = (i * 97 + Math.floor(time * 3) * 31) % w;
      const y = (i * 53 + Math.floor(time * 2) * 17) % h;
      context.fillStyle = `rgba(255, 255, 255, ${0.018 + (i % 5) * 0.008})`;
      context.fillRect(x, y, 1 + (i % 3), 1 + (i * 2) % 3);
    }
  };

  // rAF ループ本体。Reduced Motion / 非表示タブでは自分から止まる。
  const animate = (timestamp: number) => {
    render(timestamp);
    if (!reduced.matches && !document.hidden) frameId = window.requestAnimationFrame(animate);
  };
  // ループを(再)開始する。Reduced Motion では一枚だけ描いて静止する。
  const start = () => {
    window.cancelAnimationFrame(frameId);
    if (reduced.matches) { render(0); return; }
    frameId = window.requestAnimationFrame(animate);
  };
  // 表示寸法から内部解像度を決め直して一枚描く。ResizeObserver から呼ばれる。
  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    // 表示寸法の 1/4〜1/8 の内部解像度がモザイクを作る(標本は 0.22)。
    w = Math.max(120, Math.ceil(bounds.width * 0.22));
    h = Math.max(100, Math.ceil(bounds.height * 0.22));
    canvas.width = w;
    canvas.height = h;
    render(0);
  };
  // タブが隠れたら更新を止め、戻ったら再開する。
  const onVisibility = () => {
    if (document.hidden) window.cancelAnimationFrame(frameId);
    else start();
  };

  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', start);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  start();

  return () => {
    window.cancelAnimationFrame(frameId);
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', start);
    observer.disconnect();
  };
}

// 起動選択画面(各ステージの selectGroup ごとのタブ)を表示し、選ばれたステージクラスで解決される Promise を返す。
export function selectStage(unlockManager: UnlockManager): Promise<StageClass> {
  return new Promise((resolve) => {
    ensureStyle();
    const root = document.createElement('div');
    root.id = 'stage-select';
    root.innerHTML =
      '<canvas class="ss-canvas" aria-hidden="true"></canvas>' +
      '<div class="ss-vignette" aria-hidden="true"></div>' +
      '<div class="ss-grid">' +
      '<div class="ss-hero">' +
      '<p class="ss-eyebrow">Sortie select · 公暦20115年</p>' +
      '<h1 class="ss-logotype">' +
      '<span class="ss-line">DIVE<sup class="ss-orn">∴03</sup></span>' +
      '<span class="ss-line">INTO<sub class="ss-orn">ECI₀</sub></span>' +
      '<span class="ss-line">TEPUI<sup class="ss-orn">Ω⁺</sup></span>' +
      '</h1>' +
      '<p class="ss-sub">The Orbit Is the Battlefield</p>' +
      '<p class="ss-sub-ja">軌道が戦場になる</p>' +
      '</div>' +
      '</div>' +
      `<img class="ss-corner" src="${tepuiRmqrUrl}" alt="dive into tepui">`;

    const stopBackground = startGenerativeBackground(root.querySelector('.ss-canvas') as HTMLCanvasElement);

    // グラスウィンドウ: タブとステージ一覧を生成背景の上に浮かべる(外周線なし)。
    const windowDiv = document.createElement('div');
    windowDiv.className = 'ss-window';
    windowDiv.innerHTML = '<h2 class="ss-window-title">ステージ選択</h2>';
    (root.querySelector('.ss-grid') as HTMLElement).appendChild(windowDiv);

    // タブは selectGroup の初出順に並べる。
    const groups: string[] = [];
    for (const stageClass of STAGE_CLASSES) {
      if (stageClass.hiddenFromSelect || groups.includes(stageClass.selectGroup)) continue;
      groups.push(stageClass.selectGroup);
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'ss-list';

    // タブ切替: 選んだタブに応じて下のリスト表示を入れ替える。
    const tabBar = new TabBar<string>(groups.map((g) => [g, g] as const), (group) => setActiveTab(group));
    windowDiv.appendChild(tabBar.element);
    windowDiv.appendChild(listDiv);

    // 指定タブを選択状態にし、そのグループのステージ行を一覧へ並べ直す。
    const setActiveTab = (group: string) => {
      tabBar.setSelected(group);
      // 一覧はタブ切替のたびに作り直す(起動時の一回きりの画面なので差分更新は要らない)。
      listDiv.innerHTML = '';
      for (const stageClass of STAGE_CLASSES) {
        if (stageClass.hiddenFromSelect || stageClass.selectGroup !== group) continue;
        const enabled = enabledByStage.get(stageClass.id) ?? false;
        const sub = enabled ? stageClass.selectSub : stageClass.selectLockedSub ?? stageClass.selectSub;
        const key = stageClass.selectKeys[0] ? `[${stageClass.selectKeys[0].replace('Digit', '').replace('Key', '')}]` : '';
        const row = document.createElement('div');
        row.className = `ss-stage${enabled ? '' : ' locked'}`;
        row.innerHTML =
          `<div class="ss-stage-label"><span>${stageClass.selectLabel}</span><span class="ss-stage-key">${key}</span></div>` +
          `<div class="ss-stage-sub">${sub}</div>`;
        listDiv.appendChild(row);
        if (enabled) row.addEventListener('click', () => done(stageClass));
      }
    };

    // 解放状況ごとにボタンを並べる
    const enabledByStage = new Map(STAGE_CLASSES.map((stageClass) => [stageClass.id, unlockManager.isUnlocked(stageClass.id)]));
    if (groups[0]) setActiveTab(groups[0]);

    // 隅の控えめなリンクからデバッグステージへ移動できる。
    const debugLink = document.createElement('div');
    debugLink.className = 'ss-debug';
    debugLink.textContent = 'debug stage [d]';
    debugLink.addEventListener('click', () => done(StageDebug));
    root.appendChild(debugLink);

    document.body.appendChild(root);

    // 選択確定: 背景と画面を片付けて Promise を解決する
    const done = (stageClass: StageClass) => {
      window.removeEventListener('keydown', onKey);
      stopBackground();
      root.remove();
      resolve(stageClass);
    };
    // 解放済みステージのショートカットキーにマッチしたら選択確定する。タブに関係なく効く。
    const onKey = (e: KeyboardEvent) => {
      for (const stageClass of STAGE_CLASSES) {
        if (!(enabledByStage.get(stageClass.id) ?? false)) continue;
        if (!stageClass.selectKeys.includes(e.code)) continue;
        done(stageClass);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
  });
}
