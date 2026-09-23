import * as THREE from 'three';
import { renderer, scene, camera, Q, QNAME, PRESETS, FRAME, $ } from './core/env.js';
import { COLLIDERS } from './core/colliders.js';
import { MAP, SPAWNS, PATHS, TRENCHES, terrainH } from './world/layout.js';
import { buildMaterials } from './gen/materials.js';
import { buildHeightCache, hFast } from './world/heightcache.js';
import { buildTerrain } from './world/terrain.js';
import { buildSky, updateSky, SKY, TIME, nextPhase, fmtTime } from './world/sky.js';
import { buildForest, updateForestLOD, forestStats } from './world/forest.js';
import { buildGrass, buildUndergrowth, refreshGrass, finishGrass, GRASS, updateUndergrowth } from './world/groundcover.js';
import { buildLake, updateLake, planPiers } from './world/lake.js';
import { planBuildings, buildBuildings, HOUSES } from './world/buildings.js';
import { planMilitary, buildMilitary, FIRES, MINES } from './world/military.js';
import { planProps, buildProps, updateBarrels, BARRELS } from './world/props.js';
import { planLamps, buildLamps, finishLamps, updateLamps, lampStats } from './world/lamps.js';
import { flushStatic } from './world/builders.js';
import { stepCloth, CLOTHS } from './world/cloth.js';
import { updateWind, WIND } from './world/wind.js';
import { buildParticles, updateParticles, emitFires } from './fx/particles.js';
import { buildExplosions, updateExplosions, explode, BLAST } from './fx/explosions.js';
import { initAudio, updateAudio, AUDIO } from './fx/audio.js';
import { buildPost, updatePost, resizePost, composer } from './fx/post.js';
import { PL, keys, spawnAt, setMode, look, updatePlayer, dropBomb, startCinematic, stopCinematic } from './game/player.js';
import { buildMapOverlay, updateHud, toast } from './game/hud.js';
import { buildBushes, updateBushes, bushStats } from './world/bushes.js';
import { buildDestruct, updateDestruct, destructStats } from './world/destruct.js';
import { bakeGroundAO } from './world/terrain.js';
import { TREES, forestDensity } from './world/forest.js';
import { SOFTS } from './core/colliders.js';
import { lakeRho, lakeContour } from './world/layout.js';
import { updateLife, buildLife } from './world/life.js';
import { PERF, updatePerf, initPerf } from './core/perf.js';
import { voxelizeLoose, VOX } from './core/voxels.js';
import { buildLeaves, updateLeaves, leafStats } from './fx/leaves.js';
import { buildLitter, updateLitter } from './world/litter.js';

/* ============================================================================
   «ТИХИЙ БОР» — сборка сцены и главный цикл
============================================================================ */
let locked = false, searchlight = null, draws = 0;

const STEPS = [
  ['Текстуры и материалы', () => buildMaterials()],
  ['План карты', () => { planBuildings(); planMilitary(); planPiers(); planProps(); planLamps(); }],
  ['Рельеф: кэш высот', () => buildHeightCache()],
  ['Рельеф: сетка', () => buildTerrain()],
  ['Небо и свет', () => buildSky()],
  ['Хвойный лес', () => buildForest()],
  ['Подлесок, кусты и трава', () => { buildUndergrowth(); buildBushes(); buildGrass(); }],
  ['Озеро, камыш, мостки', () => buildLake()],
  ['Турбаза и кордон', () => buildBuildings()],
  ['Окопы, базы, минное поле', () => buildMilitary()],
  ['Техника и укрытия', () => buildProps()],
  ['Фонари', () => { buildLamps(); finishLamps(); }],
  ['Частицы и взрывы', () => { buildParticles(); buildExplosions(); buildLife(); buildLeaves(); }],
  ['Лесная подстилка', () => buildLitter()],
  ['Разрушаемость', () => buildDestruct()],
  ['Сборка геометрии', () => { finishGrass(); bakeGroundAO(TREES, COLLIDERS); draws = flushStatic(); voxelizeLoose(scene, THREE); buildPost(); initPerf(); buildMapOverlay(); }],
  ['Компиляция шейдеров', () => { spawnAt('A', 'drone'); updatePlayer(0); updateSky(0); renderer.compile(scene, camera); }]
];

async function build() {
  const bar = $('#bar i'), stage = $('#g_stage');
  const t0 = performance.now();
  for (let i = 0; i < STEPS.length; i++) {
    const [name, fn] = STEPS[i];
    stage.textContent = name + '…';
    bar.style.width = (i / STEPS.length * 100).toFixed(0) + '%';
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const ts = performance.now();
    fn();
    console.info(`[build] ${name}: ${(performance.now() - ts).toFixed(0)} мс`);
  }
  console.info(`[build] всего ${(performance.now() - t0).toFixed(0)} мс`);
  bar.style.width = '100%';
  finish();
}

function finish() {
  // прожектор дрона / фонарь бойца
  searchlight = new THREE.SpotLight(0xf2f4ff, 0, 70, 0.34, 0.5, 1.2);
  searchlight.position.set(0, -0.2, 0);
  searchlight.target.position.set(0, -0.35, -1);
  camera.add(searchlight, searchlight.target);
  TIME.h = 9.0;
  $('#help').textContent =
    'Мышь — обзор · WASD — полёт/ходьба · Space/E вверх · C/Q вниз · Shift быстрее · колесо — скорость дрона\n' +
    'ЛКМ — сброс гранаты / бросок · G — дрон ⇄ пешком · F — прожектор · M — карта · P — облёт · R — на базу\n' +
    'N — фаза суток · T — пауза · [ ] — скорость времени · 1..4 — утро/день/закат/ночь · U — звук · V — интерфейс';
  window.MAP_API = {
    THREE, scene, camera, renderer, composer, player: PL, keys, time: TIME, sky: SKY, wind: WIND,
    setTime: h => { TIME.h = h; updateSky(0); },
    teleport: (x, y, z, yaw = PL.yaw, pitch = PL.pitch) => { PL.pos.set(x, y, z); PL.vel.set(0, 0, 0); PL.yaw = yaw; PL.pitch = pitch; stopCinematic(); },
    lookAt: (x, y, z) => { const dx = x - PL.pos.x, dy = y - PL.pos.y, dz = z - PL.pos.z; PL.yaw = Math.atan2(-dx, -dz); PL.pitch = Math.atan2(dy, Math.hypot(dx, dz)); },
    step: dt => frame(dt), explode, setMode, trees: TREES, trenchList: TRENCHES, spawnAt, startCinematic, terrainH, map: MAP, spawns: SPAWNS,
    // логика без отрисовки: для автотестов на медленных машинах
    simulate: (dt, n = 1) => { for (let i = 0; i < n; i++) { FRAME.t += dt; FRAME.n++; updatePlayer(dt); updateExplosions(dt); updateDestruct(dt); updateBarrels(dt); updateLeaves(dt, SKY); } return PL; },
    stats: () => ({
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles, grass: GRASS.count,
      ...forestStats(), colliders: COLLIDERS.length, houses: HOUSES.length, cloths: CLOTHS.length, barrels: BARRELS.length,
      mines: MINES.list.length, paths: PATHS.length, trenches: TRENCHES.length, staticDraws: draws, ...lampStats(), quality: QNAME,
      ...bushStats(), ...destructStats(), softs: SOFTS.length, voxels: VOX.cells, ...leafStats(), scale: PERF.scale, frameMs: PERF.ms
    })
  };
  $('#g_load').style.display = 'none';
  $('#g_ready').style.display = 'block';
  for (const b of document.querySelectorAll('#teams button')) b.onclick = () => {
    PL.team = b.dataset.t;
    for (const o of document.querySelectorAll('#teams button')) o.classList.toggle('on', o === b);
  };
  const qrow = $('#qrow');
  for (const k of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = PRESETS[k].name; b.classList.toggle('on', k === QNAME);
    b.onclick = () => { if (k === QNAME) return; localStorage.setItem('tikhiy_bor_q', k); location.search = '?q=' + k; };
    qrow.appendChild(b);
  }
  $('#g_go').onclick = () => { spawnAt(PL.team, 'drone'); enter(); };
  $('#g_cine').onclick = () => { spawnAt(PL.team, 'drone'); startCinematic(); enter(); };
  window.MAP_READY = true;
  // ?shot — без главного цикла: кадры шагаются вручную через MAP_API.step (автотесты, скриншоты)
  if (!new URLSearchParams(location.search).has('shot')) requestAnimationFrame(loop);
}
function enter() {
  initAudio();
  renderer.domElement.requestPointerLock?.();
  $('#gate').classList.add('hide');
  $('#hud').classList.add('on');
}

/* ---------- Ввод ---------- */
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space', 'Tab', 'KeyC', 'ControlLeft', 'F2', 'F3'].includes(e.code)) e.preventDefault();
  if (!window.MAP_READY) return;
  if (PL.cine && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyG'].includes(e.code)) { stopCinematic(); toast('облёт прерван — управление ваше'); }
  switch (e.code) {
    case 'KeyG': setMode(PL.mode === 'drone' ? 'walk' : 'drone'); toast(PL.mode === 'drone' ? 'дрон' : 'пешком'); break;
    case 'KeyF': PL.light = !PL.light; toast('прожектор: ' + (PL.light ? 'вкл' : 'выкл')); break;
    case 'KeyM': $('#map').classList.toggle('on'); break;
    case 'KeyP': if (PL.cine) stopCinematic(); else { startCinematic(); toast('облёт карты · WASD — прервать'); } break;
    case 'KeyR': spawnAt(PL.team, PL.mode); toast('на базу ' + (PL.team === 'A' ? 'ALPHA' : 'DELTA')); break;
    case 'KeyN': nextPhase(); updateSky(0); toast(fmtTime(TIME.h) + ' · ' + SKY.label); break;
    case 'KeyT': TIME.paused = !TIME.paused; toast(TIME.paused ? 'время остановлено' : 'время идёт'); break;
    case 'BracketLeft': TIME.speed = Math.max(1 / 900, TIME.speed / 2); toast('скорость времени ×' + (TIME.speed * 45).toFixed(2)); break;
    case 'BracketRight': TIME.speed = Math.min(2, TIME.speed * 2); toast('скорость времени ×' + (TIME.speed * 45).toFixed(2)); break;
    case 'Digit1': TIME.h = 7.2; toast('утро'); break;
    case 'Digit2': TIME.h = 13; toast('день'); break;
    case 'Digit3': TIME.h = 19.7; toast('закат'); break;
    case 'Digit4': TIME.h = 23.3; toast('ночь'); break;
    case 'KeyU': AUDIO.on = !AUDIO.on; toast('звук: ' + (AUDIO.on ? 'вкл' : 'выкл')); break;
    case 'KeyV': $('#hud').classList.toggle('clean'); break;
    case 'KeyH': $('#help').classList.toggle('on'); break;
    case 'F3': { const f = $('#fps'); f.style.display = f.style.display === 'block' ? 'none' : 'block'; break; }
    case 'Escape': $('#map').classList.remove('on'); break;
  }
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('mousemove', e => { if (locked) look(e.movementX, e.movementY); });
addEventListener('wheel', e => { if (locked && PL.mode === 'drone') PL.speed = Math.min(60, Math.max(2, PL.speed * (e.deltaY > 0 ? 0.88 : 1.14))); }, { passive: true });
renderer.domElement.addEventListener('mousedown', e => {
  if (!locked) { renderer.domElement.requestPointerLock?.(); return; }
  if (e.button === 0) dropBomb();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!locked && window.MAP_READY) { $('#gate').classList.remove('hide'); $('#hud').classList.remove('on'); for (const k in keys) keys[k] = false; }
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) resizePost();
});

/* ---------- Кадр ---------- */
const clock = new THREE.Clock();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
function frame(dt) {
  FRAME.dt = dt; FRAME.t += dt; FRAME.n++;
  updatePlayer(dt);
  updateWind(FRAME.t);
  updateSky(dt);
  updateLamps(SKY.lampOn);
  updateForestLOD();
  refreshGrass();
  updateUndergrowth();
  updateBushes();
  updateDestruct(dt);
  updateLeaves(dt, SKY);
  updateLitter();
  updateLife(dt, SKY);
  stepCloth(dt, FRAME.t);
  updateBarrels(dt);
  emitFires(FIRES, dt, SKY);
  updateExplosions(dt);
  const ground = hFast(camera.position.x, camera.position.z);
  updateParticles(dt, { night: SKY.night, h: TIME.h, fogColor: SKY.fogColor, ground });
  updateLake(SKY);
  searchlight.intensity = PL.light ? (PL.mode === 'drone' ? 260 : 60) : 0;
  searchlight.angle = PL.mode === 'drone' ? 0.34 : 0.5;
  updateAudio(dt, audioState());
  updatePost(SKY, Math.min(1, BLAST.shake * 0.8 + (PL.dead > 0 ? 0.6 : 0)));
  renderer.info.autoReset = false;
  renderer.info.reset();
  composer.render();
  updateHud(dt);
}
/** Состояние для звука: где слушатель, что вокруг — лес, вода, кусты. */
const _fwd = new THREE.Vector3(), _shore = { x: 0, z: 0, d: 999 };
let shoreT = 0;
function audioState() {
  const cp = camera.position;
  camera.getWorldDirection(_fwd);
  // ближайшая точка уреза: грубый поиск по контуру раз в 0.25 с
  if (FRAME.t - shoreT > 0.25) {
    shoreT = FRAME.t;
    let best = 1e9;
    for (let i = 0; i < 96; i++) {
      const [x, z] = lakeContour(i / 96 * Math.PI * 2, 0), d = Math.hypot(x - cp.x, z - cp.z);
      if (d < best) { best = d; _shore.x = x; _shore.z = z; }
    }
    _shore.d = lakeRho(cp.x, cp.z) < 1 ? Math.min(best, 6) : best;
  }
  return {
    night: SKY.night, h: TIME.h, wind: WIND.strength, gust: WIND.gust, agl: PL.agl, drone: PL.mode === 'drone' && PL.dead <= 0,
    speed: PL.vel.length(), pos: cp, fwd: _fwd, canopy: forestDensity(cp.x, cp.z), shore: _shore, brush: PL.brush || 0
  };
}
function loop() {
  requestAnimationFrame(loop);
  const raw = clock.getDelta();
  const dt = Math.min(raw, 0.05);
  frame(dt);
  updatePerf(raw);
  fpsAcc += dt; fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    const el = $('#fps');
    if (el.style.display === 'block') {
      const s = window.MAP_API.stats();
      el.textContent = `${(fpsN / fpsAcc).toFixed(0)} fps · ${QNAME}\n${s.calls} вызовов · ${(s.tris / 1000).toFixed(0)}k треуг.\n` +
        `деревья ${s.trees} (детальных ${s.hi}) · трава ${s.grass}\nфонари ${s.working}/${s.lamps} · мины ${s.mines}\n` +
        `${PL.pos.x.toFixed(1)}, ${PL.pos.y.toFixed(1)}, ${PL.pos.z.toFixed(1)} · ${fmtTime(TIME.h)}`;
    }
    fpsAcc = 0; fpsN = 0; fpsT = 0;
  }
}

build().catch(err => {
  console.error(err);
  window.MAP_ERROR = String(err && err.stack || err);
  $('#g_load').innerHTML = '<p style="color:#d9736b">Ошибка сборки: ' + String(err && err.message || err) + '</p>';
});
