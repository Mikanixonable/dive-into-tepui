// 操作説明として何が存在するかのデータを持つ — カテゴリ・個々の操作定義
// (helpEntries)・キーボード配列図・状態ラベルの一覧と、それらに対する
// 検索・フィルタ判定の純関数。
import { KEY_MAPPING as K, type KeyBinding } from '../../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from '../../dynamic/sim-speed-manager';
import { THROTTLE_LABELS } from '../../player/player-throttle';
import { MAG_ROUNDS } from '../../player/player-fire';
import type { View } from '../../view/view';

export type HelpInput = 'keyboard' | 'mouse' | 'touch';
export type HelpCategory = 'basic' | 'combat' | 'camera' | 'time' | 'map' | 'ui' | 'gesture';
type HelpScope = View | 'both';
type HelpBehavior = 'press' | 'hold' | 'toggle' | 'drag' | 'gesture';

export interface HelpEntry {
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

export interface KeyboardKeyDefinition {
  readonly code: string;
  readonly label: string;
  readonly className?: string;
}

// 並び順がそのままカテゴリタブ・グループの表示順になる。
export const HELP_CATEGORIES: readonly { id: HelpCategory; label: string; glyph: string }[] = [
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
// 操作説明の一覧。ゲーム側の定数を説明文へ埋め込むので、モジュール評価時ではなく
// 呼び出し時に組み立てる — このモジュールは HUD の import 環の中にあり、評価時に
// 他モジュールの定数を読むと循環の順序次第で未初期化のものを掴む。
export function helpEntries(): readonly HelpEntry[] {
  return [
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
      description: `並進 6 方向に共通する出力を切り替える (${THROTTLE_LABELS.join(' / ')})。`,
      keys: [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax],
      inputs: ['keyboard'], scope: 'combat', behavior: 'press', example: '1 = 低出力、4 = 最大出力',
    },
    {
      id: 'booster-management', category: 'combat', label: 'ブースター燃焼管理',
      description: 'ブースターの点火 / 停止と最後尾段の分離を切り替える。',
      keys: [K.boosterIgnitionToggle, K.boosterDecouple], inputs: ['keyboard'], scope: 'both', behavior: 'toggle',
      example: '6 = 点火 / 停止、5 = 分離',
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
      description: `機関砲を発射する。ワープ ×${MAX_PHYS_SIM_SPEED} 以下で操作できる。`,
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
      description: `${MAG_ROUNDS} 発でマガジン 1 連を消費する。残弾が少なくなると軌道上へ補給が投入されるので、AMMO マーカーへ接近して回収する。`,
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
}

export const KEYBOARD_ROWS: readonly KeyboardKeyDefinition[][] = [
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

export const ARROW_KEYS: readonly KeyboardKeyDefinition[] = [
  { code: 'ArrowUp', label: '↑' }, { code: 'ArrowLeft', label: '←' },
  { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' },
];

// 日本語キーボードでのカメラロール代替キー(Num0 / Num1 / _)を、主要キー配列と別枠で並べる。
export const AUXILIARY_KEYS: readonly KeyboardKeyDefinition[] = [
  { code: 'Numpad0', label: 'Num0' }, { code: 'Numpad1', label: 'Num1' }, { code: 'IntlRo', label: '_' },
];

export const BEHAVIOR_LABELS: Readonly<Record<HelpBehavior, string>> = {
  press: '押す', hold: '押している間', toggle: 'ON / OFF', drag: 'ドラッグ', gesture: 'ジェスチャ',
};

export const INPUT_LABELS: Readonly<Record<HelpInput, string>> = {
  keyboard: 'KEYBOARD', mouse: 'MOUSE', touch: 'TOUCH',
};

// 前後の空白を落として小文字化し、検索語と対象文字列を同じ基準で比較できるようにする。
export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

// エントリに割り当てられた全キーコード(代替コード含む)を重複なく列挙する。
export function entryCodes(entry: HelpEntry): string[] {
  const codes: string[] = [];
  for (const key of entry.keys ?? []) codes.push(key.code, ...(key.altCodes ?? []));
  return [...new Set(codes)];
}

// 指定した KeyboardEvent.code がエントリのキー割り当てに含まれるかを判定する。
export function entryMatchesCode(entry: HelpEntry, code: string): boolean {
  return entryCodes(entry).includes(code);
}

// エントリの scope が現在の表示モードで見せるべきものかを判定する。both は常に一致する。
export function scopeMatches(entry: HelpEntry, mode: View): boolean {
  return entry.scope === 'both' || entry.scope === mode;
}
