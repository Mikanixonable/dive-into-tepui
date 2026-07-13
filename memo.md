
1. レンダリング技術: WebGLベースなら Three.js か Babylon.js(いずれもローポリ表現・ポストプロセス〈オーロラのようなグロー表現〉が得意)、もっと作り込むなら WebGPU も視野。フレームワーク色を薄くしたいなら素のWebGL+自前エンジンも選択肢だが工数が跳ねる。
2. 言語/ビルド: TypeScript + Vite が現状の定番(型安全性、軌道計算のような数値コードでバグを減らせる)。
3. 物理・軌道計算の実装方針: 自前でN体シミュレーション(RK4/RKF45などの数値積分器)を書くか、既存の天体力学ライブラリ(例: satellite.js は地球周回限定で三体問題には力不足)を使うか。三体問題・ラグランジュ点・ハロー軌道まで扱うなら、ほぼ自前実装が必須になりそう。
4. 物理エンジン(衝突・破片): 見た目フ効果込み)なら剛体回転を自前で解く必要があり、汎用物理エンジン(Rapier/Cannon-esque)だけでは不十分な可能性。                       5. ゲームループ/アーキテクチャ: ECSを採用するか、シンプルなオブジェクト指向にするか。宇宙船・弾・破片・地球大気などエンティティ種が多いのでECSと相性は良さそう。       6. 状態管理・UI層: HUD やマニューバM/Canvas overlay か React/Vueを被せるか)。                                                                                   7. マルチプレイの有無:シューティングがCPU対戦のみか対人戦もあるか(あるならネットコード同期の設計が変わる)。           8. 配信形態: 静的ホスティングのみか、マッチメイキング等)が要るか。
                                                                                                最初に決めるべき優先度が高いのは (3)ECS採用可否 です。ここが後の全設計(データ構造、レンダリングとの結合方法)を左右します。個人的な推奨は「TypeScript + Vite + Three.js + 自前ECS + 自前RK4積分器」という組 形態(シングルプレイ想定か)を確定させたいです。どこから詰めますか？

                                                                            
---
# Geminiによる実現可能性調査
結論から言うと、**十分に作成可能**です。

現在のブラウザ環境（特にJavaScriptエンジンとWebGL/WebGPU）は非常に強力であり、ハードSF的なアプローチが求められる複雑な軌道力学のシミュレーションをブラウザ上でリアルタイムに動かすことができます。月面開発のロジスティクスや、L1/L2ラグランジュ点を利用した物資輸送シミュレーションなどを表現するには非常に面白いテーマです。

実現に向けてクリアすべき、3つの技術的な柱とその実装方針を解説します。

## 1. 軌道計算（物理エンジン）の要件

L1、L2のようなラグランジュ点周辺の軌道（ハロー軌道やリサジュー軌道）は力学的に非常に不安定（カオス的）です。わずかな誤差があっという間に拡大するため、自作の物理エンジンの精度がゲームのコアになります。

* **太陽の摂動（N体問題）:**
地球、月、宇宙船の制限3体問題に、太陽の重力を加えた「4体問題」として計算します。各天体からの重力加速度は以下の式で合成します。

$$\mathbf{a}_i = \sum_{j \neq i} G \frac{m_j}{\vert{}\mathbf{r}_{ij}\vert{}^3} \mathbf{r}_{ij}$$


* **自転の潮汐力（非球形重力場）:**
自転による天体の歪み（赤道ふくらみ）が軌道に与える影響は、「J2摂動」として実装します。極軌道や低軌道（LEO）での軌道面歳差運動をシミュレートするのに不可欠です。
* **大気抵抗（Atmospheric Drag）:**
L1やL2（地球から約38万km）の距離では完全に無視できますが、地球や月の近傍でのエアロキャプチャーや打ち上げを想定するなら必須です。高度に応じた大気密度モデル（単純な指数関数モデルなど）を用意し、以下の式を組み込みます。

$$F_D = \frac{1}{2} \rho v^2 C_D A$$



**【計算手法の選択】**
単純なオイラー法ではすぐに軌道が破綻します。最低でも**4次のルンゲ＝クッタ法（RK4）**、より長期の安定性を求めるなら**シンプレクティック積分**（Verlet法など）を採用する必要があります。JavaScriptは標準で64ビット浮動小数点数（Double精度）をサポートしているため、位置座標の計算自体の精度はブラウザでも十分に確保できます。

## 2. 推奨される技術スタック

UIの構築や状態管理の観点から、モダンなWebフロントエンド技術を活用するのが最もスムーズです。

| コンポーネント | 推奨技術 | 理由 |
| --- | --- | --- |
| **UI・状態管理** | React + React Three Fiber | 複雑な計器類のUIと、3D空間上のオブジェクトの状態同期が容易なため。 |
| **3D描画** | Three.js (WebGL/WebGPU) | 宇宙空間のライティングや地球の大気シェーダーなどの実装実績が豊富。 |
| **物理演算** | Web Workers (JS/TS) | 重い積分計算を別スレッドに逃がし、UI描画（60FPS）のブロックを防ぐため。 |

※さらに計算速度が必要になった場合は、物理演算部分のみをRust等で記述し、**WebAssembly (Wasm)** としてブラウザに読み込ませる拡張も可能です。

## 3. 開発における最大の壁

ゲームとして成立させる場合、以下の2つの問題に直面します。

1. **タイムワープ機能の実装:**
月まで数日かかるため、ゲーム内時間を1000倍などに加速させる必要があります。単純に1フレームあたりの時間ステップ（$\Delta t$）を大きくすると計算が爆発して宇宙船が地球を突き抜けます。Dormand-Prince法などの「刻み幅制御付きルンゲ＝クッタ法」を用いて、天体に近づいた時だけ自動的に計算の解像度を上げる工夫が必要です。
2. **極端なスケール差（Zファイティング）:**
地球（半径約6,400km）から宇宙船（数メートル）までを描画しようとすると、通常の深度バッファでは精度が足りず、テクスチャがチラつく「Zファイティング」が発生します。Three.jsで `logarithmicDepthBuffer: true` を有効に設定することが必須となります。


---

# Geminiによる要約
Listed directory dive-into-tepui
Viewed README.md:1-95
Viewed package.json:1-24
Listed directory src
Listed directory physics
Listed directory render
Listed directory game
Listed directory types
Viewed CLAUDE.md:1-68

このプロジェクト **`dive-into-tepui`** は、**地球低軌道（LEO）を舞台にした、リアルな軌道力学に基づく3Dシューティングゲーム**です。

技術的には、**TypeScript + Three.js（WebGPUレンダラー）**で構築されており、本格的な宇宙シミュレーター（Kerbal Space Programのようなシステム）とシューティングゲームの要素を融合させています。

以下にプロジェクトの主要な特徴、アーキテクチャ、およびコード構成について解説します。

---

### 1. 主な機能と特徴

*   **リアルな軌道力学のシミュレーション**
    *   RK4（ルンゲ・クッタ4次）数値積分を用いて、自機や敵機、薬莢、デブリ（破片）の軌道を計算しています。
    *   単なる二体問題だけでなく、**地球の扁平率による影響（J2摂動）**、**太陽や月による潮汐力（第三体摂動）**、**大気抗力（高度による密度変化と減速）**などをシミュレートしています。
*   **本格的な宇宙船の操作とナビゲーション**
    *   **RCS（姿勢制御システム）**による3軸姿勢制御（ピッチ・ヨー・ロール）および並進移動（前進・後退・左右・上下）。
    *   `[C]` キーによる**進行方向（Prograde）の自動維持（オートパイロット）**。
    *   画面下部中央に、宇宙船の姿勢を示す **ナビボール（Navball）** を描画。
*   **軌道計画マップモード (`[M]`キー)**
    *   地球を俯瞰するマップ画面に切り替えることができ、プレイヤーの軌道をクリックして**マニューバーノード（軌道変更計画）**を作成できます。
    *   WASDQEキーで必要速度変化（$\Delta v$）を調整し、軌道遷移の計画を立ててタイムワープで自動移動する機能があります。
*   **大気圏突入と熱シミュレーション**
    *   高度が下がると大気密度が上がって軌道が減衰します。
    *   大気摩擦によって機体が加熱され（サットン・グレイブス式）、放射冷却とのバランスで熱が計算されます。耐熱限界を超えると大気圏で燃え尽きてゲームオーバーになります。
*   **物理ベースのディテール**
    *   発砲すると薬莢が排出され、慣性で漂います。宇宙船が破壊されると破片が散らばり、非対称コマの特有の回転運動である **ジャニベコフ効果（テニスラケットの定理）** に基づいてスピンします。
    *   弾薬ベルトが宇宙船の挙動（推進加速度、回転時の遠心力・コリオリ力など）に応じてリアルに揺れる物理シミュレーション（Position-Based Dynamics）を搭載しています。
*   **WebAudioによるBGMと効果音**
    *   音声ファイルを読み込むのではなく、シンセサイザーの波形生成によってBGM（ミニマル・ミュージック風）やCIWSの射撃音・モーター音などをリアルタイム合成しています。

---

### 2. ディレクトリ・コード構成

主要なコードは `src/` ディレクトリ配下に分類されています。

*   **`src/`**
    *   [main.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/main.ts) — エントリーポイント。WebGPU の初期化、描画ループ（`requestAnimationFrame`）と `Game.update` の呼び出し。
    *   **[game/](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/)** (ゲームロジック)
        *   [game.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/game.ts) — ゲームの司令塔。エンティティ（自機、敵機、弾、デブリ）の更新、入力処理、衝突判定、オートパイロット制御。
        *   [hud.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/hud.ts) — 画面上に表示される HUD（高度、速度、ターゲット情報など）の描画。
        *   [navball.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/navball.ts) — 2D Canvasを使ったナビボール計器の描画。
        *   [audio.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/game/audio.ts) — WebAudioによる動的サウンド合成。
    *   **[physics/](file:///Users/pandeaconica/lab/dive-into-tepui/src/physics/)** (物理・軌道計算)
        *   [orbital.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/physics/orbital.ts) — 万有引力、J2摂動、潮汐摂動、マニューバー軌道予測計算。
        *   [attitude.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/physics/attitude.ts) — 剛体の姿勢角（クォータニオン）と角速度の統合計算（ジャニベコフ効果を維持するアルゴリズム）。
        *   [atmosphere.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/physics/atmosphere.ts) — 高度ごとの大気密度モデル。
        *   [ephemeris.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/physics/ephemeris.ts) — 太陽と月の軌道位置（暦）の計算。
    *   **[render/](file:///Users/pandeaconica/lab/dive-into-tepui/src/render/)** (3D描画)
        *   [earth.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/render/earth.ts) — 地球の 3D メッシュ（fBmノイズによる自動生成）、大気のグラデーションシェル、オーロラ。
        *   [ships.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/render/ships.ts) — 自機や敵機、薬莢、デブリ、弾薬ベルトなどのローポリメッシュ構築。
        *   [orbitline.ts](file:///Users/pandeaconica/lab/dive-into-tepui/src/render/orbitline.ts) — 自機やターゲットの軌道予測線の描画。

---

### 3. 特殊な描画アプローチ：「フローティング・オリジン (Floating Origin)」

広大な宇宙空間（地球低軌道）を float32（単精度浮動小数点数）で描画しようとすると、座標値が大きくなりすぎてジッター（グラフィックスのがたつき）が発生します。
このゲームでは、**プレイヤー宇宙船を常にワールド座標の原点 `(0, 0, 0)` に固定**し、地球や敵機などのすべてのオブジェクトをプレイヤーからの相対位置に毎フレーム配置し直す「フローティング・オリジン」アプローチを採用しています。これにより、カメラ付近の描画精度を極限まで保っています。

---

### 4. 実行コマンド

開発や動作確認には以下のコマンドを使用します（[package.json](file:///Users/pandeaconica/lab/dive-into-tepui/package.json) より）：

*   **開発サーバー起動**: `npm run dev` (Webpack デブサーバーが `http://localhost:8080` で起動します)
*   **プロダクションビルド**: `npm run build` (`dist/` ディレクトリに最適化されたJSとHTMLが出力されます)
*   **型チェック**: `npm run typecheck` (`tsc` による型エラーの静的検証)

※ WebGPUを使用しているため、動作確認には **Chrome や Edge などの WebGPU 対応ブラウザ** が必要です。

より詳細なゲーム仕様については [README.md](file:///Users/pandeaconica/lab/dive-into-tepui/README.md) または開発上のガイダンスが書かれた [CLAUDE.md](file:///Users/pandeaconica/lab/dive-into-tepui/CLAUDE.md) もあわせてご参照ください。