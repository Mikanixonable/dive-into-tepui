// 操作説明の対応表 — 何を操作すると何が起きるかを1行ずつ持つ。
import { KEY_MAPPING as K, type KeyBinding } from '../../../input-devices/key-mapping';
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

// キー割り当ての行を、環境に応じて出し分ける。coarse な環境ではキー名ではなく
// 画面上の操作部品の名前(touchInput)で案内する。touchInput が null の行は、
// タッチ・マウスの行で同じ操作を既に案内しているため coarse では省く。
function dualRow(
  coarse: boolean,
  category: HelpCategory, keys: readonly KeyBinding[], touchInput: string | null,
  label: string, description: string, touchDescription?: string,
): HelpRow | null {
  if (!coarse) return keyRow(category, keys, label, description);
  if (touchInput === null) return null;
  return { category, input: touchInput, label, description: touchDescription ?? description };
}

// 対応表の行を、タッチ・マウスの行、キーボードの行の順に返す。キー名は必ず KEY_MAPPING から取る。
// ゲーム側の定数を説明文へ埋め込むので呼び出し時に組み立てる — このモジュールは HUD の import 環の
// 中にあり、評価時に他モジュールの定数を読むと循環の順序次第で未初期化のものを掴む。
export function helpRows(coarse: boolean): readonly HelpRow[] {
  const rows: readonly (HelpRow | null)[] = [
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
    // キーボードの操作(coarse な環境では操作部品の名前で案内する)。
    dualRow(
      coarse, 'flight',
      [K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown],
      '左下の並進パッド',
      '機体の並進', '前 / 後 / 左 / 右 / 上 / 下へ推進する。キーを押している間だけ出力する。',
      '前 / 後 / 左 / 右 / 上 / 下へ推進する。ボタンを押している間だけ出力する。',
    ),
    dualRow(
      coarse, 'flight',
      [K.pitchDown, K.pitchUp, K.yawRight, K.yawLeft, K.rollLeft, K.rollRight],
      '右下の回転パッド',
      '機体の姿勢変更', 'ピッチ / ヨー / ロールを RCS で操作する。',
    ),
    dualRow(coarse, 'flight', [K.rcsDampToggle], '制動ボタン', 'RCS 回転制動', '回転速度を自動的に抑える機能を ON/OFF する。'),
    dualRow(coarse, 'flight', [K.progradeReset], '「進行方向」ボタン', 'プログレード姿勢リセット', '機首を進行方向へ即座に向ける。'),
    dualRow(
      coarse, 'flight',
      [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax],
      '推力段ボタン',
      '並進出力レベル', `並進 6 方向に共通する出力を切り替える (${THROTTLE_LABELS.join(' / ')})。`,
      `並進 6 方向に共通する出力を切り替える (${THROTTLE_LABELS.join(' / ')})。タッチ操作の間だけ SHIP STATUS に現れる。`,
    ),
    dualRow(coarse, 'flight', [K.fineAttitudeToggle], '微動ボタン', '姿勢微調整モード', '角加速度・角速度を絞り、小刻みに姿勢を調整する。'),
    dualRow(coarse, 'flight', [K.progradeHoldToggle], 'ホールドボタン', '進行方向ホールド', '機首をプログレード方向へ自動で向け続ける。手動回転で解除する。'),
    dualRow(
      coarse, 'flight',
      [K.radiatorDeployLeft, K.radiatorDeployRight], '「放熱板」ボタン', 'ラジエーター展開 / 収納',
      `左右のラジエーターを個別に切り替える (${K.radiatorDeployLeft.label} = 左、${K.radiatorDeployRight.label} = 右)。`,
      '左右のラジエーターを個別に切り替える。',
    ),
    dualRow(
      coarse, 'flight',
      [K.solarDeployLeft, K.solarDeployRight], '「パドル」ボタン', '太陽電池パドル展開 / 収納',
      `左右の太陽電池パドルを個別に切り替える (${K.solarDeployLeft.label} = 左、${K.solarDeployRight.label} = 右)。`,
      '左右の太陽電池パドルを個別に切り替える。',
    ),
    dualRow(coarse, 'combat', [K.targetSelect], '「ターゲット」ボタン', 'ターゲット選択', '照準に近い敵を選択する。短時間の連打で第二ターゲットを順送りする。'),
    dualRow(
      coarse, 'combat', [K.gunsightZoom], 'ZOOM ボタン', '照準ズーム',
      '押している間、機首方向を画面中心に拡大表示する。自機は非表示になる。',
      'タップで ON/OFF する。ON の間、機首方向を画面中心に拡大表示する。自機は非表示になる。',
    ),
    dualRow(coarse, 'camera', [K.followAttitudeToggle], '「視点追従」ボタン', '視点の RCS 追従', '視点を機体姿勢に追従させる。OFF にすると軌道基準の独立視点になる。'),
    dualRow(coarse, 'combat', [K.fire], 'FIRE ボタン', '機関砲発射', `押している間、機関砲を発射する。ワープ ×${MAX_PHYS_SIM_SPEED} 以下で操作できる。`),
    dualRow(coarse, 'combat', [K.reload], '「装填」ボタン', 'マニュアル装填', '残弾のあるマガジンを捨てて、新しいマガジンを装填する。'),
    dualRow(
      coarse, 'camera',
      [K.cameraYawLeft, K.cameraYawRight, K.cameraPitchUp, K.cameraPitchDown],
      null,
      '視点回転', 'カメラのヨー / ピッチを回す。',
    ),
    dualRow(coarse, 'camera', [K.cameraRollLeft, K.cameraRollRight], null, '視点ロール', '視点を左右にロールする。'),
    dualRow(
      coarse, 'camera',
      [K.cameraPanUp, K.cameraPanDown, K.cameraPanLeft, K.cameraPanRight],
      null,
      '視点パン', 'カメラを画面平面に沿って移動する。',
    ),
    dualRow(
      coarse, 'map',
      [K.warpSlower, K.warpFaster], '減速 / 加速ボタン', '時間加速',
      `${K.warpSlower.label} で時間加速を 1 段下げ、${K.warpFaster.label} で 1 段上げる。`,
      '時間加速を 1 段下げる / 上げる。',
    ),
    dualRow(coarse, 'map', [K.toggleMapMode], '計画ボタン', 'ビュー切替', '戦闘ビューとマップビューを切り替える。時間は進み続けるのでワープも使える。'),
    dualRow(
      coarse, 'map',
      [K.autoWarpToNode], 'ノードへボタン', 'ノードまで自動ワープ',
      'マップビューで、直近のマニューバノードまで時間を自動加速し、実行点の直前で解除する。',
    ),
    dualRow(
      coarse, 'map',
      [K.dvPrograde, K.dvRetrograde, K.dvNormal, K.dvAntinormal, K.dvRadialOut, K.dvRadialIn],
      '計画パネルの Δv ボタン',
      'ノードの Δv 編集',
      'マップビューでノードを選択している間、機体の並進の代わりに Δv を PRO / RET / NRM / ANM / OUT / IN へ調整する。',
      'マップビューでノードを選択している間、計画パネルの PRO / RET / NRM / ANM / OUT / IN ボタンを長押しして Δv を調整する。',
    ),
    dualRow(
      coarse, 'map',
      [K.deleteNode], '長押しメニュー', 'ノードを削除',
      'マップビューで選択中のノードを削除する。ノードを選択していなければ計画全体を破棄する。',
      'マップビューでノードを長押しし、メニューの「ノードを削除」を選ぶ。計画軌道の長押しメニューからは計画全体を破棄できる。',
    ),
    ...constructionRows(coarse),
    dualRow(
      coarse, 'system', [K.constructionStart], '「建造」ボタン', '建造開始',
      '艦のステータスパネルの「建造」、ドックのクリック、[B] のいずれでも始められる。',
      '艦のステータスパネルの「建造」ボタン、ドックのタップで始められる。',
    ),
    dualRow(coarse, 'system', [K.help], 'ヘルプボタン', 'このヘルプ', '操作説明を開閉する。'),
    dualRow(coarse, 'system', [K.wideScreenToggle], '右上の ⤢ ボタン', '画面を広く', 'レール・上部バー・下部の帯を隠して画面を広く使う。もう一度押すと戻る。'),
    dualRow(coarse, 'system', [K.pauseMenu], '⚙\uFE0E バッジ', 'ESC メニュー', '開いているウィンドウを1つ閉じる。何も開いていなければ ESC メニューを開く。'),
    dualRow(
      coarse, 'system',
      [K.toggleDebugInfoWindow, K.manualSave, K.openSaveBrowser], '⚙\uFE0E バッジのメニュー', 'デバッグ・セーブ',
      `${K.toggleDebugInfoWindow.label} でデバッグ表示、${K.manualSave.label} で手動セーブ、`
        + `${K.openSaveBrowser.label} でセーブデータ画面を開く。`,
      '⚙\uFE0E バッジで開く ESC メニューから、デバッグ表示・手動セーブ・セーブデータ画面を開く。',
    ),
    dualRow(coarse, 'system', [K.restart], '決着画面のボタン', '決着後の再出撃', '決着画面で同じステージへ再出撃する。'),
    dualRow(
      coarse, 'system', [K.alarmAcknowledge], '警報帯の「確認」ボタン', '警報の確認',
      '警告の点滅と警報音を止める。警報は条件が戻るまで残る。',
    ),
  ];
  return rows.filter((row): row is HelpRow => row !== null);
}

// 建造中の操作の行。タッチ・マウスの行を先に、キーボードの行を後に並べる。
function constructionRows(coarse: boolean): readonly (HelpRow | null)[] {
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
    // キーボードの操作(coarse な環境では操作部品の名前で案内する)。
    dualRow(
      coarse, 'construction',
      [K.constructionRollLeft, K.constructionRollRight], '「左へ回す」「右へ回す」ボタン', '回転',
      `手に持ったもの・選択中のモジュールを接続軸まわりに回す `
        + `(${K.constructionRollLeft.label} = −90°、${K.constructionRollRight.label} = +90°)。`,
      '手に持ったもの・選択中のモジュールを接続軸まわりに −90° / +90° 回す。手元バーと、選択中のモジュール脇のメニューにある。',
    ),
    dualRow(
      coarse, 'construction',
      [K.constructionSwapEnds], '「向きを反転」ボタン', '向きを反転',
      '両端に取り付け面を持つモジュールの、どちらの端で付くかを入れ替える。',
    ),
    dualRow(
      coarse, 'construction',
      [K.constructionSymmetry], '対称数の切替', '対称配置',
      '新しく置くモジュールの対称数を 1 → 2 → 4 と切り替える。',
      '手元バーで、新しく置くモジュールの対称数を 1 → 2 → 4 と切り替える。',
    ),
    dualRow(
      coarse, 'construction',
      [K.constructionDuplicate], '「複製」ボタン', '複製',
      '選択中のモジュールの先端部を複製して手に取る。',
    ),
    dualRow(coarse, 'construction', [K.constructionRemove], '「撤去」ボタン', '撤去', '選択中のモジュールを先端部ごと撤去する。'),
    dualRow(
      coarse, 'construction', [K.constructionUndo], '「取り消し」ボタン', '取り消し',
      '直前の操作を取り消す。macOS では ⌘Z。',
      '直前の操作を取り消す。',
    ),
    dualRow(
      coarse, 'construction',
      [K.constructionRedo, K.constructionRedoAlt], '「やり直し」ボタン', 'やり直し',
      '取り消した操作をやり直す。macOS では ⇧⌘Z。',
      '取り消した操作をやり直す。',
    ),
    dualRow(
      coarse, 'construction',
      [
        K.constructionCategory1, K.constructionCategory2, K.constructionCategory3,
        K.constructionCategory4, K.constructionCategory5, K.constructionCategory6,
      ],
      'カテゴリタブ',
      'カテゴリ', 'カタログのカテゴリ(指令・燃料・推進・戦闘・設備・設計図)を選ぶ。',
    ),
    dualRow(
      coarse, 'construction', [K.constructionPlace], '「置く」ボタン', '置く',
      '手に持ったものを、選んでいる候補へ置く。',
      '手に持ったものを、選んでいる候補へ置く。候補をタップしても置ける。',
    ),
    dualRow(
      coarse, 'construction', [K.constructionFocus], '「視点を寄せる」ボタン', '視点',
      '選択中のモジュールへ視点を寄せる。選んでいなければ船体全体へ寄せる。',
    ),
    dualRow(coarse, 'construction', [K.help], 'ヘルプボタン', 'このヘルプ', '操作説明を開閉する。'),
    dualRow(coarse, 'construction', [K.pauseMenu], '「建造終了」ボタン', '建造を終える', '変更を残して建造を閉じる。'),
  ];
}
