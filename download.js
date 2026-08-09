const fs = require('fs');
const path = require('path');

const urls = {
  '8k_stars.jpg': 'https://www.solarsystemscope.com/textures/download/8k_stars_milky_way.jpg',
  '8k_moon.jpg': 'https://www.solarsystemscope.com/textures/download/8k_moon.jpg',
  '8k_clouds.jpg': 'https://www.solarsystemscope.com/textures/download/8k_earth_clouds.jpg',
};
for (const tile of ['A1','B1','C1','D1','A2','B2','C2','D2']) {
  urls[`earth_${tile}.jpg`] = `https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x21600x21600.${tile}.jpg`;
}

// src/assets/2k_{phobos,io,europa,ganymede,callisto,titan}.jpg は USGS Astrogeology の実写全球
// モザイク(単純円筒図法、パブリックドメイン)を `convert <tif> -type TrueColor -resize 2048x1024! -quality 85`
// で 2048×1024 の JPEG へ縮小したもの。元 TIFF(数百 MB)はリポジトリに含めない。取得元:
//   phobos:   https://planetarymaps.usgs.gov/mosaic/Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif
//   io:       https://planetarymaps.usgs.gov/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif
//   europa:   https://planetarymaps.usgs.gov/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif
//   ganymede: https://planetarymaps.usgs.gov/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif
//   callisto: https://planetarymaps.usgs.gov/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif
//   titan:    https://planetarymaps.usgs.gov/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif

async function download(name, url) {
  const dest = path.join(__dirname, 'src/assets', name);
  if (fs.existsSync(dest)) {
    console.log(`Skipping ${name}, already exists`);
    return;
  }
  console.log(`Downloading ${name}...`);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Unexpected response ${res.statusText}`);
      const destStream = fs.createWriteStream(dest);
      const reader = res.body.getReader();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        destStream.write(value);
      }
      destStream.end();
      console.log(`Finished ${name}`);
      return;
    } catch (e) {
      console.log(`Attempt ${attempt} failed for ${name}: ${e.message}`);
      if (attempt === 5) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  fs.mkdirSync(path.join(__dirname, 'src/assets'), { recursive: true });
  for (const [name, url] of Object.entries(urls)) {
    await download(name, url);
  }
}
main().catch(console.error);
