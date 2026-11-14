// 操作説明の対応表 — 何を操作すると何が起きるかを1行ずつ持つ。
import { KEY_MAPPING as K, type KeyBinding } from '../../../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from '../../dynamic/sim-speed-manager';
import { THROTTLE_LABELS } from '../../player/throttle';

// 行が属する章。タブの並び順と表示名はパネル側が持つ。
export type HelpCategory = 'flight' | 'camera' | 'combat' | 'map' | 'construction' | 'system';

// 対応表の1行。category は載せる章、input は操作する入力の表記、label と description は
// それで起きること。
interface HelpRow {
  readonly category: HelpCategory;
  readonly input: string;
  readonly label: string;
  readonly description: string;
}

// キー割り当ての行。別キーを持つキーは括弧で併記する。
function keyRow(
  category: HelpCategory, keys: readonly KeyBinding[], label: string, description: string,
): HelpRow {
  const input = keys.map((key) => (key.altLabel ? `${key.label} (${key.altLabel})` : key.label)).join(' / ');
  return { category, input, label, description };
}

// 対応表の行を、タッチ・マウスの行、キーボードの行の順に返す。キー名は必ず KEY_MAPPING から取る。
// ゲーム側の定数を説明文へ埋め込むので呼び出し時に組み立てる — このモジュールは HUD の import 環の
// 中にあり、評価時に他モジュールの定数を読むと循環の順序次第で未初期化のものを掴む。
export function helpRows(): readonly HelpRow[] {
  return [
    // タッチ・マウスの操作。
    {
      category: 'map', input: '長押し / 右クリック', label: 'プロパティ・メニュー',
      description: '対象のプロパティウィンドウ、または空域・ノード・計画軌道のメニューを開く。',
    },
    { category: 'camera', input: '二本指ドラッグ / 中ボタンドラッグ', label: '視点パン', description: 'カメラを画面平面に沿って移動する。' },
    { category: 'flight', input: 'ピンチ / ホイール', label: '距離ズーム', description: 'カメラ距離を変える。二本指をひねると視点ロールになる。' },
    { category: 'camera', input: 'ダブルタップ / ダブルクリック', label: 'フォーカス移動', description: '対象へフォーカスを移す。自艦なら操作対象にもなる。' },
    { category: 'camera', input: 'ドラッグ', label: '視点回転', description: 'カメラのヨー / ピッチを回す。' },
    {
      category: 'map', input: '計画軌道をタップ / クリック', label: 'ノードを配置',
      description: 'マップビューで計画軌道にノードを置く。ノードの丸ハンドルをドラッグすると軌道上の時刻を移動する。',
    },
    {
      category: 'map', input: 'Δv ハンドルをドラッグ', label: 'ノードの Δv 編集',
      description: '選択中ノードの PRO/RET・NRM/ANM・OUT/IN ハンドルで Δv 成分を調整する。',
    },
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
      `左右のラジエーターを個別に切り替える (${K.radiatorDeployLeft.label} = 左、${K.radiatorDeployRight.label} = 右)。`,
    ),
    keyRow(
      'flight',
      [K.solarDeployLeft, K.solarDeployRight], '太陽電池パドル展開 / 収納',
      `左右の太陽電池パドルを個別に切り替える (${K.solarDeployLeft.label} = 左、${K.solarDeployRight.label} = 右)。`,
    ),
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
      `${K.warpSlower.label} で時間加速を 1 段下げ、${K.warpFaster.label} で 1 段上げる。`,
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
    ...constructionRows(),
    keyRow('system', [K.constructionStart], '建造開始', '艦のステータスパネルの「建造」、ドックのクリック、[B] のいずれでも始められる。'),
    keyRow('system', [K.help], 'このヘルプ', '操作説明を開閉する。'),
    keyRow('system', [K.pauseMenu], 'ESC メニュー', '開いているウィンドウを1つ閉じる。何も開いていなければ ESC メニューを開く。'),
    keyRow(
      'system',
      [K.toggleDebugInfoWindow, K.manualSave, K.openSaveBrowser], 'デバッグ・セーブ',
      `${K.toggleDebugInfoWindow.label} でデバッグ表示、${K.manualSave.label} で手動セーブ、`
        + `${K.openSaveBrowser.label} でセーブデータ画面を開く。`,
    ),
    keyRow('system', [K.restart], '決着後の再出撃', '決着画面で同じステージへ再出撃する。'),
  ];
}

// 建造中の操作の行。タッチ・マウスの行を先に、キーボードの行を後に並べる。
function constructionRows(): readonly HelpRow[] {
  return [
    // タッチ・マウスの操作。
    {
      category: 'construction', input: 'クリック / タップ', label: '置く / 選ぶ',
      description: '手に持っている間は、押した位置の取り付け候補へ置く(候補が無い場所では何もしない)。'
        + '手に何も持っていなければ、押した位置の配置済みモジュールを選ぶ。',
    },
    {
      category: 'construction', input: '選択中のモジュールからドラッグ', label: '付け替え',
      description: 'モジュールを先端部ごと掴み、別の候補へ付け替える。候補以外で離すと元へ戻る。',
    },
    {
      category: 'construction', input: '回転リングをドラッグ', label: 'モジュールを回す',
      description: '選んだモジュールの回りの円をドラッグして回す。離した位置を 90° 単位へ丸めて適用する。'
        + '円の上を押してすぐ離しても、近い矢印の向きへ 1 段回る。モジュールの脇のメニューにも回転のボタンがある。',
    },
    {
      category: 'construction', input: 'カタログのカードをドラッグ', label: 'カードから置く',
      description: 'カードを画面へドラッグし、候補の上で離すと置く。タッチは長押ししてからドラッグする。',
    },
    {
      category: 'construction', input: 'ホバー', label: '置いた場合の予告',
      description: '候補を指すと、そこへ置いた場合の半透明表示と性能の変化が出る。',
    },
    {
      category: 'construction', input: '右クリック / 長押し', label: '手放す',
      description: '手に持っているものを手放し、選択を解く。',
    },
    // キーボードの操作。
    keyRow(
      'construction',
      [K.constructionRollLeft, K.constructionRollRight], '回転',
      `手に持ったもの・選択中のモジュールを接続軸まわりに回す `
        + `(${K.constructionRollLeft.label} = −90°、${K.constructionRollRight.label} = +90°)。`,
    ),
    keyRow(
      'construction',
      [K.constructionSwapEnds], '向きを反転',
      '両端に取り付け面を持つモジュールの、どちらの端で付くかを入れ替える。',
    ),
    keyRow(
      'construction',
      [K.constructionSymmetry], '対称配置',
      '新しく置くモジュールの対称数を 1 → 2 → 4 と切り替える。',
    ),
    keyRow(
      'construction',
      [K.constructionDuplicate], '複製',
      '選択中のモジュールの先端部を複製して手に取る。',
    ),
    keyRow('construction', [K.constructionRemove], '撤去', '選択中のモジュールを先端部ごと撤去する。'),
    keyRow('construction', [K.constructionUndo], '取り消し', '直前の操作を取り消す。macOS では ⌘Z。'),
    keyRow(
      'construction',
      [K.constructionRedo, K.constructionRedoAlt], 'やり直し',
      '取り消した操作をやり直す。macOS では ⇧⌘Z。',
    ),
    keyRow(
      'construction',
      [K.constructionCyclePart], '部品送り',
      '表示中のカテゴリで手に取るモジュールを次へ送る。Shift+Tab で前へ。',
    ),
    keyRow(
      'construction',
      [
        K.constructionCategory1, K.constructionCategory2, K.constructionCategory3,
        K.constructionCategory4, K.constructionCategory5, K.constructionCategory6,
      ],
      'カテゴリ', 'カタログのカテゴリ(指令・燃料・推進・戦闘・設備・設計図)を選ぶ。',
    ),
    keyRow('construction', [K.constructionPlace], '置く', '手に持ったものを、選んでいる候補へ置く。'),
    keyRow(
      'construction', [K.constructionFocus], '視点',
      '選択中のモジュールへ視点を寄せる。選んでいなければ船体全体へ寄せる。',
    ),
    keyRow('construction', [K.help], 'このヘルプ', '操作説明を開閉する。'),
    keyRow('construction', [K.pauseMenu], '建造を終える', '変更を残して建造を閉じる。'),
  ];
}
