import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { clamp, lerp, sr, srnd, TAU } from '../core/math.js';
import { MAP, lakeRho } from '../world/layout.js';
import { hFast } from '../world/heightcache.js';
import { WIND } from '../world/wind.js';
import { cv, tex } from '../gen/canvas.js';

/* ============================================================================
   ЛИСТЬЯ, ХВОЯ, ОПИЛКИ
   Лёгкие частицы с «листовой» аэродинамикой: падают с предельной скоростью,
   качаются маятником и кувыркаются, их сносит ветром. На земле ложатся плашмя
   и лежат долго — после взрыва вокруг остаётся ковёр из листвы и опилок, на
   воде — плавают. Одна инстанс-сетка, обновляются только летящие.
============================================================================ */
const CAP = 3200;
const TYPES = {
  leaf: { term: 0.9, flutter: 0.9, size: [0.05, 0.085], aspect: 0.7, life: [70, 120], shape: 0 },
  needle: { term: 1.7, flutter: 0.25, size: [0.07, 0.11], aspect: 0.14, life: [50, 90], shape: 1 },
  sawdust: { term: 0.7, flutter: 0.5, size: [0.012, 0.028], aspect: 0.8, life: [90, 140], shape: 2 },
  bark: { term: 3.2, flutter: 0.2, size: [0.03, 0.06], aspect: 0.6, life: [80, 120], shape: 2 }
};
const P = [];
let im, head = 0, dirty = false;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function atlas() {
  // три формы в одной текстуре (по горизонтали): лист, иголка, чешуйка
  const [c, x] = cv(192, 64);
  x.fillStyle = '#fff';
  x.beginPath(); x.moveTo(32, 4); x.quadraticCurveTo(58, 30, 32, 60); x.quadraticCurveTo(6, 30, 32, 4); x.fill();
  x.fillRect(93, 2, 6, 60);
  x.beginPath(); for (let i = 0; i < 9; i++) { const a = i / 9 * TAU, r = 22 + Math.sin(i * 2.7) * 7; x.lineTo(160 + Math.cos(a) * r, 32 + Math.sin(a) * r); } x.fill();
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
export function buildLeaves() {
  const g = new THREE.PlaneGeometry(1, 1);
  // UV — в треть атласа; смещение по форме задаёт инстанс-атрибут
  const shape = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1);
  g.setAttribute('aShape', shape);
  const mat = new THREE.MeshLambertMaterial({ map: atlas(), alphaTest: 0.5, side: THREE.DoubleSide });
  mat.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float aShape;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vec2((uv.x + aShape) / 3.0, uv.y);\n#endif');
  };
  mat.customProgramCacheKey = () => 'leaves-atlas';
  im = new THREE.InstancedMesh(g, mat, CAP);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < CAP; i++) im.setMatrixAt(i, ZERO);
  im.setColorAt(0, _c.setRGB(1, 1, 1));
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false; im.receiveShadow = true; im.castShadow = false;
  im.count = CAP; im.name = 'leaves';
  im.userData.shape = shape;
  scene.add(im); NO_REFLECT.push(im);
}
/** Одна частица. col — [r,g,b] в линейном цвете. */
export function spawnLeaf(type, x, y, z, vx = 0, vy = 0, vz = 0, col = null) {
  if (!im) return;
  const T = TYPES[type];
  const i = head; head = (head + 1) % CAP;
  const s = sr(T.size[0], T.size[1]);
  const p = P[i] || (P[i] = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), spin: new THREE.Vector3() });
  p.T = T; p.alive = true; p.land = 0; p.age = 0; p.life = sr(T.life[0], T.life[1]) * (Q.ferns ?? 1);
  p.pos.set(x, y, z); p.vel.set(vx, vy, vz);
  p.rot.set(srnd() * TAU, srnd() * TAU, srnd() * TAU);
  p.spin.set(sr(-6, 6), sr(-4, 4), sr(-6, 6));
  p.s = s; p.ph = srnd() * TAU; p.fq = sr(1.6, 3.2);
  im.userData.shape.array[i] = T.shape; im.userData.shape.needsUpdate = true;
  const c = col || [0.3, 0.4, 0.12];
  const v = sr(0.8, 1.2);
  im.setColorAt(i, _c.setRGB(c[0] * v, c[1] * v, c[2] * v)); im.instanceColor.needsUpdate = true;
  dirty = true;
}
/** Облако частиц вокруг точки с разлётом speed. */
export function leafBurst(type, x, y, z, n, spread, speed, col, up = 1) {
  for (let i = 0; i < n; i++) {
    const a = srnd() * TAU, r = Math.sqrt(srnd()) * spread;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, py = y + sr(-0.5, 0.5) * spread * 0.6;
    const sp = speed * sr(0.3, 1);
    spawnLeaf(type, px, py, pz, Math.cos(a) * sp, sr(0.2, 1) * sp * up, Math.sin(a) * sp, col);
  }
}
let ambT = 0;
export function updateLeaves(dt, sky) {
  if (!im) return;
  const t = FRAME.t, wx = WIND.dir.x * WIND.strength, wz = WIND.dir.y * WIND.strength;
  // редкие листья падают с берёз и кустов сами по себе — лес живой
  ambT += dt;
  if (ambT > 0.45 && sky.night < 0.7) {
    ambT = 0;
    const cp = camera.position, a = srnd() * TAU, r = sr(3, 18);
    const x = cp.x + Math.cos(a) * r, z = cp.z + Math.sin(a) * r, g = hFast(x, z);
    if (cp.y - g < 30) spawnLeaf(srnd() < 0.6 ? 'leaf' : 'needle', x, g + sr(5, 12), z, 0, 0, 0, srnd() < 0.5 ? [0.55, 0.45, 0.1] : [0.28, 0.36, 0.1]);
  }
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p || !p.alive) continue;
    p.age += dt;
    if (p.age > p.life) { p.alive = false; im.setMatrixAt(i, ZERO); dirty = true; continue; }
    const fade = p.age > p.life - 3 ? (p.life - p.age) / 3 : 1;
    if (p.land === 1 && fade >= 1) continue;
    if (p.land === 0) {
      const T = p.T;
      // сопротивление воздуха тянет к скорости ветра, падение — к предельной
      const k = Math.min(1, dt * 3.5);
      p.vel.x += (wx * 0.9 - p.vel.x) * k * 0.6;
      p.vel.z += (wz * 0.9 - p.vel.z) * k * 0.6;
      p.vel.y += (-T.term - p.vel.y) * Math.min(1, dt * 2.2);
      p.vel.y -= Math.max(0, p.vel.y) * dt * 3;
      const sw = Math.sin(t * p.fq + p.ph) * T.flutter;
      p.pos.x += (p.vel.x + Math.cos(p.ph) * sw) * dt;
      p.pos.z += (p.vel.z + Math.sin(p.ph) * sw) * dt;
      p.pos.y += (p.vel.y + Math.abs(sw) * 0.35 * T.flutter) * dt;
      p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
      const g = hFast(p.pos.x, p.pos.z);
      const water = g < MAP.WATER_Y && lakeRho(p.pos.x, p.pos.z) < 1;
      const floor = water ? MAP.WATER_Y + 0.004 : g + 0.012;
      if (p.pos.y <= floor) {
        p.pos.y = floor; p.land = water ? 2 : 1;
        // ложится плашмя со случайным курсом
        p.rot.set(-Math.PI / 2 + sr(-0.2, 0.2), p.rot.y, sr(-0.15, 0.15));
      }
    } else if (p.land === 2) {
      // на воде медленно дрейфует и покачивается
      p.pos.x += wx * 0.05 * dt; p.pos.z += wz * 0.05 * dt;
      p.pos.y = MAP.WATER_Y + 0.004 + Math.sin(t * 1.3 + p.ph) * 0.006;
    }
    _q.setFromEuler(_e.set(p.rot.x, p.rot.y, p.rot.z, 'YXZ'));
    _s.set(p.s * p.T.aspect * fade, p.s * fade, 1);
    im.setMatrixAt(i, _m.compose(p.pos, _q, _s));
    dirty = true;
  }
  if (dirty) { im.instanceMatrix.needsUpdate = true; dirty = false; }
}
export const leafStats = () => ({ leaves: P.filter(p => p && p.alive).length });
