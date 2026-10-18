// 操作説明の対応表 — 何を操作すると何が起きるかを1行ずつ持つ。
import { KEY_MAPPING as K, type KeyBinding } from '../../../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from '../../dynamic/sim-speed-manager';
import { THROTTLE_LABELS } from '../../player/throttle';

// 行が属する章。タブの並び順と表示名はパネル側が持つ。
export type HelpCategory = 'flight' | 'camera' | 'combat' | 'map' | 'system';

// 対応表の入力欄の表記。gesture はタッチ・マウスの操作(丸い札を並べる。複数は「または」)、
// key はキー割り当て(キーキャップを並べる)。
export type HelpInput =
  | { readonly kind: 'gesture'; readonly chips: readonly string[] }
  | { readonly kind: 'key'; readonly keys: readonly string[] };

// 説明文の断片。文字列はそのまま、key はキーキャップとして出す。
export type HelpTextPart = string | { readonly key: string };

// 対応表の1行。category は載せる章、input は操作する入力の表記、label と description は
// それで起きること。
export interface HelpRow {
  readonly category: HelpCategory;
  readonly input: HelpInput;
  readonly label: string;
  readonly description: readonly HelpTextPart[];
}

// description の断片にキーキャップを差し込むための、キー割り当ての断片。
function keyPart(key: KeyBinding): HelpTextPart {
  return { key: key.label };
}

// タッチ・マウスの行。chips は同じ操作を指す表記の並び。
function gestureRow(
  category: HelpCategory, chips: readonly string[], label: string, description: string,
): HelpRow {
  return { category, input: { kind: 'gesture', chips }, label, description: [description] };
}

// キー割り当ての行。別キーを持つキーは別のキーキャップとして続ける。説明は文字列かキーを含む断片の並び。
function keyRow(
  category: HelpCategory, keys: readonly KeyBinding[], label: string, description: string | readonly HelpTextPart[],
): HelpRow {
  const labels = keys.flatMap((key) => (key.altLabel ? [key.label, key.altLabel] : [key.label]));
  return {
    category, input: { kind: 'key', keys: labels }, label,
    description: typeof description === 'string' ? [description] : description,
  };
}

// 章の対応表を、タッチ・マウスの行、キーボードの行の順に分けて返す。
export function helpRowGroups(category: HelpCategory): { readonly gestures: readonly HelpRow[]; readonly keys: readonly HelpRow[] } {
  const rows = helpRows().filter((row) => row.category === category);
  return {
    gestures: rows.filter((row) => row.input.kind === 'gesture'),
    keys: rows.filter((row) => row.input.kind === 'key'),
  };
}

// 対応表の行を、タッチ・マウスの行、キーボードの行の順に返す。キー名は必ず KEY_MAPPING から取る。
// ゲーム側の定数を説明文へ埋め込むので呼び出し時に組み立てる — このモジュールは HUD の import 環の
// 中にあり、評価時に他モジュールの定数を読むと循環の順序次第で未初期化のものを掴む。
export function helpRows(): readonly HelpRow[] {
  return [
    // タッチ・マウスの操作。
    gestureRow(
      'map', ['長押し', '右クリック'], 'プロパティ・メニュー',
      '対象のプロパティウィンドウ、または空域・ノード・計画軌道のメニューを開く。',
    ),
    gestureRow('camera', ['二本指ドラッグ', '中ボタンドラッグ'], '視点パン', 'カメラを画面平面に沿って移動する。'),
    gestureRow('flight', ['ピンチ', 'ホイール'], '距離ズーム', 'カメラ距離を変える。二本指をひねると視点ロールになる。'),
    gestureRow(
      'camera', ['ダブルタップ', 'ダブルクリック'], 'フォーカス移動', '対象へフォーカスを移す。自艦なら操作対象にもなる。',
    ),
    gestureRow('camera', ['ドラッグ'], '視点回転', 'カメラのヨー / ピッチを回す。'),
    gestureRow(
      'map', ['計画軌道をタップ', 'クリック'], 'ノードを配置',
      'マップビューで計画軌道にノードを置く。ノードの丸ハンドルをドラッグすると軌道上の時刻を移動する。',
    ),
    gestureRow(
      'map', ['Δv ハンドルをドラッグ'], 'ノードの Δv 編集',
      '選択中ノードの PRO/RET・NRM/ANM・OUT/IN ハンドルで Δv 成分を調整する。',
    ),
    // キーボードの操作。
    keyRow(
      'flight',
      [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown],
      '機体の並進', '前 / 後 / 左 / 右 / 上 / 下へ推進する。キーを押している間だけ出力する。',
    ),
    keyRow(
      'flight',
      [K.pitchDown, K.pitchUp, K.yawRight, K.yawLeft, K.rollLeft, K.rollRight],
      '機体の姿勢変更', 'ピッチ / ヨー / ロールを RCS で操作する。',
    ),
    keyRow('flight', [K.rcsDampToggle], 'RCS 回転制動', '回転速度を自動的に抑える機能を ON/OFF する。'),
    keyRow('flight', [K.progradeReset], 'プログレード姿勢リセット', '機首を進行方向へ即座に向ける。'),
    keyRow(
      'flight',
      [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax],
      '並進出力レベル', `並進 6 方向に共通する出力を切り替える (${THROTTLE_LABELS.join(' / ')})。`,
    ),
    keyRow('flight', [K.fineAttitudeToggle], '姿勢微調整モード', '角加速度・角速度を絞り、小刻みに姿勢を調整する。'),
    keyRow('flight', [K.progradeHoldToggle], '進行方向ホールド', '機首をプログレード方向へ自動で向け続ける。手動回転で解除する。'),
    keyRow(
      'flight',
      [K.radiatorDeployLeft, K.radiatorDeployRight], 'ラジエーター展開 / 収納',
      ['左右のラジエーターを個別に切り替える (', keyPart(K.radiatorDeployLeft), ' = 左、', keyPart(K.radiatorDeployRight), ' = 右)。'],
    ),
    keyRow(
      'flight',
      [K.solarDeployLeft, K.solarDeployRight], '太陽電池パドル展開 / 収納',
      ['左右の太陽電池パドルを個別に切り替える (', keyPart(K.solarDeployLeft), ' = 左、', keyPart(K.solarDeployRight), ' = 右)。'],
    ),
    keyRow('flight', [K.acknowledgeAlarm], '警報を確認', '点滅と警報音を止める。警報は条件が戻るまで残る。'),
    keyRow('combat', [K.targetSelect], 'ターゲット選択', '照準に近い敵を選択する。短時間の連打で第二ターゲットを順送りする。'),
    keyRow('combat', [K.gunsightZoom], '照準ズーム', '押している間、機首方向を画面中心に拡大表示する。自機は非表示になる。'),
    keyRow('camera', [K.followAttitudeToggle], '視点の RCS 追従', '視点を機体姿勢に追従させる。OFF にすると軌道基準の独立視点になる。'),
    keyRow('combat', [K.fire], '機関砲発射', `押している間、機関砲を発射する。ワープ ×${MAX_PHYS_SIM_SPEED} 以下で操作できる。`),
    keyRow('combat', [K.reload], 'マニュアル装填', '残弾のあるマガジンを捨てて、新しいマガジンを装填する。'),
    keyRow(
      'camera',
      [K.cameraYawLeft, K.cameraYawRight, K.cameraPitchUp, K.cameraPitchDown],
      '視点回転', 'カメラのヨー / ピッチを回す。',
    ),
    keyRow('camera', [K.cameraRollLeft, K.cameraRollRight], '視点ロール', '視点を左右にロールする。'),
    keyRow(
      'camera',
      [K.cameraPanUp, K.cameraPanDown, K.cameraPanLeft, K.cameraPanRight],
      '視点パン', 'カメラを画面平面に沿って移動する。',
    ),
    keyRow(
      'map',
      [K.warpSlower, K.warpFaster], '時間加速',
      [keyPart(K.warpSlower), ' で時間加速を 1 段下げ、', keyPart(K.warpFaster), ' で 1 段上げる。'],
    ),
    keyRow('map', [K.toggleMapMode], 'ビュー切替', '戦闘ビューとマップビューを切り替える。時間は進み続けるのでワープも使える。'),
    keyRow(
      'map',
      [K.autoWarpToNode], 'ノードまで自動ワープ',
      'マップビューで、直近のマニューバノードまで時間を自動加速し、実行点の直前で解除する。',
    ),
    keyRow(
      'map',
      [K.dvPrograde, K.dvRetrograde, K.dvNormal, K.dvAntinormal, K.dvRadialOut, K.dvRadialIn],
      'ノードの Δv 編集',
      'マップビューでノードを選択している間、機体の並進の代わりに Δv を PRO / RET / NRM / ANM / OUT / IN へ調整する。',
    ),
    keyRow(
      'map',
      [K.deleteNode], 'ノードを削除',
      'マップビューで選択中のノードを削除する。ノードを選択していなければ計画全体を破棄する。',
    ),
    keyRow('system', [K.help], 'このヘルプ', '操作説明を開閉する。'),
    keyRow('system', [K.pauseMenu], 'ESC メニュー', '開いているウィンドウを1つ閉じる。何も開いていなければ ESC メニューを開く。'),
    keyRow(
      'system',
      [K.toggleDebugInfoWindow, K.manualSave, K.openSaveBrowser], 'デバッグ・セーブ',
      [
        keyPart(K.toggleDebugInfoWindow), ' でデバッグ表示、', keyPart(K.manualSave), ' で手動セーブ、',
        keyPart(K.openSaveBrowser), ' でセーブデータ画面を開く。',
      ],
    ),
    keyRow('system', [K.restart], '決着後の再出撃', '決着画面で同じステージへ再出撃する。'),
  ];
}
