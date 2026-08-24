// [H] で開閉する操作説明パネル。キー定義は input/key-mapping.ts を参照し、
// キーボード図・検索結果・操作一覧で同じ code/label を使う。
import * as C from '../../const';
import type { Input } from '../../input/input';
import { KEY_MAPPING as K, type KeyBinding } from '../../input/key-mapping';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';

type HelpMode = 'combat' | 'map';
type HelpInput = 'keyboard' | 'mouse' | 'touch';
type HelpCategory = 'basic' | 'combat' | 'camera' | 'time' | 'map' | 'ui' | 'gesture';
type HelpScope = HelpMode | 'both';
type HelpBehavior = 'press' | 'hold' | 'toggle' | 'drag' | 'gesture';

interface HelpEntry {
  readonly id: string;
  readonly category: HelpCategory;
  readonly label: string;
  readonly description: string;
  readonly keys?: readonly KeyBinding[];
  readonly inputs: readonly HelpInput[];
  readonly scope: HelpScope;
  readonly behavior?: HelpBehavior;
  readonly example?: string;
}

interface KeyboardKeyDefinition {
  readonly code: string;
  readonly label: string;
  readonly className?: string;
}

const HELP_CATEGORIES: readonly { id: HelpCategory; label: string; glyph: string }[] = [
  { id: 'basic', label: '基本操作', glyph: '◆' },
  { id: 'combat', label: '戦闘・機体', glyph: '◎' },
  { id: 'camera', label: 'カメラ', glyph: '◇' },
  { id: 'time', label: '時間操作', glyph: '◷' },
  { id: 'map', label: '軌道計画', glyph: '⌁' },
  { id: 'ui', label: '画面・メニュー', glyph: '□' },
  { id: 'gesture', label: 'マウス・タッチ', glyph: '✦' },
];

// 説明文はここで管理し、キー名・キーコードは必ず KEY_MAPPING の値から取る。
// scope が both でない項目は、戦闘/マップの現在モードに応じて一覧と図から切り替える。
const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: 'translation', category: 'basic', label: '機体の並進',
    description: '前 / 後 / 左 / 右 / 上 / 下へ推進する。キーを押している間だけ出力する。',
    keys: [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown],
    inputs: ['keyboard'], scope: 'combat', behavior: 'hold', example: 'W/S = 前後、A/D = 左右、Q/E = 上下',
  },
  {
    id: 'attitude', category: 'basic', label: '機体の姿勢変更',
    description: 'ピッチ / ヨー / ロールを RCS で操作する。',
    keys: [K.pitchDown, K.pitchUp, K.yawRight, K.yawLeft, K.rollLeft, K.rollRight],
    inputs: ['keyboard'], scope: 'combat', behavior: 'hold', example: 'I/K = ピッチ、J/L = ヨー、U/O = ロール',
  },
  {
    id: 'rcs-damp', category: 'combat', label: 'RCS 回転制動',
    description: '回転速度を自動的に抑える機能を ON/OFF する。',
    keys: [K.rcsDampToggle], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
  },
  {
    id: 'prograde-reset', category: 'combat', label: 'プログレード姿勢リセット',
    description: '機首を進行方向へ即座に向ける。',
    keys: [K.progradeReset], inputs: ['keyboard'], scope: 'combat', behavior: 'press',
  },
  {
    id: 'throttle', category: 'combat', label: '並進出力レベル',
    description: `並進 6 方向に共通する出力を切り替える (${C.THROTTLE_LABELS.join(' / ')})。`,
    keys: [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax],
    inputs: ['keyboard'], scope: 'combat', behavior: 'press', example: '1 = 低出力、4 = 最大出力',
  },
  {
    id: 'fine-attitude', category: 'combat', label: '姿勢微調整モード',
    description: '角加速度・角速度を絞り、小刻みに姿勢を調整する。',
    keys: [K.fineAttitudeToggle], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
  },
  {
    id: 'prograde-hold', category: 'combat', label: '進行方向ホールド',
    description: '機首をプログレード方向へ自動で向け続ける。手動回転で解除する。',
    keys: [K.progradeHoldToggle], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
  },
  {
    id: 'radiators', category: 'combat', label: 'ラジエーター展開 / 収納',
    description: '左右のラジエーターを個別に切り替える。',
    keys: [K.radiatorDeployLeft, K.radiatorDeployRight], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
    example: '9 = 左、0 = 右',
  },
  {
    id: 'solar-panels', category: 'combat', label: '太陽電池パドル展開 / 収納',
    description: '左右の太陽電池パドルを個別に切り替える。',
    keys: [K.solarDeployLeft, K.solarDeployRight], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
    example: '7 = 左、8 = 右',
  },
  {
    id: 'target', category: 'combat', label: 'ターゲット選択',
    description: '照準に近い敵を選択する。短時間の連打で第二ターゲットを順送りする。',
    keys: [K.targetSelect], inputs: ['keyboard', 'mouse'], scope: 'combat', behavior: 'press',
  },
  {
    id: 'gunsight', category: 'camera', label: '照準ズーム',
    description: '機首方向を画面中心に拡大表示する。自機は非表示になる。',
    keys: [K.gunsightZoom], inputs: ['keyboard'], scope: 'combat', behavior: 'hold',
  },
  {
    id: 'follow-attitude', category: 'camera', label: '視点の RCS 追従',
    description: '視点を機体姿勢に追従させる。OFF にすると軌道基準の独立視点になる。',
    keys: [K.followAttitudeToggle], inputs: ['keyboard'], scope: 'combat', behavior: 'toggle',
  },
  {
    id: 'fire', category: 'combat', label: '機関砲発射',
    description: `機関砲を発射する。ワープ ×${C.MAX_PHYS_SIM_SPEED} 以下で操作できる。`,
    keys: [K.fire], inputs: ['keyboard', 'mouse'], scope: 'combat', behavior: 'hold',
  },
  {
    id: 'reload', category: 'combat', label: 'マニュアル装填',
    description: '残弾のあるマガジンを捨てて、新しいマガジンを装填する。',
    keys: [K.reload], inputs: ['keyboard'], scope: 'combat', behavior: 'press',
  },
  {
    id: 'camera-rotate', category: 'camera', label: '視点回転',
    description: 'マウスの左ドラッグ、または矢印キーで視点を回転する。',
    keys: [K.cameraYawLeft, K.cameraYawRight, K.cameraPitchUp, K.cameraPitchDown],
    inputs: ['keyboard', 'mouse', 'touch'], scope: 'both', behavior: 'drag', example: '←/→ = ヨー、↑/↓ = ピッチ',
  },
  {
    id: 'camera-roll', category: 'camera', label: '視点ロール',
    description: '視点を左右にロールする。日本語キーボードでは Num0 / Num1 または / / _ を使う。',
    keys: [K.cameraRollLeft, K.cameraRollRight], inputs: ['keyboard', 'touch'], scope: 'both', behavior: 'hold',
  },
  {
    id: 'camera-pan', category: 'camera', label: '視点パン',
    description: 'カメラを画面平面に沿って移動する。中ボタンドラッグ相当。',
    keys: [K.cameraPanUp, K.cameraPanDown, K.cameraPanLeft, K.cameraPanRight],
    inputs: ['keyboard', 'mouse', 'touch'], scope: 'both', behavior: 'drag',
  },
  {
    id: 'camera-zoom', category: 'camera', label: '距離ズーム',
    description: 'マウスホイールまたはピンチでカメラ距離を変更する。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'warp', category: 'time', label: '時間加速',
    description: '時間加速の段階を増減する。',
    keys: [K.warpSlower, K.warpFaster], inputs: ['keyboard'], scope: 'both', behavior: 'press', example: ', = 減速、. = 加速',
  },
  {
    id: 'auto-warp', category: 'time', label: 'ノードまで自動ワープ',
    description: '直近のマニューバノードまで時間を自動加速し、実行点の直前で解除する。',
    keys: [K.autoWarpToNode], inputs: ['keyboard'], scope: 'both', behavior: 'toggle',
  },
  {
    id: 'toggle-map', category: 'map', label: '軌道計画モード',
    description: '戦闘ビューとマップモードを切り替える。時間は進み続けるのでワープも使える。',
    keys: [K.toggleMapMode], inputs: ['keyboard'], scope: 'both', behavior: 'toggle', example: 'M → 軌道をクリック → ノードを編集 → M で確定',
  },
  {
    id: 'map-translation', category: 'map', label: 'ノードの Δv 編集',
    description: '選択中ノードの Δv を機体基準の 6 方向で調整する。通常ビューの移動キーとは意味が変わる。',
    keys: [K.dvPrograde, K.dvRetrograde, K.dvNormal, K.dvAntinormal, K.dvRadialOut, K.dvRadialIn],
    inputs: ['keyboard'], scope: 'map', behavior: 'hold', example: 'W/S = PRO/RET、A/D = NRM/ANM、E/Q = OUT/IN',
  },
  {
    id: 'delete-node', category: 'map', label: 'ノードを削除',
    description: 'マップモードでは選択中のノードを削除する。戦闘ビューでは計画全体を破棄する。',
    keys: [K.deleteNode], inputs: ['keyboard'], scope: 'both', behavior: 'press',
  },
  {
    id: 'node-place', category: 'map', label: 'ノードを配置',
    description: '計画軌道をクリックしてノードを配置する。ノードの丸ハンドルをドラッグすると軌道上の時刻を移動する。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'drag',
  },
  {
    id: 'node-manual-time', category: 'map', label: 'ノード位置の手動入力',
    description: '選択中ノードの ΔT [s] に現在時刻からの秒数を入力して位置を指定する。',
    inputs: ['keyboard', 'mouse', 'touch'], scope: 'map', behavior: 'press',
  },
  {
    id: 'node-dv-handle', category: 'map', label: 'Δv 矢印ハンドル',
    description: 'ノード周囲の PRO/RET・NRM/ANM・OUT/IN ハンドルをドラッグして Δv 成分を調整する。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'drag',
  },
  {
    id: 'map-panels', category: 'map', label: 'マップの各パネル',
    description: 'PREDICT で期間と未来位置、TRAJECTORY で計画軌道の描画座標系、表示パネルで天体・機体・星空・各種グリッドを切り替える。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'press',
  },
  {
    id: 'map-frame', category: 'map', label: 'カメラ / 軌道フレーム',
    description: 'カメラの注視対象・回転系と、計画軌道の描画基準を独立して設定する。画角、透視/平行投影、黄道面・赤道面・月軌道面の視点も選べる。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'press',
  },
  {
    id: 'coordinate-frame', category: 'map', label: '慣性系 / 太陽回転系',
    description: '計画軌道とカメラの座標系は独立して選べる。太陽回転系では太陽方向が画面上でほぼ固定され、遷移計画の目安になる。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'press',
  },
  {
    id: 'context-menu', category: 'map', label: 'コンテキストメニュー',
    description: 'ノード近傍で右クリックすると、この時刻までの自動ワープ・ノード削除・キャンセルを選べる。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'press',
  },
  {
    id: 'orbit-markers', category: 'map', label: 'AN / DN マーカー',
    description: '自機軌道とターゲット軌道面の交点。面変更（ノーマル / アンチノーマル burn）の目安位置。',
    inputs: ['mouse', 'touch'], scope: 'map', behavior: 'gesture',
  },
  {
    id: 'boardpass-marker', category: 'map', label: '✦ ボードパスマーカー',
    description: 'ターゲット位置へ向けた仮想標的面を弾が通過した点。次弾の照準修正の目安になる。',
    inputs: ['mouse', 'touch'], scope: 'combat', behavior: 'gesture',
  },
  {
    id: 'direction-markers', category: 'map', label: '軌道方向マーカー',
    description: '軌道基準の PRO/RET・NRM/ANM・OUT/IN を示す。機首をマーカーへ向けると、その方向へ並進できる。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'node-burn-marker', category: 'map', label: 'NODE / BURN マーカー',
    description: '直近のマニューバ実行点と噴射ガイド。BURN の方向へ加速し、計画軌道へ十分近づくと次のノードへ進む。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'target-orbit', category: 'combat', label: 'オレンジの軌道線',
    description: 'ターゲットの軌道。自機軌道とほぼ重なる場合は上に重ねて描画する。',
    inputs: ['mouse', 'touch'], scope: 'combat', behavior: 'gesture',
  },
  {
    id: 'ammo', category: 'combat', label: '弾薬 / AMMO',
    description: `${C.MAG_ROUNDS} 発でマガジン 1 連を消費する。残弾が少なくなると軌道上へ補給が投入されるので、AMMO マーカーへ接近して回収する。`,
    inputs: ['mouse', 'touch'], scope: 'combat', behavior: 'gesture',
  },
  {
    id: 'right-click', category: 'gesture', label: '右クリック / 長押し',
    description: 'プロパティ・空域・ノードメニューを開く。敵の右クリックはターゲットの固定 / 解除、射撃にも使える。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'middle-pan', category: 'gesture', label: '中ボタンドラッグ / 二本指ドラッグ',
    description: 'カメラをパンする。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'drag',
  },
  {
    id: 'double-focus', category: 'gesture', label: 'ダブルクリック / ダブルタップ',
    description: '対象へフォーカスを移す。',
    inputs: ['mouse', 'touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'touch-pinch', category: 'gesture', label: 'ピンチ',
    description: 'カメラをズームする。二本指を回すと視点ロールも入力できる。',
    inputs: ['touch'], scope: 'both', behavior: 'gesture',
  },
  {
    id: 'help', category: 'ui', label: 'このヘルプ',
    description: '操作説明を開閉する。ヘルプ内では H / ESC でも閉じられる。',
    keys: [K.help], inputs: ['keyboard'], scope: 'both', behavior: 'toggle',
  },
  {
    id: 'pause', category: 'ui', label: '一時停止メニュー',
    description: '設定、セーブ、負荷表示、タイトルへ戻る操作を開く。',
    keys: [K.pauseMenu], inputs: ['keyboard'], scope: 'both', behavior: 'press',
  },
  {
    id: 'debug-tools', category: 'ui', label: 'デバッグ・スナップショット',
    description: '負荷表示、スナップショット取得、スナップショット一覧を開く。',
    keys: [K.togglePerfWindow, K.clipSnapshot, K.openSnapshots], inputs: ['keyboard'], scope: 'both', behavior: 'press',
    example: 'F3 = 負荷、F5 = 取得、F9 = 一覧',
  },
  {
    id: 'restart', category: 'ui', label: '決着後の再出撃',
    description: '決着画面で同じステージへ再出撃する。',
    keys: [K.restart], inputs: ['keyboard'], scope: 'both', behavior: 'press',
  },
];

const KEYBOARD_ROWS: readonly KeyboardKeyDefinition[][] = [
  [
    { code: 'Escape', label: 'ESC', className: 'wide' },
    { code: 'F1', label: 'F1' }, { code: 'F2', label: 'F2' }, { code: 'F3', label: 'F3' },
    { code: 'F4', label: 'F4' }, { code: 'F5', label: 'F5' }, { code: 'F6', label: 'F6' },
    { code: 'F7', label: 'F7' }, { code: 'F8', label: 'F8' }, { code: 'F9', label: 'F9' },
    { code: 'F10', label: 'F10' }, { code: 'F11', label: 'F11' }, { code: 'F12', label: 'F12' },
  ],
  [
    { code: 'Backquote', label: '半角' }, { code: 'Digit1', label: '1' }, { code: 'Digit2', label: '2' },
    { code: 'Digit3', label: '3' }, { code: 'Digit4', label: '4' }, { code: 'Digit5', label: '5' },
    { code: 'Digit6', label: '6' }, { code: 'Digit7', label: '7' }, { code: 'Digit8', label: '8' },
    { code: 'Digit9', label: '9' }, { code: 'Digit0', label: '0' }, { code: 'Minus', label: '-' },
    { code: 'Equal', label: '^' }, { code: 'Backspace', label: 'BS', className: 'wide' },
  ],
  [
    { code: 'Tab', label: 'TAB', className: 'wide' }, { code: 'KeyQ', label: 'Q' }, { code: 'KeyW', label: 'W' },
    { code: 'KeyE', label: 'E' }, { code: 'KeyR', label: 'R' }, { code: 'KeyT', label: 'T' },
    { code: 'KeyY', label: 'Y' }, { code: 'KeyU', label: 'U' }, { code: 'KeyI', label: 'I' },
    { code: 'KeyO', label: 'O' }, { code: 'KeyP', label: 'P' }, { code: 'BracketLeft', label: '@' },
    { code: 'BracketRight', label: '[' }, { code: 'Backslash', label: ']' },
  ],
  [
    { code: 'CapsLock', label: 'CAPS', className: 'wide' }, { code: 'KeyA', label: 'A' }, { code: 'KeyS', label: 'S' },
    { code: 'KeyD', label: 'D' }, { code: 'KeyF', label: 'F' }, { code: 'KeyG', label: 'G' },
    { code: 'KeyH', label: 'H' }, { code: 'KeyJ', label: 'J' }, { code: 'KeyK', label: 'K' },
    { code: 'KeyL', label: 'L' }, { code: 'Semicolon', label: ';' }, { code: 'Quote', label: ':' },
    { code: 'Enter', label: 'ENTER', className: 'wide' },
  ],
  [
    { code: 'ShiftLeft', label: 'SHIFT', className: 'xwide' }, { code: 'KeyZ', label: 'Z' }, { code: 'KeyX', label: 'X' },
    { code: 'KeyC', label: 'C' }, { code: 'KeyV', label: 'V' }, { code: 'KeyB', label: 'B' },
    { code: 'KeyN', label: 'N' }, { code: 'KeyM', label: 'M' }, { code: 'Comma', label: ',' },
    { code: 'Period', label: '.' }, { code: 'Slash', label: '/' }, { code: 'ShiftRight', label: 'SHIFT', className: 'xwide' },
  ],
  [
    { code: 'ControlLeft', label: 'CTRL', className: 'wide' }, { code: 'MetaLeft', label: '⌘', className: 'wide' },
    { code: 'AltLeft', label: 'ALT', className: 'wide' }, { code: 'Space', label: 'SPACE', className: 'space' },
    { code: 'AltRight', label: 'ALT', className: 'wide' }, { code: 'MetaRight', label: '⌘', className: 'wide' },
    { code: 'ControlRight', label: 'CTRL', className: 'wide' },
  ],
];

const ARROW_KEYS: readonly KeyboardKeyDefinition[] = [
  { code: 'ArrowUp', label: '↑' }, { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' },
];

const AUXILIARY_KEYS: readonly KeyboardKeyDefinition[] = [
  { code: 'Numpad0', label: 'Num0' }, { code: 'Numpad1', label: 'Num1' }, { code: 'IntlRo', label: '_' },
];

const BEHAVIOR_LABELS: Readonly<Record<HelpBehavior, string>> = {
  press: '押す', hold: '押している間', toggle: 'ON / OFF', drag: 'ドラッグ', gesture: 'ジェスチャ',
};

const INPUT_LABELS: Readonly<Record<HelpInput, string>> = {
  keyboard: 'KEYBOARD', mouse: 'MOUSE', touch: 'TOUCH',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function entryCodes(entry: HelpEntry): string[] {
  const codes: string[] = [];
  for (const key of entry.keys ?? []) codes.push(key.code, ...(key.altCodes ?? []));
  return [...new Set(codes)];
}

function entryMatchesCode(entry: HelpEntry, code: string): boolean {
  return entryCodes(entry).includes(code);
}

function scopeMatches(entry: HelpEntry, mode: HelpMode): boolean {
  return entry.scope === 'both' || entry.scope === mode;
}

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly body: HTMLElement;
  private readonly keyboardSection: HTMLElement;
  private readonly keyboard: HTMLElement;
  private readonly quickstart: HTMLElement;
  private readonly content: HTMLElement;
  private readonly liveStatus: HTMLElement;
  private _isOpen = false;
  private mode: HelpMode = 'combat';
  private inputFilter: HelpInput | 'all' = 'all';
  private categoryFilter: HelpCategory | 'all' = 'all';
  private selectedCode: string | null = null;
  private selectedEntryId: string | null = null;
  private previousFocus: HTMLElement | null = null;

  constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    this.el = document.createElement('div');
    this.el.id = 'hud-help';
    this.el.className = 'panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'hud-help-title');
    this.el.innerHTML = `
      <div class="help-header">
        <div>
          <h3 id="hud-help-title">操作説明 <span class="help-close-hint">[H / ESC で閉じる]</span></h3>
          <div class="help-mode-status" data-help-mode-status></div>
        </div>
        <button type="button" class="help-close-button" data-help-action="close" aria-label="操作説明を閉じる">×</button>
      </div>
      <div class="help-toolbar">
        <div class="help-toolbar-row">
          <div class="help-tab-group" role="tablist" aria-label="表示モード">
            <span class="help-toolbar-label">表示対象</span>
            <button type="button" class="help-tab" role="tab" data-help-mode="combat">戦闘ビュー</button>
            <button type="button" class="help-tab" role="tab" data-help-mode="map">マップモード</button>
          </div>
          <label class="help-search">
            <span class="help-visually-hidden">操作を検索</span>
            <span aria-hidden="true">⌕</span>
            <input class="w-input" type="search" placeholder="操作名・キー・説明を検索" autocomplete="off" />
          </label>
        </div>
        <div class="help-toolbar-row help-input-tabs" role="tablist" aria-label="入力方式">
          <span class="help-toolbar-label">入力方式</span>
          <button type="button" class="help-tab" role="tab" data-help-input="all">すべて</button>
          <button type="button" class="help-tab" role="tab" data-help-input="keyboard">キーボード</button>
          <button type="button" class="help-tab" role="tab" data-help-input="mouse">マウス</button>
          <button type="button" class="help-tab" role="tab" data-help-input="touch">タッチ</button>
        </div>
        <div class="help-category-tabs" role="tablist" aria-label="操作カテゴリ">
          <button type="button" class="help-tab" role="tab" data-help-category="all">すべて</button>
          ${HELP_CATEGORIES.map((category) => `<button type="button" class="help-tab" role="tab" data-help-category="${category.id}">${category.glyph} ${category.label}</button>`).join('')}
        </div>
      </div>
      <div class="help-body">
        <section class="help-quickstart" data-help-quickstart aria-labelledby="hud-help-quickstart-title"></section>
        <section class="help-keyboard-section" data-help-keyboard-section aria-labelledby="hud-help-keyboard-title">
          <div class="help-section-heading">
            <h4 id="hud-help-keyboard-title">キーボード</h4>
            <span>色だけでなく、キー上のカテゴリ記号でも判別できます</span>
          </div>
          <div class="help-legend" data-help-legend></div>
          <div class="help-keyboard" data-help-keyboard></div>
          <div class="help-keyboard-aux" data-help-keyboard-aux></div>
        </section>
        <div class="help-content" data-help-content></div>
        <div class="help-no-results" data-help-no-results hidden>該当する操作がありません。検索語やカテゴリを変更してください。</div>
      </div>
      <div class="help-live-status help-visually-hidden" aria-live="polite" data-help-live-status></div>
    `;
    root.appendChild(this.el);

    this.searchInput = this.el.querySelector<HTMLInputElement>('.help-search input')!;
    this.body = this.el.querySelector<HTMLElement>('.help-body')!;
    this.keyboardSection = this.el.querySelector<HTMLElement>('[data-help-keyboard-section]')!;
    this.keyboard = this.el.querySelector<HTMLElement>('[data-help-keyboard]')!;
    this.quickstart = this.el.querySelector<HTMLElement>('[data-help-quickstart]')!;
    this.content = this.el.querySelector<HTMLElement>('[data-help-content]')!;
    this.liveStatus = this.el.querySelector<HTMLElement>('[data-help-live-status]')!;
    this.el.addEventListener('click', this.handleClick);
    this.searchInput.addEventListener('input', this.handleSearchInput);
    this.render();
  }

  get isOpen(): boolean { return this._isOpen; }

  // ビュー切り替え時はヘルプの既定表示も同期する。タブから手動で選んだ場合でも、
  // 次にビューを切り替えた時点で現在の操作へ戻るため、常に迷子にならない。
  setWorldView(view: HelpMode): void {
    if (this.mode === view) return;
    this.mode = view;
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
  }

  handleInput(input: Input): void {
    if (!input.takeKey(K.help)) return;
    // 検索欄へ文字を入力している最中の H は、ヘルプの開閉に使わない。
    if (document.activeElement === this.searchInput) return;
    this.toggle();
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
    this.el.style.display = 'block';
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
    window.addEventListener('keydown', this.handleWindowKeyDown);
    requestAnimationFrame(() => {
      if (this._isOpen) this.searchInput.focus({ preventScroll: true });
    });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    window.removeEventListener('keydown', this.handleWindowKeyDown);
    this.overlayManager.close('help');
    this.previousFocus?.focus({ preventScroll: true });
    this.previousFocus = null;
  }

  contains(target: Node): boolean {
    return this.el.contains(target);
  }

  private toggle(): void {
    if (this._isOpen) this.close();
    else this.open();
  }

  private readonly handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this._isOpen || event.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    if (event.code === K.help.code || event.code === K.pauseMenu.code) return;
    this.selectCode(event.code, false);
  };

  private readonly handleSearchInput = (): void => {
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-help-action], [data-help-code], [data-help-entry], [data-help-mode], [data-help-input], [data-help-category]') : null;
    if (!target || !this.el.contains(target)) return;
    const action = target.dataset['helpAction'];
    if (action === 'close') {
      this.close();
      return;
    }
    const mode = target.dataset['helpMode'] as HelpMode | undefined;
    if (mode) {
      this.mode = mode;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    const inputFilter = target.dataset['helpInput'] as HelpInput | 'all' | undefined;
    if (inputFilter) {
      this.inputFilter = inputFilter;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    const category = target.dataset['helpCategory'] as HelpCategory | 'all' | undefined;
    if (category) {
      this.categoryFilter = category;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    const code = target.dataset['helpCode'];
    if (code) {
      this.selectCode(code);
      return;
    }
    const entryId = target.dataset['helpEntry'];
    if (entryId) this.selectEntry(entryId);
  };

  private filteredEntries(): HelpEntry[] {
    const query = normalize(this.searchInput.value);
    return HELP_ENTRIES.filter((entry) => {
      if (!scopeMatches(entry, this.mode)) return false;
      if (this.categoryFilter !== 'all' && entry.category !== this.categoryFilter) return false;
      if (this.inputFilter !== 'all' && !entry.inputs.includes(this.inputFilter)) return false;
      if (!query) return true;
      const values = [
        entry.label, entry.description, entry.example ?? '', entry.category,
        ...(entry.keys ?? []).flatMap((key) => [key.label, key.altLabel ?? '', key.code, ...(key.altCodes ?? [])]),
      ];
      return normalize(values.join(' ')).includes(query);
    });
  }

  private activeKeyboardEntries(): HelpEntry[] {
    return HELP_ENTRIES.filter((entry) => scopeMatches(entry, this.mode) && entry.inputs.includes('keyboard') && Boolean(entry.keys?.length));
  }

  private render(): void {
    this.syncToolbar();
    const visibleEntries = this.filteredEntries();
    this.quickstart.innerHTML = this.renderQuickstart();
    this.keyboardSection.hidden = this.inputFilter === 'mouse' || this.inputFilter === 'touch';
    this.keyboard.innerHTML = this.renderKeyboard();
    this.el.querySelector<HTMLElement>('[data-help-keyboard-aux]')!.innerHTML = this.renderAuxiliaryKeys();
    this.el.querySelector<HTMLElement>('[data-help-legend]')!.innerHTML = this.renderLegend();
    this.content.innerHTML = this.renderEntryGroups(visibleEntries);
    const noResults = this.el.querySelector<HTMLElement>('[data-help-no-results]')!;
    noResults.hidden = visibleEntries.length > 0;
    this.body.classList.toggle('has-no-results', visibleEntries.length === 0);
    this.applySelection();
  }

  private syncToolbar(): void {
    const modeStatus = this.el.querySelector<HTMLElement>('[data-help-mode-status]')!;
    modeStatus.textContent = `現在の表示: ${this.mode === 'combat' ? '戦闘ビュー' : 'マップモード'} — 共通操作も表示中`;
    this.el.querySelectorAll<HTMLElement>('[data-help-mode]').forEach((button) => {
      const selected = button.dataset['helpMode'] === this.mode;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    this.el.querySelectorAll<HTMLElement>('[data-help-input]').forEach((button) => {
      const selected = button.dataset['helpInput'] === this.inputFilter;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    this.el.querySelectorAll<HTMLElement>('[data-help-category]').forEach((button) => {
      const selected = button.dataset['helpCategory'] === this.categoryFilter;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    });
  }

  private renderQuickstart(): string {
    const isMap = this.mode === 'map';
    return `
      <div class="help-section-heading">
        <h4 id="hud-help-quickstart-title">まず覚える操作</h4>
        <span>${isMap ? 'マップモードの流れ' : '戦闘ビューの基本'}</span>
      </div>
      <div class="help-quickstart-grid">
        ${isMap ? `
          <div class="help-recipe"><span class="help-recipe-number">01</span><span><kbd>M</kbd> でマップモード</span></div>
          <div class="help-recipe"><span class="help-recipe-number">02</span><span>軌道をクリックしてノード配置</span></div>
          <div class="help-recipe"><span class="help-recipe-number">03</span><span><kbd>W/S</kbd> などで Δv 調整</span></div>
          <div class="help-recipe"><span class="help-recipe-number">04</span><span><kbd>M</kbd> で確定、<kbd>N</kbd> で接近</span></div>
        ` : `
          <div class="help-recipe"><span class="help-recipe-number">01</span><span><kbd>WASDQE</kbd> で移動</span></div>
          <div class="help-recipe"><span class="help-recipe-number">02</span><span><kbd>IJKLUO</kbd> で姿勢変更</span></div>
          <div class="help-recipe"><span class="help-recipe-number">03</span><span><kbd>T</kbd> で敵を選択、<kbd>SPACE</kbd> で射撃</span></div>
          <div class="help-recipe"><span class="help-recipe-number">04</span><span><kbd>H</kbd> でこの説明を開く</span></div>
        `}
      </div>`;
  }

  private renderLegend(): string {
    return HELP_CATEGORIES.map((category) => `<span class="help-legend-item cat-${category.id}"><i aria-hidden="true">${category.glyph}</i>${category.label}</span>`).join('');
  }

  private renderKeyboard(): string {
    const entries = this.activeKeyboardEntries();
    const query = normalize(this.searchInput.value);
    const matchingEntries = this.filteredEntries();
    const dimUnmatched = Boolean(query) || this.categoryFilter !== 'all';
    const entryMap = new Map<string, HelpEntry[]>();
    for (const entry of entries) {
      for (const code of entryCodes(entry)) entryMap.set(code, [...(entryMap.get(code) ?? []), entry]);
    }
    return KEYBOARD_ROWS.map((row) => `<div class="help-keyboard-row">${row.map((key) => this.renderKeyboardKey(key, entryMap, dimUnmatched, matchingEntries)).join('')}</div>`).join('');
  }

  private renderAuxiliaryKeys(): string {
    const entries = this.activeKeyboardEntries();
    const entryMap = new Map<string, HelpEntry[]>();
    for (const entry of entries) {
      for (const code of entryCodes(entry)) entryMap.set(code, [...(entryMap.get(code) ?? []), entry]);
    }
    const dimUnmatched = Boolean(normalize(this.searchInput.value)) || this.categoryFilter !== 'all';
    return `<span class="help-keyboard-aux-label">補助キー</span>${[...AUXILIARY_KEYS, ...ARROW_KEYS].map((key) => this.renderKeyboardKey(key, entryMap, dimUnmatched, this.filteredEntries())).join('')}`;
  }

  private renderKeyboardKey(
    key: KeyboardKeyDefinition,
    entryMap: Map<string, HelpEntry[]>,
    dimUnmatched: boolean,
    matchingEntries: readonly HelpEntry[],
  ): string {
    const entries = entryMap.get(key.code) ?? [];
    const matching = entries.filter((entry) => matchingEntries.includes(entry));
    const categories = [...new Set(entries.map((entry) => entry.category))];
    const classes = [
      'help-key', key.className ?? '', ...categories.map((category) => `cat-${category}`),
      entries.length ? 'mapped' : 'unmapped', dimUnmatched && matching.length === 0 ? 'search-muted' : '',
    ].filter(Boolean).join(' ');
    const title = entries.length ? entries.map((entry) => entry.label).join(' / ') : '割り当てなし';
    return `<button type="button" class="${classes}" data-help-code="${escapeHtml(key.code)}" aria-label="${escapeHtml(key.label)}: ${escapeHtml(title)}" title="${escapeHtml(title)}">${escapeHtml(key.label)}</button>`;
  }

  private renderEntryGroups(entries: readonly HelpEntry[]): string {
    return HELP_CATEGORIES.map((category) => {
      const groupEntries = entries.filter((entry) => entry.category === category.id);
      if (groupEntries.length === 0) return '';
      const query = normalize(this.searchInput.value);
      const open = Boolean(query) || this.categoryFilter !== 'all' || category.id === 'basic';
      return `
        <details class="help-group cat-${category.id}" ${open ? 'open' : ''}>
          <summary><span><i aria-hidden="true">${category.glyph}</i>${category.label}</span><em>${groupEntries.length}</em></summary>
          <div class="help-group-body">${groupEntries.map((entry) => this.renderEntry(entry)).join('')}</div>
        </details>`;
    }).join('');
  }

  private renderEntry(entry: HelpEntry): string {
    const codes = entryCodes(entry);
    const keyMarkup = entry.keys?.length
      ? entry.keys.flatMap((key) => [
        this.renderEntryKey(key.code, key.label, entry),
        ...(key.altCodes ?? []).map((code) => this.renderEntryKey(code, key.altLabel ?? code, entry, true)),
      ]).join('<span class="help-key-separator">/</span>')
      : '<span class="help-gesture">ジェスチャ</span>';
    const behavior = entry.behavior ? `<span class="help-behavior">${BEHAVIOR_LABELS[entry.behavior]}</span>` : '';
    const inputs = entry.inputs.map((input) => `<span class="help-input-tag input-${input}">${INPUT_LABELS[input]}</span>`).join('');
    return `
      <article class="help-entry cat-${entry.category}" id="help-entry-${entry.id}" data-help-entry="${entry.id}" data-help-codes="${escapeHtml(codes.join(' '))}">
        <div class="help-entry-keyset">${keyMarkup}</div>
        <div class="help-entry-copy">
          <div class="help-entry-title"><strong>${escapeHtml(entry.label)}</strong><span class="help-entry-tags">${behavior}${inputs}</span></div>
          <p>${escapeHtml(entry.description)}</p>
          ${entry.example ? `<div class="help-example">例: ${escapeHtml(entry.example)}</div>` : ''}
        </div>
      </article>`;
  }

  private renderEntryKey(code: string, label: string, entry: HelpEntry, muted = false): string {
    return `<button type="button" class="help-entry-key ${muted ? 'muted' : ''}" data-help-code="${escapeHtml(code)}" data-help-entry="${entry.id}">${escapeHtml(label)}</button>`;
  }

  private selectCode(code: string, announce = true): void {
    const matches = this.activeKeyboardEntries().filter((entry) => entryMatchesCode(entry, code));
    if (matches.length === 0) return;
    this.selectedCode = code;
    this.selectedEntryId = null;
    this.applySelection();
    const labels = matches.map((entry) => entry.label).join(' / ');
    if (announce) this.liveStatus.textContent = `${code}：${labels}`;
  }

  private selectEntry(entryId: string): void {
    const entry = HELP_ENTRIES.find((item) => item.id === entryId);
    if (!entry) return;
    this.selectedEntryId = entryId;
    this.selectedCode = null;
    this.applySelection();
    this.el.querySelector<HTMLElement>(`#help-entry-${entryId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.liveStatus.textContent = `${entry.label}：${entry.description}`;
  }

  private applySelection(): void {
    this.el.querySelectorAll<HTMLElement>('.help-key.is-selected, .help-entry.is-selected').forEach((element) => {
      element.classList.remove('is-selected');
    });
    if (this.selectedCode) {
      this.el.querySelectorAll<HTMLElement>('[data-help-code]').forEach((element) => {
        if (element.dataset['helpCode'] === this.selectedCode) element.classList.add('is-selected');
      });
      this.el.querySelectorAll<HTMLElement>('.help-entry[data-help-codes]').forEach((element) => {
        const codes = element.dataset['helpCodes']?.split(' ') ?? [];
        if (codes.includes(this.selectedCode!)) element.classList.add('is-selected');
      });
    }
    if (this.selectedEntryId) {
      this.el.querySelector<HTMLElement>(`[data-help-entry="${this.selectedEntryId}"]`)?.classList.add('is-selected');
    }
  }
}

// ショートカットキー(KeyboardEvent.code)をラベル添え用の表記へ変換する。
// コンテキストメニューやプロパティウィンドウでも同じ表記を使う。
export function shortcutKeyLabel(shortcut: string): string {
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  if (shortcut.startsWith('Key')) return shortcut.slice(3);
  return shortcut.toUpperCase();
}
