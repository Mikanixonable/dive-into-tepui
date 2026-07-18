import urllib.request
import os
import ssl
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

# Create context to bypass SSL verify if needed (Python on Windows sometimes lacks root certs)
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

os.makedirs('src/assets', exist_ok=True)

url = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x21600x10800.jpg'
path = 'src/assets/world_21k.jpg'

if not os.path.exists(path):
    print('Downloading 21k Earth image...')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx) as r, open(path, 'wb') as f:
        f.write(r.read())

print('Processing image...')
img = Image.open(path)
print(f'Original size: {img.size}')

# Resize to 24000x12000 to strictly exceed 8x the 8192x4096 (which is 8.6x area)
img = img.resize((24000, 12000), Image.Resampling.LANCZOS)
print(f'Resized to: {img.size}')

# Slice into 4 pieces
w, h = img.size
mid_w, mid_h = w // 2, h // 2

tiles = {
    'TL': (0, 0, mid_w, mid_h),
    'TR': (mid_w, 0, w, mid_h),
    'BL': (0, mid_h, mid_w, h),
    'BR': (mid_w, mid_h, w, h),
}

for name, box in tiles.items():
    tile_path = f'src/assets/earth_{name}.jpg'
    if not os.path.exists(tile_path):
        print(f'Saving {name}...')
        tile = img.crop(box)
        tile.save(tile_path, quality=85)

print('Done!')
