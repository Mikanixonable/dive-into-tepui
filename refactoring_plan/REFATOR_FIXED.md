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

## planSystemのeditModeとcameraSystemのmapMode、cameraSystemのcameraFrameとpredictSystemのframeなど、「たまたま」同時に切り替わるフラグは別個にする

## GUIは状態の所有者が持つ（toolbarの解体）
mapToolbar（predictSystemとmapCameraの両方を操作するなんでもGUI）を解体し、状態の所有者ごとに2枚のパネルへ分割した。

- `PredictPanel`（`#hud-predict`、画面下中央）… PredictSystem が所有。期間・予測軌道の座標系・未来位置スライダー。
- `MapViewPanel`（`#hud-mapview`、画面左上）… CameraSystem が所有。注視対象・視点の座標系・視点リセット。
- ボタンの実装は `hud/buttons.ts`（`SegmentedControl` / `hudButton`）に共通化。`hud/context-menu.ts` と同じ「DOMとイベントだけを担う共有部品」の位置づけ。

これに伴い、`cameraFrame`（視点を固定する座標系）と `trajectoryFrame`（予測軌道を描く座標系）をユーザーが独立に選べるようにした。

得られた原則:

1. **GUIは、そのGUIが書き換える状態の所有者が持つ。** 所有者が1つに定まらないGUIは、GUIの方を分割する。
2. パネルの表示・非表示も所有者の毎フレーム sync で押し出す。モード切替器（MapModeToggler）が各パネルを知る必要はない。
3. 「表示している値」を外から受け取って描くだけのパネルは、その値の所有者を外に晒す。`setState(a, b, c, d)` のような位置引数の詰め合わせは、その兆候。