// [H] で開閉する操作説明パネル。開閉状態は自身のフィールドで持ち、OverlayManager へ登録する。
import * as C from '../const';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { OverlayHandle, OverlayManager } from './overlay-manager';

const throttleKeyLabels = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax].map((k) => k.label).join(' / ');

// 操作方法テーブルの本文。タッチのジェスチャ合成(長押し=右クリック相当・二本指ドラッグ=パン・
// ピンチ=ズーム・ダブルタップ=フォーカス)はキーボード操作と対等な行として先頭にまとめ、
// タッチ端末でもここを見れば全操作に到達できるようにする。
function buildHelpTableHtml(): string {
  return `
    <h3>操作方法 [${K.help.label} で閉じる]</h3>
    <table>
      <tr><td class="key">長押し</td><td>右クリック相当 (プロパティウィンドウ・空域メニュー・ノードメニュー・ターゲット指定を開く)</td></tr>
      <tr><td class="key">二本指ドラッグ</td><td>カメラパン (中ボタンドラッグ相当)</td></tr>
      <tr><td class="key">ピンチ</td><td>カメラズーム (ホイール相当)</td></tr>
      <tr><td class="key">ダブルタップ</td><td>対象へフォーカスを移す (ダブルクリック相当)</td></tr>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-right:8px; vertical-align:middle;">
          <div>W</div><div>A S D</div>
        </div>
        /
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>↑</div><div>← ↓ →</div>
        </div>
      </td><td>並進 (前 / 後 / 左 / 右 / 上 / 下)<br><span style="font-size:var(--font-xs); color:var(--text-dim);">※ 上下は Q/E</span></td></tr>
      <tr><td class="key">
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; vertical-align:middle;">
          <div>I</div><div>J K L</div>
        </div>
        <div style="display:inline-block; text-align:center; line-height:1.2; font-family:monospace; margin-left:8px; vertical-align:middle;">
          <div>U O</div>
        </div>
      </td><td>回転 (ピッチ / ヨー / ロール)</td></tr>
      <tr><td class="key">${K.rcsDampToggle.label}</td><td>RCS 回転制動 ON/OFF</td></tr>
      <tr><td class="key">${K.progradeReset.label}</td><td>プログレード姿勢リセット (機首を進行方向へ即座に向ける)</td></tr>
      <tr><td class="key">${throttleKeyLabels}</td><td>並進出力の切替 (${C.THROTTLE_LABELS.join(' / ')})。並進 6 方向に共通で適用される</td></tr>
      <tr><td class="key">${K.fineAttitudeToggle.label}</td><td>姿勢微調整モード ON/OFF (角加速度・角速度を絞って小刻みに操作)</td></tr>
      <tr><td class="key">${K.progradeHoldToggle.label}</td><td>進行方向ホールド ON/OFF (機首をプログレード方向へ自動で向け続ける。手動回転で解除)</td></tr>
      <tr><td class="key">${K.radiatorDeployLeft.label} / ${K.radiatorDeployRight.label}</td><td>ラジエーター展開/収納 (左 / 右)</td></tr>
      <tr><td class="key">${K.followAttitudeToggle.label}</td><td>視点のRCS追従 ON/OFF (既定 ON: 視点が機体姿勢を基準に回転し、RCS操作と一体的に動く。OFF で軌道基準の独立視点になる)</td></tr>
      <tr><td class="key">${K.gunsightZoom.label} (長押し)</td><td>照準ズーム (機首方向を画面中心に拡大表示、自機は非表示になる)</td></tr>
      <tr><td class="key">右クリック (敵)</td><td>敵をターゲット固定 / 解除 (固定中はターゲット名が画面右上に表示される)</td></tr>
      <tr><td class="key">${K.targetSelect.label}</td><td>照準に近い敵をターゲット選択</td></tr>
      <tr><td class="key">▲AN / ▽DN マーカー</td><td>自機軌道とターゲット軌道面の交点。面変更(ノーマル/アンチノーマル)burn の目安位置</td></tr>
      <tr><td class="key">✦ マーカー</td><td>ターゲット位置に自機側を向けた仮想標的面を弾が通過した点。次弾の照準修正の目安</td></tr>
      <tr><td class="key">方向マーカー</td><td>軌道基準の6方向 (PRO/RET・NRM/ANM・OUT/IN) を示すマーカー。並進は機体基準なので、この6方向へ加速するには機首をマーカーへ向ける</td></tr>
      <tr><td class="key">${K.toggleMapMode.label}</td><td>軌道計画モード。地球中心ビューで数値積分した計画軌道(折れ線)をクリックしてノードを複数配置でき、再度 ${K.toggleMapMode.label} で確定(時間は進み続けるのでワープも可)</td></tr>
      <tr><td class="key">ノードのドラッグ</td><td>ノード上の丸ハンドルをドラッグすると、ポインタに最も近い軌道上の時刻へノードを移動する(小さな動きはドラッグでなくクリック=選択として扱う)</td></tr>
      <tr><td class="key">ノード位置の手動入力</td><td>選択中ノードの手動設定にある ΔT [s] へ、現在時刻からの秒数を入力して軌道上の位置を指定する。J2・大気抵抗・第三天体摂動を含む計画軌道上へ配置される</td></tr>
      <tr><td class="key">Δv 矢印ハンドル</td><td>選択中ノードの周囲に PRO/RET・NRM/ANM・OUT/IN の6ハンドルを表示。ドラッグした向きに応じて対応する Δv 成分を増減する(マップモード中のみ ${K.dvPrograde.label}/${K.dvRetrograde.label}・${K.dvNormal.label}/${K.dvAntinormal.label}・${K.dvRadialOut.label}/${K.dvRadialIn.label} キーでも同じ成分を調整可能、[${K.fineAttitudeToggle.label}] で微調整)</td></tr>
      <tr><td class="key">PREDICT パネル</td><td>マップモード下部。期間 = スライダーが指せる未来の長さ(1周回は現在の周期、双曲線等では1日にフォールバック)、スライダー = 期間内の任意の時刻へゴースト位置(⬡)を表示(0で非表示)</td></tr>
      <tr><td class="key">TRAJECTORY パネル</td><td>マップモード下部。軌道 = 計画軌道の折れ線を描く座標系</td></tr>
      <tr><td class="key">表示パネル</td><td>マップモード左上。天体・機体・星空、天球固定の黄道/赤道グリッド、3D空間に浮かぶ黄道面/赤道面/月軌道面の縮尺グリッドを切り替える(初期状態は閉じている。縮尺はズームに合わせて変化)</td></tr>
      <tr><td class="key">カメラ / 軌道フレームパネル</td><td>カメラの注視対象・回転系と、計画軌道の描画基準を別々に設定する。カメラパネルでは回転操作(クォータニオン/オイラー)、画角、画角リセット、透視/平行投影、黄道面・赤道面・月軌道面からの真上/真横視点も選べる</td></tr>
      <tr><td class="key">慣性系/太陽回転系</td><td>計画軌道とカメラの座標系はそれぞれ独立に選べる。太陽回転系では太陽方向が画面上でほぼ固定される(遷移計画の目安)</td></tr>
      <tr><td class="key">${K.autoWarpToNode.label}</td><td>直近のマニューバノードへ時間を自動加速(実行点の直前で自動解除)</td></tr>
      <tr><td class="key">右クリック</td><td>マップモード中、ノード近傍で右クリックするとコンテキストメニュー(この時刻まで自動ワープ / ノードを削除 / キャンセル)を開く。ノードが無い位置での右クリックや、開いたメニュー外への右クリックは閉じるだけ</td></tr>
      <tr><td class="key">${K.deleteNode.label}</td><td>マップモード中は選択中のノードを削除(右クリックメニューのフォールバック)、戦闘ビューでは計画全体を破棄</td></tr>
      <tr><td class="key">◆/▶NODE / ⬢BURN</td><td>直近のマニューバ実行点(▶は選択中)と噴射ガイド。BURN の方向へ加速し、噴射後の計画軌道に十分近づくとそのノードを達成として次のノードへ進む</td></tr>
      <tr><td class="key">オレンジの軌道線</td><td>ターゲットの軌道(自機軌道とほぼ重なる場合は上に重ねて描画)</td></tr>
      <tr><td class="key">弾薬 / ▣ AMMO</td><td>${C.MAG_ROUNDS}発でマガジン1連を消費(右舷のベルトから自動給弾)。残弾が少なくなると付近の軌道に補給が投入されるので、▣ マーカーへ接近して回収</td></tr>
      <tr><td class="key">${K.reload.label}</td><td>マニュアル装填(残弾のあるマガジンを捨てて新しい1連を装填)。決着後は同じステージで再出撃</td></tr>
      <tr><td class="key">${K.fire.label} / 右クリック</td><td>機関砲発射 (ワープ×${C.MAX_PHYS_SIM_SPEED}以下)。撃ち始めは起動音とともに一瞬遅れて連射開始</td></tr>
      <tr><td class="key">${K.warpSlower.label} / ${K.warpFaster.label}</td><td>時間加速 減 / 増</td></tr>
      <tr><td class="key">左ドラッグ / ホイール</td><td>カメラ回転 / 距離ズーム</td></tr>
      <tr><td class="key">矢印キー (${K.cameraYawLeft.label}${K.cameraYawRight.label}${K.cameraPitchUp.label}${K.cameraPitchDown.label})</td><td>マウスの代わりにキーボードで視点回転</td></tr>
      <tr><td class="key">${K.pauseMenu.label}</td><td>一時停止メニュー (設定 / タイトルへ戻る)</td></tr>
    </table>`;
}

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private _isOpen = false;

  constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    this.el = document.createElement('div');
    this.el.id = 'hud-help';
    this.el.className = 'panel';
    this.el.innerHTML = buildHelpTableHtml();
    root.appendChild(this.el);
  }

  get isOpen(): boolean { return this._isOpen; }

  handleInput(input: Input): void {
    if (input.takeKey(K.help)) this.toggle();
  }

  private toggle(): void {
    if (this._isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.el.style.display = 'block';
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    this.overlayManager.close('help');
  }

  contains(target: Node): boolean {
    return this.el.contains(target);
  }
}
