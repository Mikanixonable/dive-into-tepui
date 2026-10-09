import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import {
  CORRECTION_DISPLAY, captureGroups, correctionPng, initStats, spreadPng, stabilizeExposure,
} from './screen-space-blind-capture.mjs';
import { seedOf } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputDir = path.join(root, '.render-lab-shots', 'ssd-8-blind');
const imageDir = path.join(outputDir, 'images');
const workDir = path.join(outputDir, 'work');
const port = 8773;
const debugPort = 9450;
const scenes = [
  { id: 'bay-dark', caseName: 'bay', shotName: 'bay-dark' },
  { id: 'bay-earth-open', caseName: 'bay', shotName: 'bay-earth-open' },
  { id: 'cornell-box', caseName: 'cornell-box', shotName: 'cornell-box' },
];
const configs = {
  low: {
    band: { slices: 16, paths: 1 }, q: { slices: 20, paths: 1, sparseTapCount: 8 },
    'raw-quarter': { slices: 22, paths: 1 }, 'raw-full': { slices: 1, paths: 1 },
  },
  medium: {
    band: { slices: 6, paths: 2 }, q: { slices: 8, paths: 2, sparseTapCount: 8 },
    'raw-quarter': { slices: 9, paths: 2 }, 'raw-full': { slices: 2, paths: 1 },
  },
  high: {
    band: { slices: 7, paths: 4 }, q: { slices: 9, paths: 4, sparseTapCount: 8 },
    'raw-quarter': { slices: 11, paths: 4 }, 'raw-full': { slices: 4, paths: 1 },
  },
};
const variantOrder = ['band', 'q', 'raw-quarter', 'raw-full'];
const symbols = ['K', 'M', 'R', 'V'];
const displayTransform = process.argv.includes('--cpu-display')
  ? CORRECTION_DISPLAY.cpu : CORRECTION_DISPLAY.gpu;
const keyPath = path.join(workDir, 'keys', 'key.json');
const key = JSON.parse((await import('node:fs')).readFileSync(keyPath, 'utf8'));
const viewerDataPath = path.join(outputDir, 'viewer-data.json');
const viewerTemplatePath = path.join(root, 'tools', 'render-lab', 'ssd-blind-viewer.html');
const viewerHtmlPath = path.join(outputDir, 'index.html');
const timingsPath = path.join(workDir, 'capture-timings.json');
const convergencePath = path.join(workDir, 'convergence.json');
const displayManifestPath = path.join(workDir, 'display-manifest.json');
const initialViewerData = existsSync(path.join(outputDir, 'viewer-data.json'))
  ? JSON.parse(readFileSync(path.join(outputDir, 'viewer-data.json'), 'utf8')) : {};
const pngs = initialViewerData.pngs ?? [];
const viewerSets = initialViewerData.sets ?? [];
const timings = existsSync(timingsPath) ? JSON.parse(readFileSync(timingsPath, 'utf8')).timings ?? [] : [];
const convergence = existsSync(convergencePath) ? JSON.parse(readFileSync(convergencePath, 'utf8')).convergence ?? [] : [];
const warmupFrames = 3;
const sampleFrames = 8;
const independentSamples = 8;

function saveViewerData() {
  const data = {
    scenes: scenes.map(scene => scene.id), budgets: ['low', 'medium', 'high'], symbols,
    sets: viewerSets, pngs: pngs.map(({ displayTransform: _transform, ...image }) => image),
  };
  writeFileSync(viewerDataPath, JSON.stringify(data, null, 2) + '\n');
  const privateImages = pngs.map((image) => {
    const set = viewerSets.find((item) => item.referenceId === image.stimulusId
      || Object.values(item.candidates).includes(image.stimulusId));
    const variant = set === undefined ? null
      : Object.entries(set.candidates).find(([, id]) => id === image.stimulusId)?.[0] ?? null;
    const assigned = set === undefined ? null : key.assignments.find((item) => item.scene === set.scene && item.budget === set.budget);
    const variantName = set === undefined || variant === null ? null : assigned?.bySymbol[variant]?.variant ?? null;
    const transform = image.displayTransform ?? (image.view === 'B' || set?.scene === 'cornell-box'
      ? CORRECTION_DISPLAY.gpu : CORRECTION_DISPLAY.cpu);
    return { scene: set?.scene ?? null, budget: set?.budget ?? null, variant: variantName,
      stimulusId: image.stimulusId, view: image.view, exposureFactor: image.exposureFactor, transform };
  });
  writeFileSync(displayManifestPath, JSON.stringify({ images: privateImages }, null, 2) + '\n');
  const embedded = JSON.stringify(data).replace(/</g, '\\u003c');
  const template = readFileSync(viewerTemplatePath, 'utf8');
  writeFileSync(viewerHtmlPath, template.replace('__VIEWER_DATA__', embedded));
}
function saveWorkData() {
  writeFileSync(timingsPath, JSON.stringify({ timings }, null, 2) + '\n');
  writeFileSync(convergencePath, JSON.stringify({ convergence }, null, 2) + '\n');
}
function replaceBy(items, item, keyOf) {
  const key = keyOf(item);
  const index = items.findIndex((existing) => keyOf(existing) === key);
  if (index < 0) items.push(item);
  else items[index] = item;
}
function sceneIsComplete(sceneId) {
  const sceneSets = viewerSets.filter((set) => set.scene === sceneId);
  if (sceneSets.length !== 3) return false;
  const requiredViews = ['first','second','mean','deviation0','deviation1','variance'];
  return sceneSets.every((set) => {
    const ids = [...Object.values(set.candidates), set.referenceId];
    return ids.every((stimulusId, index) => {
      const views = index === ids.length - 1 ? ['B'] : requiredViews;
      return views.every((view) => {
        const image = pngs.find((entry) => entry.stimulusId === stimulusId && entry.view === view);
        return image !== undefined && Number.isFinite(image.exposureFactor)
          && existsSync(path.join(outputDir, image.path));
      });
    });
  });
}

function tierOf(variant, slices) {
  return { scale: variant === 'raw-full' ? 1 : 0.25, sliceCount: slices, stepCount: 5,
    bandCount: variant === 'band' ? 4 : 1, bandScale: 0.75 };
}
function rowsOf(measurement) {
  return Object.fromEntries(Object.entries(measurement.gpuPassMsById)
    .filter(([id]) => id.startsWith('nearbyDiffuse')).map(([id, value]) => [id, value.p50]));
}
function totalOf(rows) { return Object.values(rows).reduce((a, b) => a + b, 0); }
function rotate(values, n) { const k = n % values.length; return [...values.slice(k), ...values.slice(0, k)]; }
function symbolFor(set, variant) {
  const found = Object.entries(set.bySymbol).find(([, item]) => item.variant === variant);
  if (found === undefined) throw new Error(`missing blind symbol for ${variant}`);
  return found[0];
}
async function setVariant(devTools, variant, slices, sparseTapCount = 8) {
  await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null)');
  await devTools.evaluate(`window.renderLab.setScreenSpaceExperiment(${JSON.stringify(variant)}, ${JSON.stringify(tierOf(variant, slices))}, ${sparseTapCount})`);
}
async function checkSignedDisplay(devTools) {
  const values = await devTools.evaluate(`(() => {
    const rgba = Float32Array.from([-0.25, 0, 0.25, 1, 1, 1, 1, 0]);
    const display = window.renderLab.signedCorrectionDisplay({ width: 2, height: 1, rgba });
    return [display.rgba[0], display.rgba[1], display.rgba[2],
      display.rgba[4], display.rgba[5], display.rgba[6]];
  })()`);
  if (!(values[0] < 0.5 && values[1] === 0.5 && values[2] > 0.5
    && values[3] === 0 && values[4] === 0 && values[5] === 0)) {
    throw new Error(`signed correction display check failed: ${JSON.stringify(values)}`);
  }
  return { negative: values[0], zero: values[1], positive: values[2], transparent: values.slice(3) };
}
async function compareSignedDebugCapture(devTools) {
  await devTools.evaluate('window.renderLab.setTarget("correction")');
  const exposureStability=await stabilizeExposure(devTools);
  const result = await devTools.evaluate('window.renderLab.captureCorrectionProbe()');
  await devTools.evaluate('window.renderLab.setTarget("off")');
  result.exposureStability=exposureStability;
  const { capture, signed, ...metrics } = result;
  if (metrics.meanAbsoluteError > 2 / 255) throw new Error(`debug signed display mismatch: ${JSON.stringify(metrics)}`);
  return metrics;
}
async function measureSet(devTools, scene, budget, side, round, order) {
  const measurements = [];
  const record = { scene, budget, side, round, order, measurements, startedAt: new Date().toISOString() };
  replaceBy(timings, record, (item) => `${item.scene}/${item.budget}/${item.side}/${item.round}`);
  for (const variant of order) {
    console.log(`Timing ${scene}/${budget}/${side}: ${variant}`);
    const config = configs[budget][variant];
    await setVariant(devTools, variant, config.slices, config.sparseTapCount ?? 8);
    const seeds = Array.from({ length: config.paths }, (_, p) => seedOf(p));
    await devTools.evaluate(`window.renderLab.setScanSeed(${seeds[0][0]}, ${seeds[0][1]})`);
    const result = config.paths === 1
      ? await devTools.evaluate(`window.renderLab.measureCurrent(${warmupFrames}, ${sampleFrames})`)
      : await devTools.evaluate(`window.renderLab.measureScreenSpacePaths(${JSON.stringify(seeds)}, ${independentSamples})`);
    if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable');
    const rows = rowsOf(result);
    measurements.push({ variant, slices: config.slices, paths: config.paths, sparseTapCount: config.sparseTapCount ?? 8,
      rows, gpuMs: totalOf(rows), cpuRenderP50Ms: result.cpuRenderMs?.p50 ?? null, frames: result.frames ?? null });
    record.recordedAt = new Date().toISOString();
    saveWorkData();
  }
}
async function measureCurveExtra(devTools, scene, round) {
  const anchorSlices = { band: 16, q: 20, 'raw-quarter': 22, 'raw-full': 3 };
  const order = rotate(variantOrder, round);
  const measurements = [];
  const record = { scene, budget: 'curve-extra', side: 'after-capture', round, order, measurements,
    purpose: 'raw-full 3/1 point with low-budget same-page anchors', startedAt: new Date().toISOString() };
  replaceBy(timings, record, (item) => `${item.scene}/${item.budget}/${item.side}/${item.round}`);
  saveWorkData();
  for (const variant of order) {
    const slices = anchorSlices[variant];
    console.log(`Timing ${scene}/curve-extra: ${variant}/${slices}/1`);
    await setVariant(devTools, variant, slices, 8);
    await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null);window.renderLab.setScanSeed(0,0)');
    const result = await devTools.evaluate(`window.renderLab.measureCurrent(${warmupFrames}, ${sampleFrames})`);
    if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable for curve extra point');
    const rows = rowsOf(result);
    measurements.push({ variant, slices, paths: 1, sparseTapCount: 8, rows, gpuMs: totalOf(rows),
      cpuRenderP50Ms: result.cpuRenderMs?.p50 ?? null, frames: result.frames ?? null });
    record.recordedAt = new Date().toISOString();
    saveWorkData();
  }
}
async function exportPng(devTools, imageId, view, kind, exposureFactor) {
  const dataUrl = kind === 'radiance'
    ? await correctionPng(devTools, `window.__ssdBlind.result[${JSON.stringify(view)}]`, displayTransform, exposureFactor)
    : (await spreadPng(devTools, view)).dataUrl;
  const pathOut = path.join(imageDir, imageId, `${view}.png`);
  mkdirSync(path.dirname(pathOut), { recursive: true });
  writeFileSync(pathOut, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  replaceBy(pngs, { stimulusId: imageId, view, exposureFactor,
    displayTransform,
    path: path.relative(outputDir, pathOut).split(path.sep).join('/') },
    (item) => `${item.stimulusId}/${item.view}`);
  saveViewerData();
}
async function generateCandidate(devTools, scene, budget, variant, stimulusId) {
  const config = configs[budget][variant];
  console.log(`Capture ${scene}/${budget}/${variant}: configure`);
  await setVariant(devTools, variant, config.slices, config.sparseTapCount ?? 8);
  const exposureFactor=await devTools.evaluate('window.renderLab.exposureFactor()');
  await captureGroups(devTools, config.paths, `Capture ${scene}/${budget}/${variant}`);
  const exposureAfter=await devTools.evaluate('window.renderLab.exposureFactor()');
  if(Math.abs(exposureAfter-exposureFactor)>Math.max(1,Math.abs(exposureFactor))*1e-7){
    throw new Error(`exposure changed during candidate capture ${scene}/${budget}/${variant}: ${exposureFactor} -> ${exposureAfter}`);
  }
  await devTools.evaluate(`(window.__ssdBlindMeans ??= {}, (window.__ssdBlindMeans[${JSON.stringify(budget)}] ??= {})[${JSON.stringify(variant)}] = window.__ssdBlind.result.mean, 0)`);
  await exportPng(devTools, stimulusId, 'first', 'radiance', exposureFactor);
  await exportPng(devTools, stimulusId, 'second', 'radiance', exposureFactor);
  await exportPng(devTools, stimulusId, 'mean', 'radiance', exposureFactor);
  await exportPng(devTools, stimulusId, 'deviation0', 'deviation', exposureFactor);
  await exportPng(devTools, stimulusId, 'deviation1', 'deviation', exposureFactor);
  await exportPng(devTools, stimulusId, 'variance', 'variance', exposureFactor);
  await devTools.evaluate('delete window.__ssdBlind');
}
async function compareCandidateMeans(devTools, budget) {
  return devTools.evaluate(`(() => {
    const means = window.__ssdBlindMeans[${JSON.stringify(budget)}], names = Object.keys(means), pairs = [];
    for(let a=0;a<names.length;a++) for(let b=a+1;b<names.length;b++){
      const x=means[names[a]],y=means[names[b]];let sum=0;
      for(let i=0;i<x.length;i++){const d=x[i]-y[i];sum+=d*d;}
      pairs.push({a:names[a],b:names[b],rms:Math.sqrt(sum/x.length)});
    }
    pairs.sort((x,y)=>x.rms-y.rms);
    return {pairs,minimumPairwiseRms:pairs[0]?.rms??null,medianPairwiseRms:pairs[Math.floor(pairs.length/2)]?.rms??null};
  })()`);
}
async function generateB(devTools, scene, referenceId) {
  console.log(`B ${scene.id}: configuring full raw`);
  await setVariant(devTools, 'raw-full', 4);
  console.log(`B ${scene.id}: preparing accumulation`);
  await devTools.evaluate(`(() => { window.__ssdB = { firstSum: new Float32Array(960*540*3), secondSum: new Float32Array(960*540*3) }; })()`);
  for (let first = 0; first < 64; first += 8) {
    console.log(`B ${scene}: seeds ${first}-${first + 7}`);
    const seeds = Array.from({ length: 8 }, (_, i) => seedOf(first + i));
    await devTools.evaluate(`(async()=>{
      const seeds=${JSON.stringify(seeds)},b=window.__ssdB;
      for(const [x,y] of seeds){
        window.renderLab.setScanWhiteNoisePass(null);window.renderLab.setScanSeed(x,y);window.renderLab.render();
        const rgba=(await window.renderLab.readFloat('correction')).rgba;
        const target=${first < 32 ? 'b.firstSum' : 'b.secondSum'};
        for(let i=0,j=0;i<rgba.length;i+=4,j+=3){target[j]+=rgba[i];target[j+1]+=rgba[i+1];target[j+2]+=rgba[i+2];}
      }
    })()`);
  }
  await devTools.evaluate(`(() => {
    const b=window.__ssdB,n=b.firstSum.length,pixels=n/3;b.firstHalf=new Float32Array(pixels*4);b.secondHalf=new Float32Array(pixels*4);b.full=new Float32Array(pixels*4);
    for(let p=0;p<pixels;p++){for(let c=0;c<3;c++){const i=p*3+c,j=p*4+c;b.firstHalf[j]=b.firstSum[i]/32;b.secondHalf[j]=b.secondSum[i]/32;b.full[j]=(b.firstSum[i]+b.secondSum[i])/64;}b.firstHalf[p*4+3]=1;b.secondHalf[p*4+3]=1;b.full[p*4+3]=1;}
  })()`);
  const metrics = await devTools.evaluate(`(() => {
    const b=window.__ssdB,n=b.full.length;let e32=0,eh=0,norm=0,count=0;
    const rgba=new Float32Array(n);rgba.set(b.full);b.displayRgba=rgba;
    for(let p=0;p<n;p+=4)for(let c=0;c<3;c++){
      const m=b.full[p+c],d32=b.firstHalf[p+c]-m,dh=b.firstHalf[p+c]-b.secondHalf[p+c];
      e32+=d32*d32;eh+=dh*dh;norm+=m*m;count++;
    }
    return {rms32vs64:Math.sqrt(e32/count),rmsHalfDifference:Math.sqrt(eh/count),meanRms:Math.sqrt(norm/count)};
  })()`);
  const exposureFactor=await devTools.evaluate('window.renderLab.exposureFactor()');
  const dataUrl = await devTools.evaluate(`window.renderLab.signedCorrectionPng({width:960,height:540,rgba:window.__ssdB.displayRgba})`);
  const pathOut=path.join(imageDir,referenceId,'B.png');mkdirSync(path.dirname(pathOut),{recursive:true});
  writeFileSync(pathOut,Buffer.from(dataUrl.split(',')[1],'base64'));
  replaceBy(pngs,{stimulusId:referenceId,view:'B',exposureFactor,displayTransform,path:path.relative(outputDir,pathOut).split(path.sep).join('/')},
    (item)=>`${item.stimulusId}/${item.view}`);
  saveViewerData();
  await devTools.evaluate('delete window.__ssdB');
  return metrics;
}
async function main() {
  execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js','--config','webpack.render-lab.config.js','--mode','production'],
    { cwd: root, stdio: 'inherit' });
  mkdirSync(imageDir,{recursive:true});mkdirSync(workDir,{recursive:true});
  const requestedScene=process.argv.find((arg)=>arg.startsWith('--scene='))?.slice('--scene='.length);
  const selectedScenes=scenes.filter((scene)=>requestedScene===undefined||scene.id===requestedScene);
  const requestedBudget=process.argv.find((arg)=>arg.startsWith('--budget='))?.slice('--budget='.length);
  const allBudgets=['low','medium','high'];
  if(requestedBudget!==undefined&&!allBudgets.includes(requestedBudget))throw new Error(`unknown budget: ${requestedBudget}`);
  const selectedBudgets=requestedBudget===undefined?allBudgets:[requestedBudget];
  const repairOnly=process.argv.includes('--repair-only');
  const requestedVariants=process.argv.find((arg)=>arg.startsWith('--variants='))?.slice('--variants='.length).split(',');
  const selectedVariants=requestedVariants??variantOrder;
  if(selectedVariants.some((variant)=>!variantOrder.includes(variant)))throw new Error(`unknown variant in ${selectedVariants.join(',')}`);
  if(repairOnly&&(requestedScene===undefined||requestedBudget===undefined||requestedVariants===undefined)){
    throw new Error('--repair-only requires --scene, --budget and --variants');
  }
  for(const scene of selectedScenes){
    const sceneIndex=scenes.indexOf(scene);
    if(process.argv.includes('--resume')&&sceneIsComplete(scene.id)){
      console.log(`Resume: ${scene.id} already has complete blinded images`);
      continue;
    }
    const sessionStartedAt=new Date().toISOString();
    const session=await openChromeSession({serveDir:buildDir,port,debugPort,profilePrefix:'tepui-render-lab-ssd8-blind-'});
    try{
      const {devTools}=session;
      await devTools.send('Page.navigate',{url:`${session.baseUrl}/`});
      for(let i=0;i<600;i++){if(await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"'))break;await sleep(200);}
      if(!(await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"')))throw new Error('render-lab API unavailable');
      const adapter=await devTools.evaluate('(async()=>{const a=await navigator.gpu.requestAdapter(),i=a.info??{};return [i.vendor,i.architecture,i.device,i.description].filter(Boolean).join(" / ")})()');
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)},${JSON.stringify(scene.shotName)})`);
      await devTools.evaluate('window.renderLab.setTarget("off"); window.renderLab.setGraphicsOption("screenSpaceDiffuse",2); window.renderLab.setGraphicsOption("screenSpaceQuality",2); window.renderLab.setScanWhiteNoisePass(null)');
      const exposureStability=await stabilizeExposure(devTools);
      const displayCheck=await checkSignedDisplay(devTools);
      await setVariant(devTools, 'raw-full', 4);
      const debugDisplayCheck=await compareSignedDebugCapture(devTools);
      replaceBy(convergence,{scene:scene.id,displayCheck,debugDisplayCheck},(item)=>`${item.scene}/${item.budget??'debug'}`);
      saveWorkData();
      const referenceId=`b${sceneIndex}f8a2`;
      for(const budget of selectedBudgets){
        const set=key.assignments.find(item=>item.scene===scene.id&&item.budget===budget);
        if(!set)throw new Error(`missing key set ${scene.id}/${budget}`);
        const baseRound=sceneIndex*3+['low','medium','high'].indexOf(budget);
        const beforeOrder=rotate(variantOrder,baseRound);
        const afterOrder=rotate(variantOrder.slice().reverse(),baseRound);
        replaceBy(viewerSets,{
          scene:scene.id,budget,referenceId,
          candidates:Object.fromEntries(Object.entries(set.bySymbol).map(([symbol,item])=>[symbol,item.stimulusId])),
        },(item)=>`${item.scene}/${item.budget}`);
        saveViewerData();
        if(!repairOnly)await measureSet(devTools,scene.id,budget,'before',baseRound+1,beforeOrder);
        const captureStartedAt=new Date().toISOString();
        for(const variant of (repairOnly?selectedVariants:variantOrder)){
          const entry=Object.values(set.bySymbol).find(item=>item.variant===variant);
          await generateCandidate(devTools,scene.id,budget,variant,entry.stimulusId);
        }
        if(!repairOnly){
          const candidateDifferences=await compareCandidateMeans(devTools,budget);
          await measureSet(devTools,scene.id,budget,'after',baseRound+1,afterOrder);
          replaceBy(convergence,{scene:scene.id,budget,candidateDifferences,
            bHalfNoiseToMinimumCandidateDifference:null,
            candidateImagesStartedAt:captureStartedAt},(item)=>`${item.scene}/${item.budget??'debug'}`);
        }
        saveWorkData();
      }
      if(!repairOnly&&requestedBudget===undefined){
        await measureCurveExtra(devTools,scene.id,sceneIndex+1);
        const bConvergence=await generateB(devTools,scene,referenceId);
        console.log(`B ${scene.id}: completed ${JSON.stringify(bConvergence)}`);
        for(const item of convergence.filter(entry=>entry.scene===scene.id&&entry.budget)){
          item.bConvergence=bConvergence;
          item.bHalfNoiseToMinimumCandidateDifference=item.candidateDifferences.minimumPairwiseRms===null?null:
            bConvergence.rmsHalfDifference/item.candidateDifferences.minimumPairwiseRms;
        }
      }
      saveWorkData();
      const record={scene:scene.id,pageUrl:session.baseUrl,adapter,exposureStability,sessionStartedAt,sessionFinishedAt:new Date().toISOString()};
      const stateFile=path.join(workDir,`session-${scene.id}.json`);
      writeFileSync(stateFile,JSON.stringify(record,null,2)+'\n');
    }finally{await session.close();}
  }
  saveWorkData();
  saveViewerData();
}
async function minimalCheck() {
  execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js','--config','webpack.render-lab.config.js','--mode','production'],
    { cwd: root, stdio: 'inherit' });
  const session=await openChromeSession({serveDir:buildDir,port:port+1,debugPort:debugPort+1,profilePrefix:'tepui-render-lab-ssd8-mincheck-'});
  try {
    const {devTools}=session;
    await devTools.send('Page.navigate',{url:`${session.baseUrl}/`});
    for(let i=0;i<600;i++){if(await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"'))break;await sleep(200);}
    await devTools.evaluate(`window.renderLab.showShot("bay","bay-dark");window.renderLab.setTarget("off");window.renderLab.setGraphicsOption("screenSpaceDiffuse",2);window.renderLab.setGraphicsOption("screenSpaceQuality",2)`);
    await setVariant(devTools,'band',16);
    await initStats(devTools);
    await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null);window.renderLab.setScanSeed(0,0);window.renderLab.render()');
    const image=await devTools.evaluate("window.renderLab.readFloat('correction').then(({rgba})=>({length:rgba.length,min:Math.min(...rgba.slice(0,10000)),max:Math.max(...rgba.slice(0,10000))}))");
    const buffers=await devTools.evaluate('({sum:window.__ssdBlind.sum.length,squareSum:window.__ssdBlind.squareSum.length})');
    if(image.length!==960*540*4||image.max<=0||buffers.sum!==960*540*3)throw new Error(`minimal check failed: ${JSON.stringify({image,buffers})}`);
    console.log(JSON.stringify({minimalCheck:'passed',image,buffers}));
  } finally { await session.close(); }
}
async function curveExtraOnly() {
  execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js','--config','webpack.render-lab.config.js','--mode','production'],
    { cwd: root, stdio: 'inherit' });
  for (const [sceneIndex,scene] of scenes.entries()) {
    const session=await openChromeSession({serveDir:buildDir,port:port+sceneIndex+2,debugPort:debugPort+sceneIndex+2,
      profilePrefix:`tepui-render-lab-ssd8-curve-${sceneIndex}-`});
    try {
      const {devTools}=session;
      await devTools.send('Page.navigate',{url:`${session.baseUrl}/`});
      for(let i=0;i<600;i++){if(await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"'))break;await sleep(200);}
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)},${JSON.stringify(scene.shotName)});window.renderLab.setTarget("off");window.renderLab.setGraphicsOption("screenSpaceDiffuse",2);window.renderLab.setGraphicsOption("screenSpaceQuality",2)`);
      await stabilizeExposure(devTools);
      await measureCurveExtra(devTools,scene.id,sceneIndex+1);
    } finally { await session.close(); }
  }
}
async function debugCheckOnly() {
  execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js','--config','webpack.render-lab.config.js','--mode','production'],
    { cwd: root, stdio: 'inherit' });
  const selectedScene=process.argv.find((arg)=>arg.startsWith('--scene='))?.slice('--scene='.length);
  const selectedScenes=scenes.filter((scene)=>selectedScene===undefined||scene.id===selectedScene);
  for(const [sceneIndex,scene] of selectedScenes.entries()){
    const session=await openChromeSession({serveDir:buildDir,port:port+sceneIndex+15,debugPort:debugPort+sceneIndex+15,
      profilePrefix:`tepui-render-lab-ssd8-debug-${sceneIndex}-`});
    try{
      const {devTools}=session;
      await devTools.send('Page.navigate',{url:`${session.baseUrl}/`});
      for(let i=0;i<600;i++){if(await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"'))break;await sleep(200);}
      await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)},${JSON.stringify(scene.shotName)});window.renderLab.setTarget("off");window.renderLab.setGraphicsOption("screenSpaceDiffuse",2);window.renderLab.setGraphicsOption("screenSpaceQuality",2)`);
      const exposureStability=await stabilizeExposure(devTools);
      const displayCheck=await checkSignedDisplay(devTools);
      await setVariant(devTools,'raw-full',4);
      const debugDisplayCheck=await compareSignedDebugCapture(devTools);
      const result={scene:scene.id,exposureStability,displayCheck,debugDisplayCheck};
      replaceBy(convergence,result,(item)=>`${item.scene}/${item.budget??'debug'}`);
      saveWorkData();
      console.log(JSON.stringify(result));
    }finally{await session.close();}
  }
}
(process.argv.includes('--minimal-check')?minimalCheck():process.argv.includes('--debug-check-only')?debugCheckOnly():
  process.argv.includes('--curve-extra-only')?curveExtraOnly():main())
  .catch(error=>{console.error(error);process.exit(1)});
