#!/usr/bin/env python3
# 生成気象の焼き出し(.cloud-detail/regime/generated-weather/h<NNNN>.f32)を
# 正距円筒 720x360 のチャンネル面としてプロットする。
# 使い方: python3 tools/cloud-regime-plot.py [時刻h=180] [出力先=.cloud-detail/regime/plots]
#   出力: plots/front-map-t<時刻>.png — pressure / band / lift / coverage /
#   coverage+band等値線+気圧谷 / cumulusTopM の 2x3 図。
# 依存: python3 + numpy + matplotlib (matplotlib は Japanese フォント無し→英語ラベル)。
import json, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = '.cloud-detail/regime'
hour = int(sys.argv[1]) if len(sys.argv) > 1 else 180
out = sys.argv[2] if len(sys.argv) > 2 else f'{root}/plots'
man = json.load(open(f'{root}/generated-weather/manifest.json'))
W, H, ch = man['width'], man['height'], man['channels']
d = np.fromfile(f'{root}/generated-weather/h{hour:04d}.f32', dtype='<f4').reshape(len(ch), H, W)
f = {c: d[i] for i, c in enumerate(ch)}
lat = np.linspace(90, -90, H); lon = np.linspace(-180, 180, W)

fig, axes = plt.subplots(2, 3, figsize=(19, 9))
def show(ax, v, title, cmap='viridis', vmin=None, vmax=None):
    im = ax.imshow(v, extent=[-180, 180, -90, 90], cmap=cmap, vmin=vmin, vmax=vmax, aspect='auto')
    ax.set_title(title); fig.colorbar(im, ax=ax, shrink=0.8)

show(axes[0,0], f['pressure'], 'pressure (cyclone troughs, hPa anomaly)', 'RdBu_r')
show(axes[0,1], f['band'], 'band (frontal band 0..1)', 'magma', 0, 1)
show(axes[0,2], f['lift'], 'lift (upward motion)', 'RdBu_r')
show(axes[1,0], f['coverage'], 'coverage (cumulus cover)', 'gray', 0, 1)
ax = axes[1,1]
ax.imshow(f['coverage'], extent=[-180,180,-90,90], cmap='gray', vmin=0, vmax=1, aspect='auto')
ax.contour(lon, lat, f['band'], levels=[0.3,0.6,0.9], colors=['cyan'], linewidths=0.8)
ax.contour(lon, lat, f['pressure'], levels=[-25,-15,-8,-3], colors=['red'], linewidths=0.7)
ax.set_title('coverage + band contours (cyan) + pressure lows (red)')
show(axes[1,2], f['cumulusTopM']/1000, 'cumulusTopM (cloud top km)', 'viridis')
plt.tight_layout()
import os; os.makedirs(out, exist_ok=True)
plt.savefig(f'{out}/front-map-t{hour}.png', dpi=110)
print(f'saved {out}/front-map-t{hour}.png')
