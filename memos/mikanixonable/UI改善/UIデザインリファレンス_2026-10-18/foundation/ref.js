// デザインリファレンスの外枠。ゲームへは移さない。
//
// ページ側の書き方:
//   <body class="rf" data-title="戦闘ビュー" data-sub="一行の説明">
//   <div class="rf-stage-wrap"><div class="rf-stage" data-w="1600" data-h="900">
//     <div class="rf-layer rf-before"><img src="foundation/current/combat.jpg" alt="現行"></div>
//     <div class="rf-layer rf-after">
//       <canvas class="rf-scene" data-scene="combat"></canvas>   … combat | map | plain
//       … 改修案の DOM(設計寸法 data-w × data-h の座標で absolute 配置) …
//       <div data-note="1">…</div>   … 注記ピンを付けたい要素
//     </div>
//   </div></div>
//   <ol class="rf-notes"><li data-n="1">…</li></ol>
//
// 提供するもの: ツールバー(現行/改修案/比較・配色・注記)、ステージの縮尺合わせ、比較のワイプ、
// 注記ピン、背景の宇宙の描画、配色プリセットの適用。
(function () {
  const store = {
    get(k) { try { return localStorage.getItem('tepui-ref:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('tepui-ref:' + k, v); } catch { /* 保存できない環境では毎回既定から */ } },
  };

  // --- 配色 -----------------------------------------------------------------------------------
  const themes = window.TEPUI_THEMES ?? [];
  function applyTheme(id) {
    const theme = themes.find((t) => t.id === id) ?? themes.find((t) => t.id === window.TEPUI_DEFAULT_THEME) ?? themes[0];
    if (!theme) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.tone;
    root.dataset.theme = theme.id;
    store.set('theme', theme.id);
    document.querySelectorAll('.rf-scene').forEach(drawScene);
  }

  // --- ツールバー -------------------------------------------------------------------------------
  function buildBar() {
    const body = document.body;
    const bar = document.createElement('header');
    bar.className = 'rf-bar';
    const hasStage = Boolean(document.querySelector('.rf-stage'));
    const isIndex = body.dataset.index === 'true';
    bar.innerHTML = `
      <div class="rf-bar-title"><b></b><span></span></div>
      <div class="rf-bar-tools">
        ${hasStage ? `<div class="w-group" role="group" aria-label="表示">
          <span class="w-btn w-btn--dense" data-mode="before">現行</span>
          <span class="w-btn w-btn--dense" data-mode="after">改修案</span>
          <span class="w-btn w-btn--dense" data-mode="compare">比較</span></div>` : ''}
        <label>配色 <select class="w-select" data-role="theme"></select></label>
        ${hasStage ? '<label><input type="checkbox" data-role="notes" checked> 注記</label>' : ''}
        ${isIndex ? '' : '<a href="index.html">一覧へ</a>'}
      </div>`;
    bar.querySelector('b').textContent = body.dataset.title ?? document.title;
    bar.querySelector('.rf-bar-title span').textContent = body.dataset.sub ?? '';
    const select = bar.querySelector('[data-role="theme"]');
    for (const t of themes) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name}${t.id === window.TEPUI_DEFAULT_THEME ? '(既定)' : ''}`;
      select.appendChild(opt);
    }
    select.value = store.get('theme') ?? window.TEPUI_DEFAULT_THEME;
    select.addEventListener('change', () => applyTheme(select.value));
    const modeButtons = [...bar.querySelectorAll('[data-mode]')];
    const setMode = (mode) => {
      document.querySelectorAll('.rf-stage').forEach((s) => { s.dataset.mode = mode; });
      modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      store.set('mode', mode);
      requestAnimationFrame(placePins);
    };
    modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    const notes = bar.querySelector('[data-role="notes"]');
    notes?.addEventListener('change', () => body.classList.toggle('rf-notes-off', !notes.checked));
    body.prepend(bar);
    if (hasStage) setMode(store.get('mode') ?? 'after');
  }

  // --- ステージの縮尺 ---------------------------------------------------------------------------
  function fitStages() {
    document.querySelectorAll('.rf-stage').forEach((stage) => {
      const w = Number(stage.dataset.w || 1600);
      const h = Number(stage.dataset.h || 900);
      const wrap = stage.parentElement;
      const scale = Math.min(1, wrap.clientWidth / w);
      stage.style.width = `${w}px`;
      stage.style.height = `${h}px`;
      stage.style.transform = `scale(${scale})`;
      wrap.style.height = `${h * scale}px`;
      stage.dataset.scale = String(scale);
    });
    placePins();
  }

  // --- 比較のワイプ -----------------------------------------------------------------------------
  function buildWipes() {
    document.querySelectorAll('.rf-stage').forEach((stage) => {
      const wipe = document.createElement('div');
      wipe.className = 'rf-wipe';
      wipe.innerHTML = '<span class="rf-wipe-label l">現行</span><span class="rf-wipe-label r">改修案</span><div class="rf-wipe-handle" aria-label="比較の境目">⇔</div>';
      stage.appendChild(wipe);
      const handle = wipe.querySelector('.rf-wipe-handle');
      const move = (clientX) => {
        const rect = stage.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        stage.style.setProperty('--wipe', `${pct}%`);
      };
      handle.addEventListener('pointerdown', (e) => {
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev) => move(ev.clientX);
        const onUp = () => { handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    });
  }

  // --- 注記ピン ---------------------------------------------------------------------------------
  function placePins() {
    document.querySelectorAll('.rf-stage').forEach((stage) => {
      stage.querySelectorAll('.rf-pin').forEach((p) => p.remove());
      const scale = Number(stage.dataset.scale || 1);
      const origin = stage.getBoundingClientRect();
      stage.querySelectorAll('[data-note]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const pin = document.createElement('span');
        pin.className = 'rf-pin';
        pin.textContent = el.dataset.note;
        pin.style.left = `${(r.left - origin.left) / scale}px`;
        pin.style.top = `${(r.top - origin.top) / scale}px`;
        stage.appendChild(pin);
      });
    });
  }

  // --- 背景の宇宙 -------------------------------------------------------------------------------
  // 改修案の側にだけ描く。現行のスクリーンショットと同じ構図(地球の縁・星・中央の自機)を
  // 簡略に再現し、HUD の見え方を比べられるようにする。
  function seeded(seed) {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }
  function drawScene(canvas) {
    const stage = canvas.closest('.rf-stage');
    const w = Number(stage?.dataset.w || canvas.clientWidth || 1600);
    const h = Number(stage?.dataset.h || canvas.clientHeight || 900);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const kind = canvas.dataset.scene || 'plain';
    const rand = seeded(42);
    ctx.fillStyle = '#020306';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < (w * h) / 2600; i++) {
      ctx.globalAlpha = 0.25 + rand() * 0.6;
      ctx.fillStyle = '#dfe8ff';
      ctx.fillRect(rand() * w, rand() * h, rand() < 0.1 ? 1.6 : 1, rand() < 0.1 ? 1.6 : 1);
    }
    ctx.globalAlpha = 1;
    if (kind === 'combat') {
      // 下方の地球の縁と大気の光
      const cx = w / 2, cy = h * 2.05, r = h * 1.42;
      const g = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.03);
      g.addColorStop(0, '#1b1206');
      g.addColorStop(0.92, '#2a1a0a');
      g.addColorStop(0.965, '#3d5a7a');
      g.addColorStop(1, 'rgba(60,110,180,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.03, 0, Math.PI * 2); ctx.fill();
      // 中央の自機(簡略なシルエット)
      ctx.save();
      ctx.translate(w / 2, h * 0.47);
      ctx.fillStyle = '#16181e';
      ctx.fillRect(-260, -6, 520, 3);
      const hull = ctx.createRadialGradient(-30, 20, 10, 0, 50, 86);
      hull.addColorStop(0, '#24272f');
      hull.addColorStop(1, '#0f1116');
      ctx.fillStyle = hull;
      ctx.beginPath(); ctx.arc(0, 50, 86, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1c1f26';
      ctx.fillRect(-22, -36, 44, 60);
      ctx.restore();
    } else if (kind === 'map') {
      const cx = w / 2, cy = h * 0.42, r = h * 0.17;
      const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#5b7da6');
      g.addColorStop(0.6, '#2b405e');
      g.addColorStop(1, '#0b1220');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,255,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.02, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,210,230,.18)';
      ctx.beginPath(); ctx.ellipse(cx, cy * 2.6, w * 0.62, cy * 2.05, 0, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    }
  }

  // --- 起動 -------------------------------------------------------------------------------------
  applyTheme(store.get('theme') ?? window.TEPUI_DEFAULT_THEME);
  buildBar();
  buildWipes();
  document.querySelectorAll('.rf-scene').forEach(drawScene);
  fitStages();
  addEventListener('resize', fitStages);
  document.fonts?.ready.then(placePins);
  window.TepuiRef = { placePins, drawScene, applyTheme };
})();
