import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shotDir = path.join(root, '.render-lab-shots', 'ssd-8-blind');
const viewerPath = path.join(shotDir, 'index.html');
const dataPath = path.join(shotDir, 'viewer-data.json');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const html = readFileSync(viewerPath, 'utf8');

const expectedViews = ['first', 'second', 'mean', 'deviation0', 'deviation1', 'variance'];
if (data.assignments.length !== 3 || data.labels.length !== 12
    || data.assignments.some(({ candidates }) => candidates.length !== 12)) {
  throw new Error('public viewer data must contain three scenes and twelve candidates per scene');
}
function hasOnlyKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
if (!hasOnlyKeys(data, ['scenes', 'labels', 'views', 'assignments', 'images'])
    || data.assignments.some((assignment) => !hasOnlyKeys(assignment, ['scene', 'candidates', 'reference'])
      || assignment.candidates.some((candidate) => !hasOnlyKeys(candidate, ['label', 'stimulusId']))
      || !hasOnlyKeys(assignment.reference, ['stimulusId', 'view', 'path']))) {
  throw new Error('public viewer data contains fields outside scene, label, opaque ID, path, and view');
}
if (JSON.stringify(data.views) !== JSON.stringify(expectedViews)) throw new Error('unexpected candidate views');
const imageByKey = new Map(data.images.map((item) => [`${item.stimulusId}|${item.view}`, item]));
for (const assignment of data.assignments) {
  for (const candidate of assignment.candidates) {
    for (const view of expectedViews) {
      const item = imageByKey.get(`${candidate.stimulusId}|${view}`);
      if (!item || !existsSync(path.join(shotDir, item.path))) {
        throw new Error(`missing candidate image ${assignment.scene}/${candidate.label}/${view}`);
      }
    }
  }
  const reference = assignment.reference;
  if (!reference || reference.view !== 'B' || !existsSync(path.join(shotDir, reference.path))) {
    throw new Error(`missing reference image for ${assignment.scene}`);
  }
}
const forbidden = ['raw-quarter', 'raw-full', 'band', 'priorPrediction', 'key.json', 'capture-timings', 'low', 'medium', 'high'];
const publicText = `${JSON.stringify(data)}\n${html}`;
const leaks = forbidden.filter((word) => publicText.includes(word));
if (leaks.length) throw new Error(`public viewer contains private terms: ${leaks.join(', ')}`);
if (data.images.some((item) => Object.keys(item).some((key) => !['stimulusId', 'view', 'path'].includes(key)))) {
  throw new Error('public image records contain private metadata');
}

const session = await openChromeSession({ serveDir: shotDir, port: 8797, debugPort: 9474,
  profilePrefix: 'tepui-render-lab-ssd8-all12-viewer-check-' });
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: pathToFileURL(viewerPath).href });
  for (let index = 0; index < 300; index++) {
    if (await devTools.evaluate('document.querySelector("#image")?.complete && document.querySelector("#image")?.naturalWidth === 960')) break;
    await sleep(200);
  }
  const opened = await devTools.evaluate(`(() => ({
    url: location.href, title: document.title, imageWidth: document.querySelector('#image')?.naturalWidth,
    imageHeight: document.querySelector('#image')?.naturalHeight,
    sceneOptions: document.querySelector('#scene')?.options.length,
    candidateButtons: document.querySelectorAll('#candidateButtons button').length,
    imageCssWidth: document.querySelector('#image')?.getBoundingClientRect().width,
    initialRated: JSON.parse(localStorage.getItem('ssd8-blind-all12-v1/bay-dark') ?? 'null')?.rated ?? false,
    hasRemoteDataFetch: [...document.scripts].some((script) => script.src || /fetch\\s*\\(/.test(script.textContent)),
  }))()`);
  if (!opened.url.startsWith('file:') || opened.imageWidth !== 960 || opened.imageHeight !== 540
      || opened.imageCssWidth !== 960 || opened.sceneOptions !== 3 || opened.candidateButtons !== 12
      || opened.hasRemoteDataFetch) throw new Error(`file viewer did not initialize: ${JSON.stringify(opened)}`);

  await devTools.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const wideLayout = await devTools.evaluate(`(() => {
    const image=document.querySelector('#image').getBoundingClientRect();
    const ranking=document.querySelector('#rankingHeading').closest('section').getBoundingClientRect();
    return {imageWidth:image.width, imageHeight:image.height, imageX:image.x, rankingX:ranking.x, rankingY:ranking.y};
  })()`);
  if (wideLayout.imageWidth !== 960 || wideLayout.imageHeight !== 540 || wideLayout.rankingX <= wideLayout.imageX + 960) {
    throw new Error(`wide comparison layout failed: ${JSON.stringify(wideLayout)}`);
  }
  await devTools.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrowLayout = await devTools.evaluate(`(() => {
    const image=document.querySelector('#image').getBoundingClientRect();
    const ranking=document.querySelector('#rankingHeading').closest('section').getBoundingClientRect();
    return {imageWidth:image.width, imageBottom:image.bottom, rankingY:ranking.y};
  })()`);
  if (narrowLayout.imageWidth !== 960 || narrowLayout.rankingY <= narrowLayout.imageBottom) {
    throw new Error(`narrow comparison layout failed: ${JSON.stringify(narrowLayout)}`);
  }

  const imageSwitch = await devTools.evaluate(`(async() => {
    const candidate=document.querySelector('#candidateButtons button[data-label="12"]');
    const view=document.querySelector('#view');candidate.click();view.value='variance';view.dispatchEvent(new Event('change'));
    await document.querySelector('#image').decode();
    const candidatePath=document.querySelector('#image').getAttribute('src');
    view.value='B';view.dispatchEvent(new Event('change'));await document.querySelector('#image').decode();
    return {candidatePath,referencePath:document.querySelector('#image').getAttribute('src'),status:document.querySelector('#status').textContent};
  })()`);
  if (!imageSwitch.candidatePath?.startsWith('images/') || !imageSwitch.candidatePath.endsWith('/variance.png')
      || !imageSwitch.referencePath?.endsWith('/B.png') || !imageSwitch.status.includes('順位外')) {
    throw new Error(`candidate/reference view switch failed: ${JSON.stringify(imageSwitch)}`);
  }
  await devTools.evaluate(`(() => {const view=document.querySelector('#view');view.value='first';view.dispatchEvent(new Event('change'));})()`);

  const keyboardRank = await devTools.evaluate(`(() => {
    const handle=document.querySelector('#rankList li[data-label="02"] .handle');handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    return {order:[...document.querySelectorAll('#rankList li')].slice(0,3).map((item)=>item.dataset.label),
      rated:JSON.parse(localStorage.getItem('ssd8-blind-all12-v1/bay-dark')).rated};
  })()`);
  if (keyboardRank.order.join(',') !== '02,01,03' || keyboardRank.rated) {
    throw new Error(`keyboard reorder or unrated state failed: ${JSON.stringify(keyboardRank)}`);
  }
  await devTools.evaluate(`(() => document.querySelector('#rankList li:nth-child(2) .tie-button').click())()`);
  await devTools.evaluate(`(() => document.querySelector('#confirmRanking').click())()`);
  const rated = await devTools.evaluate(`(() => ({
    rated:JSON.parse(localStorage.getItem('ssd8-blind-all12-v1/bay-dark')).rated,
    text:document.querySelector('#rankStatus').textContent,
  }))()`);
  if (!rated.rated || !rated.text.includes('02 = 01')) throw new Error(`rank confirmation/tie failed: ${JSON.stringify(rated)}`);

  await devTools.evaluate(`(() => {const field=document.querySelector('#reason');field.value='Boundary preservation and stable glint';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await devTools.evaluate(`(() => {const scene=document.querySelector('#scene');scene.value='bay-earth-open';scene.dispatchEvent(new Event('change'));scene.value='bay-dark';scene.dispatchEvent(new Event('change'));})()`);
  const savedReason = await devTools.evaluate(`(() => document.querySelector('#reason').value)()`);
  if (savedReason !== 'Boundary preservation and stable glint') throw new Error('reason did not persist when changing scenes');

  await devTools.evaluate(`(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new Error('forced clipboard denial'); },
    } });
  })()`);
  await devTools.evaluate(`(() => document.querySelector('#copyAll').click())()`);
  await sleep(300);
  const copy = await devTools.evaluate(`(() => ({
    visible:!document.querySelector('#exportText').hidden,
    text:document.querySelector('#exportText').value,
    key:localStorage.getItem('ssd8-blind-all12-v1/bay-dark'),
    oldKey:localStorage.getItem('ssd8-blind/bay-dark/low'),
  }))()`);
  if (!copy.text.includes('bay-dark\nRanking: 02 = 01')
      || !copy.text.includes('Reason: Boundary preservation and stable glint')
      || !copy.text.includes('bay-earth-open\nRanking: (not rated)')
      || !copy.text.includes('cornell-box\nRanking: (not rated)')
      || !copy.key || copy.oldKey !== null) throw new Error('3-scene copy or isolated storage failed');

  const labelImage = await devTools.evaluate(`(async() => {
    document.querySelector('#rankList li[data-label="04"] .candidate-label').click();
    await document.querySelector('#image').decode();
    return {label:document.querySelector('#candidateButtons button[aria-pressed="true"]')?.dataset.label,
      src:document.querySelector('#image').getAttribute('src')};
  })()`);
  if (labelImage.label !== '04' || !labelImage.src.includes('/first.png')) {
    throw new Error(`rank label did not open its candidate image: ${JSON.stringify(labelImage)}`);
  }

  await devTools.evaluate(`(() => document.querySelector('#markUnrated').click())()`);
  await devTools.evaluate(`(() => document.querySelector('#rankList li[data-label="12"] .handle').scrollIntoView({block:'center'}))()`);
  const drag = await devTools.evaluate(`(() => {
    const a=document.querySelector('#rankList li[data-label="09"] .handle').getBoundingClientRect();
    const b=document.querySelector('#rankList li[data-label="12"] .handle').getBoundingClientRect();
    return {from:{x:a.x+a.width/2,y:a.y+a.height/2},to:{x:b.x+b.width/2,y:b.y+b.height/2}};
  })()`);
  const beforePointerOrder = await devTools.evaluate(`(() => [...document.querySelectorAll('#rankList li')].map((item)=>item.dataset.label))()`);
  await devTools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', buttons: 1 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.to.x, y: drag.to.y, button: 'left', buttons: 1 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', buttons: 0 });
  const pointerOrder = await devTools.evaluate(`(() => [...document.querySelectorAll('#rankList li')].map((item)=>item.dataset.label))()`);
  if (pointerOrder.indexOf('09') <= beforePointerOrder.indexOf('09')) throw new Error('mouse drag did not reorder candidate list');

  await devTools.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await devTools.evaluate(`(() => document.querySelector('#rankList li[data-label="12"] .handle').scrollIntoView({block:'center'}))()`);
  const touchDrag = await devTools.evaluate(`(() => {
    const a=document.querySelector('#rankList li[data-label="11"] .handle').getBoundingClientRect();
    const b=document.querySelector('#rankList li[data-label="12"] .handle').getBoundingClientRect();
    return {from:{x:a.x+a.width/2,y:a.y+a.height/2},to:{x:b.x+b.width/2,y:b.y+b.height/2}};
  })()`);
  const beforeTouchOrder = await devTools.evaluate(`(() => [...document.querySelectorAll('#rankList li')].map((item)=>item.dataset.label))()`);
  await devTools.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchDrag.from.x, y: touchDrag.from.y, id: 1 }] });
  await devTools.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchDrag.to.x, y: touchDrag.to.y, id: 1 }] });
  await devTools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const touchOrder = await devTools.evaluate(`(() => [...document.querySelectorAll('#rankList li')].map((item)=>item.dataset.label))()`);
  if (touchOrder.indexOf('11') === beforeTouchOrder.indexOf('11')) throw new Error('touch drag did not reorder candidate list');

  console.log(JSON.stringify({ opened, wideLayout, narrowLayout, imageSwitch, keyboardRank, rated, reasonPersistence: true, copyFallback: copy.visible,
    copyIncludesAllScenes: true, mouseReordered: true, touchReordered: true, publicImageCount: data.images.length,
    allImageLinksPresent: true, noPrivateLabels: true }));
} finally {
  try {
    await session.close();
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    await sleep(750);
    try {
      await session.close();
    } catch (retryError) {
      if (retryError?.code !== 'EPERM') throw retryError;
      console.warn(`Chrome viewer checks passed, but its temporary profile could not be removed: ${retryError.message}`);
    }
  }
}
