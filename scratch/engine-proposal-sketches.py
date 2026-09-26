#!/usr/bin/env python3
# 主推進器の造形改善案の側面プロポーション図。実寸(m)スケールで現行と3案を並べる。
import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle
import matplotlib.font_manager as fm

for f in fm.findSystemFonts(fontpaths=None, fontext="ttf"):
    if "Hiragino" in f or "NotoSansCJK" in f or "Noto Sans CJK" in f or "YuGothic" in f:
        fm.fontManager.addfont(f)
plt.rcParams["font.family"] = "Hiragino Sans"

R_T = math.sqrt(400_000 / (1.8 * 7.0e6) / math.pi)          # 喉半径 ≈ 0.1005
R_C = R_T * math.sqrt(6.0)                                  # 燃焼室半径 ≈ 0.246
R_E = R_T * math.sqrt(80.0)                                 # 出口半径 ≈ 0.899


def rao_len(r_t, eps, frac=0.8):
    h = math.radians(15.0)
    return frac * (r_t * (math.sqrt(eps) - 1) + 1.5 * r_t * (1 / math.cos(h) - 1)) / math.tan(h)


def rao_profile(r_t, z_t, r_e, z_e, th_n_deg=33, th_e_deg=9, n=32):
    th_n, th_e = math.radians(th_n_deg), math.radians(th_e_deg)
    arc = 0.382 * r_t
    pts = [(r_t + arc * (1 - math.cos(th_n * i / 5)), z_t - arc * math.sin(th_n * i / 5)) for i in range(6)]
    rn, zn = pts[-1]
    tn, te = math.tan(th_n), math.tan(th_e)
    zq = (r_e + te * z_e - rn - tn * zn) / (te - tn)
    rq = rn + tn * (zn - zq)
    for i in range(1, n + 1):
        t = i / n
        pts.append(((1 - t) ** 2 * rn + 2 * (1 - t) * t * rq + t * t * r_e,
                    (1 - t) ** 2 * zn + 2 * (1 - t) * t * zq + t * t * z_e))
    return pts


def conv_profile(r_t, z_t, r_c, z_top, th_deg=35, n=6):
    th = math.radians(th_deg)
    arc = 1.5 * r_t
    r_arc = r_t + arc * (1 - math.cos(th))
    z_arc = z_t + arc * math.sin(th)
    z_ct = z_arc + (r_c - r_arc) / math.tan(th)
    pts = [(r_c, z_top), (r_c, z_ct)]
    for i in range(n, -1, -1):
        a = th * i / n
        pts.append((r_t + arc * (1 - math.cos(a)), z_t + arc * math.sin(a)))
    return pts


def bell(r_t, r_c, z_top, eps=80):
    """燃焼室上端 z_top から出口までの内面輪郭 + exit_z"""
    th = math.radians(35)
    arc = 1.5 * r_t
    r_arc = r_t + arc * (1 - math.cos(th))
    z_arc = 0.0
    conv_len = arc * math.sin(th) + (r_c - r_arc) / math.tan(th)
    z_t = z_top - conv_len
    z_e = z_t - rao_len(r_t, eps)
    r_e = r_t * math.sqrt(eps)
    inner = conv_profile(r_t, z_t, r_c, z_top) + rao_profile(r_t, z_t, r_e, z_e)[1:]
    return inner, z_t, z_e


def poly(ax, pts, **kw):
    xs = [p[0] for p in pts] + [-p[0] for p in reversed(pts)]
    ys = [p[1] for p in pts] + [p[1] for p in reversed(pts)]
    ax.plot(xs, ys, **kw)


def seg(ax, r0, z0, r1, z1, **kw):
    ax.plot([r0, r1, -r1, -r0], [z0, z1, z1, z0], **kw)


def box(ax, cx, cz, w, h, color, label=None, fs=8, tc=None):
    import matplotlib.patches as mp
    ax.add_patch(mp.Rectangle((cx - w / 2, cz - h / 2), w, h, fc=color, ec="k", lw=0.6, alpha=0.85))
    if label:
        ax.annotate(label, (cx, cz), fontsize=fs, ha="center", va="center", color=tc or "k")


def ball(ax, cx, cz, r, color, label=None):
    ax.add_patch(Circle((cx, cz), r, fc=color, ec="k", lw=0.6, alpha=0.9))
    if label:
        ax.annotate(label, (cx, cz - r - 0.12), fontsize=7.5, ha="center", va="top")


def tube(ax, pts, r, color, lw=1.2):
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=lw, solid_capstyle="round")


C = dict(hull="#9aa4ae", dark="#4a5560", mli="#d9a821", pipe="#d7dde2", bell="#6b5c50",
         ext="#26262a", truss="#8f9aa4", copv="#3f7d94", gg="#7a6a55", valve="#5a6a75", clamp="#6a7a85")


def draw_current(ax):
    ax.set_title("現行: 6m 平板円盤 + 吊り下げ機械部\n(機械部 ≈0.9m / ベル 2.4m)", fontsize=10)
    seg(ax, 2.78, 0.30, 3.00, 0.50, color=C["dark"], lw=3)                      # 結合環
    seg(ax, 2.16, 0.405, 2.80, 0.455, color=C["hull"], lw=2.5)                  # 隔壁
    ax.plot([-2.7, -2.16, 2.16, 2.7], [0.42, 0.42, 0.42, 0.42], color=C["mli"], lw=1.5, ls="--")
    for sx in (-1, 1):                                                         # 支柱
        ax.plot([sx * 2.72, sx * 0.34, sx * 0.34], [0.30, -0.14, -0.30], color=C["truss"], lw=1.2)
    box(ax, 0, -0.14, 0.70, 0.16, C["dark"])                                     # ジンバル受け
    for sx in (-1, 1):
        ball(ax, sx * 1.65, -0.06, 0.40, C["copv"], "He COPV×4" if sx > 0 else None)
    box(ax, 0, -0.30, 0.34, 0.14, C["pipe"])                                     # ジンバル
    inner, z_t, z_e = bell(R_T, R_C, -0.44)
    poly(ax, [(r, z) for r, z in inner], color=C["bell"], lw=1.6)
    tube(ax, [(r + 0.045, z) for r, z in inner if z > -1.55], 0, C["gg"], 0.9)   # 冷却管束(再生部のみ)
    box(ax, -0.62, -0.70, 0.30, 0.55, C["dark"])                                 # TP
    box(ax, -0.40, -0.86, 0.16, 0.22, C["gg"])                                   # GG
    tube(ax, [(-0.62, -1.0), (-0.95, -1.4), (-1.02, -2.1)], 0, C["pipe"], 1.4)   # GG排気ダクト
    box(ax, -1.02, -2.18, 0.14, 0.16, C["ext"])
    tube(ax, [(1.95, 0.45), (1.95, -0.10), (0.56, -0.50), (0.30, -0.62)], 0, C["pipe"], 1.6)  # feedline
    ax.annotate("ジンバル支点", (0.28, -0.30), (-1.7, -0.62), fontsize=7.5,
                arrowprops=dict(arrowstyle="->", lw=0.6))


def draw_A(ax):
    ax.set_title("案A: 楕円ドーム + 逆円錐トラス推力構造\n(S-IVB/J-2 型, 機械部 ≈2.2m / ベル 2.4m)", fontsize=10)
    seg(ax, 2.78, 0.30, 3.00, 0.50, color=C["dark"], lw=3)                       # 結合環
    # 楕円ドーム(2:1): r3.0@z0.30 → r0@z-1.20
    dome = [(3.0 * math.cos(t), 0.30 - 1.50 * (1 - math.sin(t))) for t in
            [i * math.pi / 2 / 16 for i in range(17)]]
    poly(ax, dome, color=C["hull"], lw=2.2)
    ax.plot([d[0] for d in dome] + [-d[0] for d in reversed(dome)],
            [d[1] - 0.045 for d in dome] + [d[1] - 0.045 for d in reversed(dome)],
            color=C["mli"], lw=1.2, ls="--")                                     # MLI被覆
    for sx in (-1, 1):                                                           # 逆円錐トラス
        ax.plot([sx * 2.55, sx * 0.45], [0.05, -1.00], color=C["truss"], lw=1.5)
        ax.plot([sx * 2.30, sx * 0.45], [-0.45, -1.00], color=C["truss"], lw=1.0)
    seg(ax, 1.55, -0.42, 1.55, -0.42, color="none")
    for sx in (-1, 1):
        ball(ax, sx * 1.75, -0.28, 0.40, C["copv"], "He COPV×4" if sx > 0 else None)
        ax.plot([sx * 1.75, sx * 2.30], [-0.28, -0.06], color=C["clamp"], lw=1.0)  # ドームへの鞍
    seg(ax, 0.45, -1.06, 0.45, -1.06, color="none")
    box(ax, 0, -1.00, 0.90, 0.16, C["dark"])                                     # ジンバル受け
    box(ax, 0, -1.16, 0.34, 0.14, C["pipe"])                                     # ジンバル
    pivot = -1.16
    inner, z_t, z_e = bell(R_T, R_C * 1.35, pivot - 0.52)                        # 燃焼室を太く長く
    chamber_top = pivot - 0.52
    ax.plot([-R_C * 1.35, R_C * 1.35], [chamber_top, chamber_top], color=C["dark"], lw=2)
    poly(ax, inner, color=C["bell"], lw=1.6)
    box(ax, -0.72, -1.55, 0.34, 0.62, C["dark"], "FTP")                          # 燃料TP
    box(ax, 0.72, -1.55, 0.34, 0.62, C["dark"], "OTP")                           # 酸化剤TP
    box(ax, -0.44, -1.30, 0.18, 0.24, C["gg"], "GG")
    ball(ax, 0.42, -1.32, 0.22, C["copv"], "スタート\nタンク")
    box(ax, 0.30, -1.78, 0.20, 0.26, C["valve"], "MFV")
    box(ax, -0.30, -1.78, 0.20, 0.26, C["valve"], "MOV")
    # タービン排気 → ベル途中の環状マニフォールド(フィルム冷却)
    r_man = [r for r, z in inner if -2.55 < z < -2.45][0] + 0.10
    tube(ax, [(-0.72, -1.9), (-r_man, -2.2)], 0, C["pipe"], 1.6)
    seg(ax, r_man, -2.52, r_man, -2.42, color=C["gg"], lw=4)
    ax.annotate("排気マニフォールド\n(延長部のフィルム冷却)", (r_man, -2.47), (1.5, -2.9), fontsize=7.5,
                arrowprops=dict(arrowstyle="->", lw=0.6))
    tube(ax, [(2.2, 0.30), (2.2, -0.55), (0.75, -0.95), (0.72, -1.25)], 0, C["pipe"], 1.6)  # feed
    box(ax, 1.35, -0.85, 0.26, 0.30, C["valve"], "制御\nPkg")
    ax.annotate("逆円錐トラス\n(推力構造)", (1.55, -0.50), (1.9, -1.35), fontsize=7.5,
                arrowprops=dict(arrowstyle="->", lw=0.6))


def draw_B(ax):
    ax.set_title("案B: 6m→2.4m ボートテイル・スカート\n(開口から機械部が覗く, ≈2.1m / ベル 2.4m)", fontsize=10)
    seg(ax, 2.78, 0.30, 3.00, 0.50, color=C["dark"], lw=3)
    poly(ax, [(3.00, 0.30), (3.02, -0.30), (2.55, -1.10), (1.30, -1.70)], color=C["hull"], lw=2.2)  # 円錐スカート
    seg(ax, 1.30, -1.74, 1.30, -1.66, color=C["dark"], lw=3)                     # 下端環
    for zx in (-0.35, -1.05):
        rr = { -0.35: 2.93, -1.05: 2.60 }[zx]
        seg(ax, rr, zx, rr + 0.03, zx - 0.03, color=C["dark"], lw=1.4)           # スカート帯
    for sx in (-1, 1):                                                           # 内部フレーム
        ax.plot([sx * 2.6, sx * 0.40], [0.0, -1.45], color=C["truss"], lw=1.3)
        ax.plot([sx * 1.9, sx * 0.40], [-0.75, -1.45], color=C["truss"], lw=1.0)
    box(ax, 0, -1.45, 0.80, 0.15, C["dark"])
    box(ax, 0, -1.60, 0.32, 0.13, C["pipe"])
    for sx in (-1, 1):
        ball(ax, sx * 2.05, -0.20, 0.38, C["copv"], "He COPV×4" if sx > 0 else None)
    pivot = -1.60
    inner, z_t, z_e = bell(R_T, R_C * 1.2, pivot - 0.45)
    poly(ax, inner, color=C["bell"], lw=1.6)
    box(ax, -0.65, -1.95, 0.32, 0.55, C["dark"], "FTP")
    box(ax, 0.65, -1.95, 0.32, 0.55, C["dark"], "OTP")
    box(ax, -0.40, -1.72, 0.16, 0.22, C["gg"], "GG")
    box(ax, 0.28, -2.15, 0.20, 0.24, C["valve"], "MFV")
    box(ax, -0.28, -2.15, 0.20, 0.24, C["valve"], "MOV")
    tube(ax, [(-0.65, -2.25), (-0.95, -2.8), (-0.98, -3.5)], 0, C["pipe"], 1.5)  # GG排気(下向き独立)
    box(ax, -0.98, -3.6, 0.15, 0.16, C["ext"])
    tube(ax, [(2.4, 0.30), (2.4, -0.8), (0.8, -1.5), (0.65, -1.68)], 0, C["pipe"], 1.6)
    box(ax, 1.75, -0.9, 0.26, 0.30, C["valve"], "制御\nPkg")
    ax.annotate("円錐スカート(ボートテイル)", (2.9, -0.55), (1.2, -0.72), fontsize=7.5,
                arrowprops=dict(arrowstyle="->", lw=0.6))


def draw_C(ax):
    ax.set_title("案C: 浅ドーム + 露出パワーヘッド塊\n(RS-25 型, 機械部 ≈1.9m / ベル 2.4m)", fontsize=10)
    seg(ax, 2.78, 0.30, 3.00, 0.50, color=C["dark"], lw=3)
    dome = [(3.0 * math.cos(t), 0.30 - 0.85 * (1 - math.sin(t))) for t in
            [i * math.pi / 2 / 16 for i in range(17)]]
    poly(ax, dome, color=C["hull"], lw=2.2)
    for sx in (-1, 1):                                                           # 太いアウトリガー4本(投影2)
        ax.plot([sx * 1.7, sx * 0.55], [-0.15, -0.75], color=C["dark"], lw=5, solid_capstyle="round")
        ball(ax, sx * 1.95, -0.05, 0.34, C["copv"], "He COPV×4" if sx > 0 else None)
    box(ax, 0, -0.75, 1.10, 0.30, C["dark"])                                     # ジンバル受け兼マニフォールド上板
    box(ax, 0, -0.95, 0.40, 0.16, C["pipe"])                                     # ジンバル
    box(ax, 0, -1.45, 0.80, 0.90, C["gg"], "HGM/燃焼室頭部")                     # ホットガスマニフォールド
    box(ax, -0.78, -1.50, 0.36, 0.72, C["dark"], "FTP")
    box(ax, 0.78, -1.50, 0.36, 0.72, C["dark"], "OTP")
    box(ax, -0.50, -1.05, 0.20, 0.26, C["bell"], "プリバーナ")
    box(ax, 0.50, -1.05, 0.20, 0.26, C["bell"], "プリバーナ")
    for sx in (-1, 1):
        box(ax, sx * 0.30, -2.02, 0.18, 0.24, C["valve"], "MFV" if sx < 0 else "MOV")
    box(ax, 1.25, -1.15, 0.24, 0.30, C["valve"], "制御\nPkg")
    pivot = -0.95
    inner, z_t, z_e = bell(R_T, R_C * 1.5, -1.95)                                # 短い燃焼室→すぐベル
    poly(ax, inner, color=C["bell"], lw=1.6)
    tube(ax, [(0.78, -1.86), (0.9, -2.2)], 0, C["pipe"], 1.6)
    r_man = [r for r, z in inner if -2.75 < z < -2.65][0] + 0.10
    tube(ax, [(0.9, -2.2), (r_man, -2.5)], 0, C["pipe"], 1.6)
    seg(ax, r_man, -2.72, r_man, -2.62, color=C["gg"], lw=4)
    ax.annotate("排気→ベル内へ\n(フィルム冷却)", (r_man, -2.67), (1.4, -3.3), fontsize=7.5,
                arrowprops=dict(arrowstyle="->", lw=0.6))
    tube(ax, [(2.3, 0.28), (2.3, -0.5), (1.05, -0.85), (0.78, -1.14)], 0, C["pipe"], 1.6)


fig, axes = plt.subplots(1, 4, figsize=(23, 10), sharey=True)
for ax, fn in zip(axes, (draw_current, draw_A, draw_B, draw_C)):
    fn(ax)
    ax.axhline(0, color="#888", lw=0.4)
    ax.axvline(0, color="#ccc", lw=0.4, ls=":")
    ax.set_xlim(-3.6, 3.6)
    ax.set_ylim(-5.2, 1.0)
    ax.set_aspect("equal")
    ax.set_xticks(range(-3, 4))
    ax.set_yticks(range(-5, 1))
    ax.grid(True, lw=0.25, alpha=0.4)
    ax.tick_params(labelsize=7)
axes[0].set_ylabel("z [m] (+前方 / 排気は下)", fontsize=9)
fig.suptitle("主推進器 造形改善案 — 全パネル同スケール(グリッド 1m)。 z=0.5 が前方接続面、 z=-0.5 が現モジュール後端", fontsize=12)
fig.tight_layout(rect=[0, 0, 1, 0.96])
fig.savefig("/Users/pandeaconica/lab/dive-into-tepui/scratch/engine-proposal-sketches.png", dpi=150)
print("done")
