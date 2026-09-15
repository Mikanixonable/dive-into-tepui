// 操作説明の対応表 — 何を操作すると何が起きるかを1行ずつ持つ。
import { KEY_MAPPING as K, type KeyBinding } from '../../../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from '../../dynamic/sim-speed-manager';
import { THROTTLE_LABELS } from '../../player/throttle';

// 対応表の1行。input は操作する入力の表記、label と description はそれで起きること。
export interface HelpRow {
  readonly input: string;
  readonly label: string;
  readonly description: string;
}

// キー割り当ての行。別キーを持つキーは括弧で併記する。
function keyRow(keys: readonly KeyBinding[], label: string, description: string): HelpRow {
  const input = keys.map((key) => (key.altLabel ? `${key.label} (${key.altLabel})` : key.label)).join(' / ');
  return { input, label, description };
}

// 対応表の行を、タッチ・マウスの行、キーボードの行の順に返す。キー名は必ず KEY_MAPPING から取る。
// ゲーム側の定数を説明文へ埋め込むので呼び出し時に組み立てる — このモジュールは HUD の import 環の
// 中にあり、評価時に他モジュールの定数を読むと循環の順序次第で未初期化のものを掴む。
export function helpRows(): readonly HelpRow[] {
  return [
    // タッチ・マウスの操作。
    {
      input: '長押し / 右クリック', label: 'プロパティ・メニュー',
      description: '対象のプロパティウィンドウ、または空域・ノード・計画軌道のメニューを開く。',
    },
    { input: '二本指ドラッグ / 中ボタンドラッグ', label: '視点パン', description: 'カメラを画面平面に沿って移動する。' },
    { input: 'ピンチ / ホイール', label: '距離ズーム', description: 'カメラ距離を変える。二本指をひねると視点ロールになる。' },
    { input: 'ダブルタップ / ダブルクリック', label: 'フォーカス移動', description: '対象へフォーカスを移す。自艦なら操作対象にもなる。' },
    { input: 'ドラッグ', label: '視点回転', description: 'カメラのヨー / ピッチを回す。' },
    {
      input: '計画軌道をタップ / クリック', label: 'ノードを配置',
      description: 'マップビューで計画軌道にノードを置く。ノードの丸ハンドルをドラッグすると軌道上の時刻を移動する。',
    },
    {
      input: 'Δv ハンドルをドラッグ', label: 'ノードの Δv 編集',
      description: '選択中ノードの PRO/RET・NRM/ANM・OUT/IN ハンドルで Δv 成分を調整する。',
    },
    // キーボードの操作。
    keyRow(
      [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown],
      '機体の並進', '前 / 後 / 左 / 右 / 上 / 下へ推進する。キーを押している間だけ出力する。',
    ),
    keyRow(
      [K.pitchDown, K.pitchUp, K.yawRight, K.yawLeft, K.rollLeft, K.rollRight],
      '機体の姿勢変更', 'ピッチ / ヨー / ロールを RCS で操作する。',
    ),
    keyRow([K.rcsDampToggle], 'RCS 回転制動', '回転速度を自動的に抑える機能を ON/OFF する。'),
    keyRow([K.progradeReset], 'プログレード姿勢リセット', '機首を進行方向へ即座に向ける。'),
    keyRow(
      [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax],
      '並進出力レベル', `並進 6 方向に共通する出力を切り替える (${THROTTLE_LABELS.join(' / ')})。`,
    ),
    keyRow(
      [K.boosterIgnitionToggle, K.boosterDecouple], 'ブースター燃焼管理',
      `${K.boosterIgnitionToggle.label} で最後尾の段を点火 / 停止、${K.boosterDecouple.label} で分離する。`,
    ),
    keyRow([K.fineAttitudeToggle], '姿勢微調整モード', '角加速度・角速度を絞り、小刻みに姿勢を調整する。'),
    keyRow([K.progradeHoldToggle], '進行方向ホールド', '機首をプログレード方向へ自動で向け続ける。手動回転で解除する。'),
    keyRow(
      [K.radiatorDeployLeft, K.radiatorDeployRight], 'ラジエーター展開 / 収納',
      `左右のラジエーターを個別に切り替える (${K.radiatorDeployLeft.label} = 左、${K.radiatorDeployRight.label} = 右)。`,
    ),
    keyRow(
      [K.solarDeployLeft, K.solarDeployRight], '太陽電池パドル展開 / 収納',
      `左右の太陽電池パドルを個別に切り替える (${K.solarDeployLeft.label} = 左、${K.solarDeployRight.label} = 右)。`,
    ),
    keyRow([K.targetSelect], 'ターゲット選択', '照準に近い敵を選択する。短時間の連打で第二ターゲットを順送りする。'),
    keyRow([K.gunsightZoom], '照準ズーム', '押している間、機首方向を画面中心に拡大表示する。自機は非表示になる。'),
    keyRow([K.followAttitudeToggle], '視点の RCS 追従', '視点を機体姿勢に追従させる。OFF にすると軌道基準の独立視点になる。'),
    keyRow([K.fire], '機関砲発射', `押している間、機関砲を発射する。ワープ ×${MAX_PHYS_SIM_SPEED} 以下で操作できる。`),
    keyRow([K.reload], 'マニュアル装填', '残弾のあるマガジンを捨てて、新しいマガジンを装填する。'),
    keyRow(
      [K.cameraYawLeft, K.cameraYawRight, K.cameraPitchUp, K.cameraPitchDown],
      '視点回転', 'カメラのヨー / ピッチを回す。',
    ),
    keyRow([K.cameraRollLeft, K.cameraRollRight], '視点ロール', '視点を左右にロールする。'),
    keyRow(
      [K.cameraPanUp, K.cameraPanDown, K.cameraPanLeft, K.cameraPanRight],
      '視点パン', 'カメラを画面平面に沿って移動する。',
    ),
    keyRow(
      [K.warpSlower, K.warpFaster], '時間加速',
      `${K.warpSlower.label} で時間加速を 1 段下げ、${K.warpFaster.label} で 1 段上げる。`,
    ),
    keyRow([K.toggleMapMode], 'ビュー切替', '戦闘ビューとマップビューを切り替える。時間は進み続けるのでワープも使える。'),
    keyRow(
      [K.autoWarpToNode], 'ノードまで自動ワープ',
      'マップビューで、直近のマニューバノードまで時間を自動加速し、実行点の直前で解除する。',
    ),
    keyRow(
      [K.dvPrograde, K.dvRetrograde, K.dvNormal, K.dvAntinormal, K.dvRadialOut, K.dvRadialIn],
      'ノードの Δv 編集',
      'マップビューでノードを選択している間、機体の並進の代わりに Δv を PRO / RET / NRM / ANM / OUT / IN へ調整する。',
    ),
    keyRow(
      [K.deleteNode], 'ノードを削除',
      'マップビューで選択中のノードを削除する。ノードを選択していなければ計画全体を破棄する。',
    ),
    keyRow([K.help], 'このヘルプ', '操作説明を開閉する。'),
    keyRow([K.pauseMenu], 'ESC メニュー', '開いているウィンドウを1つ閉じる。何も開いていなければ ESC メニューを開く。'),
    keyRow(
      [K.toggleDebugInfoWindow, K.clipSnapshot, K.openSnapshots], 'デバッグ・スナップショット',
      `${K.toggleDebugInfoWindow.label} でデバッグ表示、${K.clipSnapshot.label} でスナップショット取得、`
        + `${K.openSnapshots.label} でスナップショット一覧を開く。`,
    ),
    keyRow([K.restart], '決着後の再出撃', '決着画面で同じステージへ再出撃する。'),
  ];
}
