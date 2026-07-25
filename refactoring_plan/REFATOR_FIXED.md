## 独自Vec3とTHREE.Vector3の責務境界
フローティングオリジンとは、GPUが巨大な数値を単精度で扱うことによる描画破綻を防ぐための措置で、CPU側で事前に平行移動して自機、カメラ付近の浮動小数精度を高めるためのものである。
フローティングオリジン補正前か補正後かを型安全に扱うため、これを独自Vec3とTHREE.Vector3の境界に一致させる。

独自Vec3は地球座標系の座標を扱う。
THREE.Vector3は、描画のための座標なので、フローティングオリジンを引いた後のもののみを扱う。
これらの変換は必ずFloatingOrigin型の変換関数を経由する

## physics、render、gameフォルダの責務境界
physicsフォルダはTHREEjsに依存しない部分のみ。純粋関数実装が多いが、THREE依存がなければ非純粋なクラスとかを置いても良い。
renderはTHREEjsに依存する部分のみ。逆に、上記のフローティングオリジン補正の問題により、独自Vec3座標は極力持ち込みたくない（
gameはその両方に依存する部分のみ。

## updateとsyncの責務境界
updateとsyncはgameフォルダ配下のモジュールの多くに存在する関数。
updateでは論理値の更新のみを行う。描画のためのTHREE.Sceneの更新への反映はsyncで行う。
THREE.sceneに反映されていれば、あとはrenderするだけで描画できる。

## ctx、context、opt、paramsなどといった引数は原則使わない。
STOP_USING_CTX.mdを参照。

## 「たまたま」同時に切り替わるフラグは別個にする
過去に同一視されていた例は以下のようなものがある。これらは、一つのフラグによって本質的に異なる多数の挙動が切り替わるものであり、責務の疎結合を妨げる。「たまたま」一致しているものは別個のフラグに分離する。
- planSystemのeditModeとcameraSystemのmapMode
- cameraSystemのcameraFrameとpredictSystemのframe

## GUIの所有者
> **GUI は、そのGUIが書き換える状態の所有者が持つ。所有者が1つに定まらないGUIは、GUIの方を分割する。**
> 表示・非表示も所有者が自分の sync で押し出す。
> GUIの見た目を維持することを制約にしない。

### 例外として扱ってよいもの
- `SettingsPanel`（BGM・一時停止・タイトルへ戻る）… **複数モジュールにまたがることが本質**の
  GUIなので、所有者を main.ts に置いたままでよい。`[Esc]` の配線が game.handleEdgePress にある点だけ
  E と同じ問題。
- `Hud.hint()` / `toast()` … 共有サービス（sfx と同型）。所有者の議論の対象外。
- `hud/context-menu.ts`・`hud/buttons.ts` … DOMとイベントだけを担う共有部品。状態を持たないので
  「所有者」を問う必要がない。この形は積極的に増やしてよい。
- HudPanels が `Game` を丸ごと受け取る — 最大の問題ではあるが、当面保留
`hud/panel.ts` の `HudPanels.update(game, dt)` は player / targeter / simulator / simSpeedManager /
activeStage / cameraSystem から chery-pick して4パネルを更新する。mapToolbar と同じ構造だが、
**全情報を集約表示することそのものに価値がある**GUIなので、Game を読むこと自体は問題としない。
分割すると、GUIクラスではなくゲームオブジェクトを担うのが責務である Player などに表示責務が
乗ってしまい、そちらの肥大化の方が高くつく。B/C（他モジュールを操作していた分）の切り離しは済んで
いるので、残りは「表示専用のまま Game を読む」形で許容する。

以下は将来もし着手するときの分割の当たり（現時点では実施しない）:
- SHIP STATUS の RCS制動・並進出力・微調整・進行方向ホールド・弾薬 → **Player** 所有。
- ORBIT（高度・速度・AP/PE・傾斜角・周期・動圧・機体温度）→ **Player**（軌道要素と thermal の所有者）。
- TARGET → **Targeter** 所有（ターゲット選択の所有者がその表示も持つ）。
- CONTACTS（敵一覧）→ **Simulator/Stage** 側。
- MET / TIME WARP / 視点のRCS追従 は所有者が別（simulator / simSpeedManager / chaseCamera）。
  **ここでGUIの方を切り直す** — 「SHIP STATUS」に混ざっている他所有者の行を、別の小パネルへ分けるか、
  所有者側のパネルへ移す。今回 toolbar で学んだのはまさにこの判断。
