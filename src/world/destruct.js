import * as THREE from 'three';
import { scene, camera, FRAME, Q } from '../core/env.js';
import { rng, TAU, clamp, sr, srnd } from '../core/math.js';
import { MAP, lakeRho, isFree, keep, CLUSTERS, TRENCHES } from './layout.js';
import { hFast, groundMin } from './heightcache.js';
import { M } from '../gen/materials.js';
import { treesNear, removeTree, TREES } from './forest.js';
import { addBox, addCircle } from '../core/colliders.js';
import { FX } from '../fx/particles.js';
import { shredUndergrowth } from './groundcover.js';
import { shredReeds } from './lake.js';
import { shredBushes } from './bushes.js';
import { sfx } from '../fx/audio.js';
import { BARRELS } from './props.js';
import { BLAST, explode } from '../fx/explosions.js';
import { DYN_LIGHTS } from './lamps.js';

/* ============================================================================
   РАЗРУШЕНИЯ
   • Деревья: взрыв ломает ствол на высоте колена, верх падает от взрыва как
     стержень на шарнире (θ'' = 3g/2L·sin θ): медленно кренится, разгоняется,
     бьёт кроной о землю, пружинит и ложится. На месте — расщеплённый пень.
   • Ящики разлетаются на доски, топливные бочки детонируют и горят.
   • Обломки — твёрдые тела: кувыркаются, отскакивают, ложатся плашмя, щепа
     плавает в озере, железо тонет.
   • Подлесок, кусты и камыш срезает, по краю — приминает.
============================================================================ */
export const DESTRUCT = { fallers: [], crates: [], pieces: [], fires: [] };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(),
  _s = new THREE.Vector3(), _e = new THREE.Euler(), _ax = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/* ---------- Пулы инстансов ---------- */
class Pool {
  constructor(geo, mat, cap, o = {}) {
    this.im = new THREE.InstancedMesh(geo, mat, cap);
    this.im.count = 0; this.im.frustumCulled = false;
    this.im.castShadow = o.cast !== false; this.im.receiveShadow = true;
    this.im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (o.color) { this.im.setColorAt(0, new THREE.Color(1, 1, 1)); this.im.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    if (o.depth) this.im.customDepthMaterial = o.depth;
    this.im.name = o.name || 'pool';
    this.cap = cap; this.used = 0;
    scene.add(this.im);
  }
  alloc() { return this.used < this.cap ? this.used++ : -1; }
  set(i, m, c) {
    this.im.setMatrixAt(i, m);
    if (c && this.im.instanceColor) { this.im.setColorAt(i, c); this.im.instanceColor.needsUpdate = true; }
    this.im.count = Math.max(this.im.count, i + 1);
    this.im.instanceMatrix.needsUpdate = true;
  }
}
const FALL_POOLS = new Map();    // вариант дерева → {trunk, crown}
const STUMPS = {};               // вид → Pool
const PIECES = {};               // материал обломков → Pool

function stumpGeo(seed) {
  // пень: цилиндр, верх — рваная щепа (вершины кольца тянутся вверх вразнобой)
  const R = rng(seed);
  const g = new THREE.CylinderGeometry(0.8, 1, 1, 10, 3, false);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 0.99) p.setY(i, 1 + R.range(-0.25, 0.6) * (Math.hypot(p.getX(i), p.getZ(i)) > 0.1 ? 1 : 0.2));
    else if (y > 0.6) p.setY(i, y + R.range(-0.05, 0.1));
  }
  g.computeVertexNormals();
  return g;
}

export function buildDestruct() {
  // пулы для падающих деревьев: та же геометрия и материалы — шейдеры уже собраны
  const variants = new Set(TREES.map(t => t.variant).filter(Boolean));
  for (const v of variants) {
    const trunk = new Pool(v.hi.trunk, v.trunkIM.material, 10, { color: true, name: 'fall_trunk' });
    const crown = new Pool(v.hi.crown, v.hiIM.material, 10, { color: true, depth: v.hiIM.customDepthMaterial, name: 'fall_crown' });
    crown.im.castShadow = Q.shadowTrees;
    FALL_POOLS.set(v, { trunk, crown });
  }
  const sg = stumpGeo(31);
  for (const k of ['spruce', 'pine', 'birch']) {
    const mat = M[k === 'spruce' ? 'barkSpruce' : k === 'pine' ? 'barkPine' : 'barkBirch'];
    STUMPS[k] = new Pool(sg, mat, 48, { color: true, name: 'stumps' });
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  PIECES.wood = new Pool(box, M.planks, 260, { name: 'debris_wood' });
  PIECES.crate = new Pool(box, M.crate, 260, { name: 'debris_crate' });
  PIECES.bark = new Pool(box, M.barkPine, 200, { name: 'debris_bark' });
  PIECES.metal = new Pool(box, M.burnt, 120, { name: 'debris_metal' });
  buildCrates();
  for (const b of BARRELS) if (b.im.material === M.barrel[1]) b.fuel = true;
}

/* ---------- Ящики ---------- */
const CRATE_TYPES = [
  { sx: 1.0, sy: 0.4, sz: 0.55, mat: 'crate' },        // армейский
  { sx: 0.95, sy: 0.95, sz: 0.95, mat: 'planks' },     // большой дощатый
  { sx: 0.7, sy: 0.32, sz: 0.4, mat: 'crate' }         // патронный
];
const CRATE_SPOTS = [];
/** Регистрация ящика (из планировщика баз и здесь же). y — основание; возвращает верх. */
export function addCrate(x, z, rot, type = 0, y = null) {
  const T = CRATE_TYPES[type];
  const base = y ?? groundMin(x, z, T.sx / 2, T.sz / 2, rot);
  CRATE_SPOTS.push({ x, z, rot, type, y: base + T.sy / 2 });
  return base + T.sy;
}
function buildCrates() {
  // склады у турбазы, кордона и окопов
  const R = rng(9911);
  const hubs = [[CLUSTERS.T.x, CLUSTERS.T.z, 5, 14], [CLUSTERS.K.x, CLUSTERS.K.z, 5, 14]];
  for (const tr of TRENCHES) {
    const p = tr.pts[Math.floor(tr.pts.length / 2)];
    hubs.push([p[0], p[1], 2, 6]);
  }
  for (const [hx, hz, n, rad] of hubs) for (let i = 0; i < n; i++) {
    for (let t = 0; t < 30; t++) {
      const a = R() * TAU, r = R.range(3, rad);
      const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
      if (!isFree(x, z, 0.8, { pathPad: 0.4, trenchPad: 1.2 })) continue;
      const rot = R() * TAU, type = R.int(0, 2);
      const top = addCrate(x, z, rot, type);
      if (type !== 1 && R() < 0.4) addCrate(x + R.range(-0.1, 0.1), z + R.range(-0.1, 0.1), rot + R.range(-0.3, 0.3), type === 0 ? 2 : 0, top);
      keep(x, z, 1);
      break;
    }
  }
  const byType = CRATE_TYPES.map(() => []);
  for (const c of CRATE_SPOTS) byType[c.type].push(c);
  byType.forEach((list, ti) => {
    if (!list.length) return;
    const T = CRATE_TYPES[ti];
    const g = new THREE.BoxGeometry(T.sx, T.sy, T.sz);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * T.sx / 0.8, uv.getY(i) * Math.max(T.sy, T.sz) / 0.8);
    const im = new THREE.InstancedMesh(g, M[T.mat], list.length);
    im.castShadow = true; im.receiveShadow = true;
    list.forEach((c, i) => {
      _q.setFromAxisAngle(_up, c.rot);
      im.setMatrixAt(i, _m.compose(_v.set(c.x, c.y, c.z), _q, _s.set(1, 1, 1)));
      c.im = im; c.i = i; c.T = T;
      c.col = addBox(c.x, c.y, c.z, T.sx, T.sy, T.sz, c.rot);
      DESTRUCT.crates.push(c);
    });
    im.computeBoundingSphere();
    im.name = 'crates';
    scene.add(im);
  });
}
function breakCrate(c, bx, by, bz, power) {
  c.gone = true; c.col.dead = true;
  c.im.setMatrixAt(c.i, _zero); c.im.instanceMatrix.needsUpdate = true;
  // верхний ящик стопки падает вместе с нижним
  for (const o of DESTRUCT.crates) if (!o.gone && o !== c && Math.hypot(o.x - c.x, o.z - c.z) < 0.4 && o.y > c.y) o.drop = (o.drop || 0) + c.T.sy;
  const T = c.T, pool = T.mat === 'crate' ? 'crate' : 'wood';
  // грани → доски: каждая грань раскалывается на 2–3 доски
  const faces = [[T.sx, T.sz, 0, T.sy / 2, 0], [T.sx, T.sz, 0, -T.sy / 2, 0], [T.sx, T.sy, 0, 0, T.sz / 2], [T.sx, T.sy, 0, 0, -T.sz / 2], [T.sz, T.sy, T.sx / 2, 0, 0], [T.sz, T.sy, -T.sx / 2, 0, 0]];
  const cr = Math.cos(c.rot), sn = Math.sin(c.rot);
  for (const [a, b, lx, ly, lz] of faces) {
    const n = a > 0.6 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * b / n;
      const wx = c.x + lx * cr + lz * sn, wz = c.z - lx * sn + lz * cr, wy = c.y + ly + off * 0.5;
      spawnPiece(pool, wx, wy, wz, a * sr(0.6, 1), 0.025, b / n * 0.9, bx, by, bz, power * 1.2, c.rot);
    }
  }
  for (let i = 0; i < 10; i++) spawnPiece('wood', c.x, c.y, c.z, sr(0.05, 0.2), 0.02, 0.03, bx, by, bz, power * 1.6);
  dust(c.x, c.y, c.z, 6, [0.42, 0.37, 0.3]);
  sfx('splinter', c.x, c.y, c.z, 1);
}
function updateCrates(dt) {
  for (const c of DESTRUCT.crates) {
    if (!c.drop || c.gone) continue;
    const s = Math.min(c.drop, dt * 4);
    c.drop -= s; c.y -= s;
    if (c.drop < 1e-3) c.drop = 0;
    _q.setFromAxisAngle(_up, c.rot);
    c.im.setMatrixAt(c.i, _m.compose(_v.set(c.x, c.y, c.z), _q, _s.set(1, 1, 1))); c.im.instanceMatrix.needsUpdate = true;
    c.col.y0 -= s; c.col.y1 -= s;
  }
}

/* ---------- Обломки: твёрдые тела ---------- */
const _mat3 = new THREE.Matrix4();
function spawnPiece(kind, x, y, z, sx, sy, sz, bx, by, bz, power, rot = srnd() * TAU) {
  const pool = PIECES[kind];
  let slot = pool.alloc();
  if (slot < 0) {
    // пул полон — переиспользуем самый старый обломок того же вида
    let old = null;
    for (const p of DESTRUCT.pieces) if (!p.dead && p.kind === kind && (!old || p.born < old.born)) old = p;
    if (!old) return;
    slot = old.slot; old.dead = true;
  }
  const dx = x - bx, dz = z - bz, d = Math.hypot(dx, dz) + 0.3;
  const sp = power * sr(0.5, 1.2);
  DESTRUCT.pieces.push({
    kind, slot, born: FRAME.t,
    p: new THREE.Vector3(x, y, z),
    v: new THREE.Vector3(dx / d * sp + sr(-1, 1), sp * sr(0.5, 1.1) + 1.5 + (y - by) * 0.5, dz / d * sp + sr(-1, 1)),
    q: new THREE.Quaternion().setFromEuler(_e.set(srnd() * 6, rot, srnd() * 6)),
    w: new THREE.Vector3(sr(-1, 1), sr(-1, 1), sr(-1, 1)).multiplyScalar(4 + sp),
    s: new THREE.Vector3(Math.max(sx, 0.02), Math.max(sy, 0.02), Math.max(sz, 0.02)),
    life: kind === 'metal' ? 70 : sx * sz < 0.01 ? sr(10, 16) : sr(50, 80), rest: 0, float: kind !== 'metal'
  });
}
function updatePieces(dt) {
  const P = DESTRUCT.pieces;
  for (const p of P) {
    if (p.dead) continue;
    p.life -= dt;
    if (p.life <= 0) { p.dead = true; PIECES[p.kind].set(p.slot, _zero); continue; }
    if (p.rest > 1.2 && p.life > 2) continue;
    p.v.y -= 9.8 * dt;
    p.v.multiplyScalar(Math.exp(-0.12 * dt));
    p.p.addScaledVector(p.v, dt);
    const wl = p.w.length();
    if (wl > 1e-3) { _q2.setFromAxisAngle(_ax.copy(p.w).divideScalar(wl), wl * dt); p.q.premultiply(_q2); }
    // полувысота повёрнутого бокса по вертикали
    _mat3.makeRotationFromQuaternion(p.q);
    const e = _mat3.elements;
    const hy = 0.5 * (Math.abs(e[1]) * p.s.x + Math.abs(e[5]) * p.s.y + Math.abs(e[9]) * p.s.z);
    const g = hFast(p.p.x, p.p.z);
    const inWater = g < MAP.WATER_Y && lakeRho(p.p.x, p.p.z) < 1 && p.p.y < MAP.WATER_Y + 0.1;
    if (inWater) {
      if (p.float) {
        // щепа держится на воде и покачивается
        p.v.y += (MAP.WATER_Y - p.p.y) * 30 * dt; p.v.multiplyScalar(Math.exp(-2.5 * dt)); p.w.multiplyScalar(Math.exp(-2 * dt));
        if (!p.splashed) { p.splashed = true; FX.alpha.spawn({ x: p.p.x, y: MAP.WATER_Y, z: p.p.z, vx: 0, vy: 1.2, vz: 0, size: 0.3, grow: 1.2, life: 0.8, col: [0.8, 0.82, 0.85], a: 0.4, grav: 4 }); }
      } else {
        p.v.multiplyScalar(Math.exp(-4 * dt)); p.v.y = Math.max(p.v.y, -0.6);
        if (p.p.y < g + hy) { p.p.y = g + hy; p.rest += dt; }
      }
    } else if (p.p.y - hy < g) {
      p.p.y = g + hy;
      const impact = -p.v.y;
      if (impact > 3.5 && p.s.x * p.s.z > 0.008) sfx('clatter', p.p.x, p.p.y, p.p.z, clamp(impact / 10, 0.1, 1), p.kind);
      p.v.y = impact > 1.2 ? impact * 0.28 : 0;
      p.v.x *= 0.6; p.v.z *= 0.6;
      p.w.multiplyScalar(0.55);
      if (p.v.lengthSq() < 0.6) {
        // ложится плашмя самой широкой гранью, сохраняя курс
        const mn = Math.min(p.s.x, p.s.y, p.s.z);
        const yaw = Math.atan2(e[8], e[10]);
        if (mn === p.s.x) _q2.setFromEuler(_e.set(0, yaw, Math.PI / 2, 'YXZ'));
        else if (mn === p.s.z) _q2.setFromEuler(_e.set(Math.PI / 2, yaw, 0, 'YXZ'));
        else _q2.setFromEuler(_e.set(0, yaw, 0, 'YXZ'));
        p.q.slerp(_q2, Math.min(1, dt * 8));
        p.w.multiplyScalar(0.2);
        p.rest += dt;
      }
    } else p.rest = 0;
    // к концу жизни мелочь тает
    const k = p.life < 2 ? p.life / 2 : 1;
    PIECES[p.kind].set(p.slot, _m.compose(p.p, p.q, _s.copy(p.s).multiplyScalar(k)));
  }
  if (FRAME.n % 120 === 0) DESTRUCT.pieces = P.filter(p => !p.dead);
}

/* ---------- Деревья ---------- */
function fell(t, bx, bz, power) {
  const pools = FALL_POOLS.get(t.variant);
  if (!pools) return;
  // свободный слот или самый старый лежачий ствол
  let slot = -1;
  const used = new Set(DESTRUCT.fallers.filter(f => f.pools === pools).map(f => f.slot));
  for (let i = 0; i < pools.trunk.cap; i++) if (!used.has(i)) { slot = i; break; }
  if (slot < 0) {
    const old = DESTRUCT.fallers.filter(f => f.pools === pools && f.done).sort((a, b) => a.born - b.born)[0];
    if (!old) return;
    slot = old.slot; DESTRUCT.fallers.splice(DESTRUCT.fallers.indexOf(old), 1);
    if (old.col) old.col.dead = true;
  }
  removeTree(t);
  const bh = clamp(sr(0.35, 1.2), 0.3, t.h * 0.15);
  let dx = t.x - bx, dz = t.z - bz;
  if (Math.hypot(dx, dz) < 0.05) { const a = srnd() * TAU; dx = Math.cos(a); dz = Math.sin(a); }
  const a = Math.atan2(dz, dx) + sr(-0.45, 0.45);
  const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const f = {
    t, pools, slot, born: FRAME.t, dir, axis: new THREE.Vector3(dir.z, 0, -dir.x),
    pivot: new THREE.Vector3(t.x, t.y + 0.15 + bh, t.z), len: t.h - bh, theta: 0.015,
    omega: 0.05 + power * 0.12 * (8 / Math.max(6, t.h)), bounces: 0, done: false, creak: false
  };
  DESTRUCT.fallers.push(f);
  writeFaller(f);
  // пень с щепой
  const st = STUMPS[t.sp], si = st.alloc();
  const rS = Math.max(0.12, t.h * 0.021 * 1.3);
  if (si >= 0) {
    _q.setFromAxisAngle(_up, srnd() * TAU);
    st.set(si, _m.compose(_v.set(t.x, t.y, t.z), _q, _s.set(rS, bh + 0.15, rS)), t.barkColor);
  }
  addCircle(t.x, t.z, rS * 0.9, t.y, t.y + bh + 0.15);
  const cx = t.x, cy = f.pivot.y, cz = t.z;
  for (let i = 0; i < 14; i++) spawnPiece(i < 9 ? 'wood' : 'bark', cx + sr(-0.2, 0.2), cy, cz + sr(-0.2, 0.2), sr(0.04, 0.25), sr(0.02, 0.04), sr(0.03, 0.08), bx, cy - 0.5, bz, 6);
  dust(cx, cy, cz, 5, [0.5, 0.42, 0.32]);
  sfx('crack', cx, cy, cz, clamp(t.h / 18, 0.4, 1.2));
}
function writeFaller(f) {
  const t = f.t;
  _q.setFromAxisAngle(f.axis, f.theta);
  _q2.setFromAxisAngle(_up, t.rot);
  _q.multiply(_q2);
  _m.compose(f.pivot, _q, _s.setScalar(f.len));
  f.pools.trunk.set(f.slot, _m, t.barkColor);
  f.pools.crown.set(f.slot, t.dead ? _zero : _m, t.color);
}
function updateFallers(dt) {
  for (const f of DESTRUCT.fallers) {
    if (f.done) continue;
    // стержень на шарнире + трение в изломе
    const alpha = 1.5 * 9.8 / f.len * Math.sin(f.theta) - f.omega * 0.12;
    f.omega += alpha * dt;
    f.theta += f.omega * dt;
    if (!f.creak && f.theta > 0.1) { f.creak = true; sfx('creak', f.pivot.x, f.pivot.y + f.len * 0.5, f.pivot.z, clamp(f.len / 16, 0.4, 1)); }
    // касание земли точками ствола и кроны
    let hit = false;
    for (const k of [0.45, 0.7, 0.95]) {
      const r = k * f.len, sn = Math.sin(f.theta);
      const px = f.pivot.x + f.dir.x * sn * r, pz = f.pivot.z + f.dir.z * sn * r, py = f.pivot.y + Math.cos(f.theta) * r;
      const margin = f.t.dead ? 0.15 : f.len * (0.05 + 0.1 * (1 - k));
      if (py - margin < hFast(px, pz)) { hit = true; break; }
    }
    if (f.theta > Math.PI * 0.62) hit = true;
    if (hit && f.omega > 0) {
      if (f.bounces === 0) impact(f);
      f.omega = -f.omega * (f.bounces === 0 ? 0.16 : 0.1);
      f.bounces++;
      if (f.bounces >= 3 || Math.abs(f.omega) < 0.05) settle(f);
    }
    writeFaller(f);
  }
}
function impact(f) {
  const L = f.len, n = f.t.dead ? 6 : 26;
  for (let i = 0; i < n; i++) {
    const r = sr(0.35, 1) * L;
    const x = f.pivot.x + f.dir.x * r + sr(-1.5, 1.5), z = f.pivot.z + f.dir.z * r + sr(-1.5, 1.5), y = hFast(x, z) + sr(0.2, 1.5);
    // хвоя и сломанные ветки
    FX.dirt.spawn({ x, y, z, vx: sr(-2, 2), vy: sr(1, 4), vz: sr(-2, 2), size: sr(0.12, 0.3), grow: 0.1, life: sr(1.5, 3), col: f.t.sp === 'birch' ? [0.25, 0.34, 0.1] : [0.12, 0.18, 0.08], a: 0.95, grav: 3.5, drag: 1.4, floor: y - 1.5 });
  }
  for (let i = 0; i < 7; i++) {
    const r = sr(0.3, 1) * L, x = f.pivot.x + f.dir.x * r, z = f.pivot.z + f.dir.z * r;
    dust(x, hFast(x, z) + 0.3, z, 2, [0.4, 0.36, 0.3]);
  }
  for (let i = 0; i < 8; i++) {
    const r = sr(0.4, 0.95) * L, x = f.pivot.x + f.dir.x * r, z = f.pivot.z + f.dir.z * r;
    spawnPiece('bark', x, hFast(x, z) + 0.8, z, sr(0.3, 0.9), 0.04, 0.05, x - f.dir.x, hFast(x, z), z - f.dir.z, 3);
  }
  const mx = f.pivot.x + f.dir.x * L * 0.6, mz = f.pivot.z + f.dir.z * L * 0.6;
  shredUndergrowth(mx, mz, 1.8);
  shredBushes(mx, mz, 2.2, f.pivot.x, f.pivot.z, 0.5);
  const d = camera.position.distanceTo(f.pivot);
  BLAST.shake = Math.max(BLAST.shake, clamp(0.5 * L / 18 / (1 + d / 10), 0, 0.5));
  sfx('thud', mx, f.pivot.y, mz, clamp(L / 16, 0.3, 1.3));
}
function settle(f) {
  f.done = true; f.omega = 0;
  // лежачий ствол — укрытие: по нему ходят, за ним прячутся
  const sn = Math.sin(f.theta), cs = Math.cos(f.theta), L = f.len * 0.75;
  const cx = f.pivot.x + f.dir.x * sn * L * 0.5, cz = f.pivot.z + f.dir.z * sn * L * 0.5, cy = f.pivot.y + cs * L * 0.5;
  const r = Math.max(0.2, f.t.h * 0.02);
  f.col = addBox(cx, cy, cz, r * 2, r * 2 + Math.max(0, cs) * L, sn * L, Math.atan2(f.dir.x, f.dir.z));
}

/* ---------- Горящие обломки ---------- */
function burn(x, y, z, ttl) {
  const L = { pos: new THREE.Vector3(x, y + 0.8, z), kind: 'fire', level: 1, power: 26, range: 16, color: new THREE.Color(0xff7a30), seed: srnd() * 100 };
  DYN_LIGHTS.push(L);
  DESTRUCT.fires.push({ x, y: y + 0.2, z, r: 0.5, ttl, L, acc: 0 });
}
function updateFires(dt) {
  for (const f of DESTRUCT.fires) {
    f.ttl -= dt;
    const k = clamp(f.ttl / 6, 0, 1);
    f.L.level = k * (0.75 + 0.2 * Math.sin(FRAME.t * 9 + f.L.seed) + 0.1 * Math.sin(FRAME.t * 17.3));
    f.acc += dt;
    while (f.acc > 0.045 && f.ttl > 0) {
      f.acc -= 0.045;
      FX.add.spawn({ x: f.x + sr(-f.r, f.r), y: f.y, z: f.z + sr(-f.r, f.r), vx: sr(-0.2, 0.2), vy: sr(1, 2.2), vz: sr(-0.2, 0.2), size: sr(0.4, 0.8) * (0.4 + k * 0.6), grow: -0.25, life: sr(0.4, 0.9), col: [1.7, 0.85, 0.35], a: 0.9, cool: 0.45, windK: 0.4 });
      if (srnd() < 0.3) FX.alpha.spawn({ x: f.x, y: f.y + 1, z: f.z, vx: 0, vy: sr(0.8, 1.6), vz: 0, size: sr(0.6, 1.1), grow: 0.9, life: sr(4, 7), col: [0.12, 0.11, 0.1], a: 0.45 * k, fadeIn: 0.4, windK: 1.4, drag: 0.3 });
    }
  }
  if (DESTRUCT.fires.some(f => f.ttl <= 0)) {
    for (const f of DESTRUCT.fires) if (f.ttl <= 0) DYN_LIGHTS.splice(DYN_LIGHTS.indexOf(f.L), 1);
    DESTRUCT.fires = DESTRUCT.fires.filter(f => f.ttl > 0);
  }
}

function dust(x, y, z, n, col) {
  for (let i = 0; i < n; i++) FX.alpha.spawn({ x: x + sr(-0.5, 0.5), y: y + sr(0, 0.6), z: z + sr(-0.5, 0.5), vx: sr(-0.8, 0.8), vy: sr(0.2, 1), vz: sr(-0.8, 0.8), size: sr(0.8, 1.6), grow: 0.9, life: sr(2, 4), col, a: 0.35, fadeIn: 0.15, windK: 1, drag: 0.8 });
}

/** Взрыв: что сломать, что поджечь, что срезать. */
export function blastDestruct(x, y, z, size, kind) {
  const R = 2.4 + 2.6 * size;
  // деревья: тонкие ломаются дальше от центра, толстые — только вплотную
  for (const t of treesNear(x, z, R + 1)) {
    const d = Math.hypot(t.x - x, t.z - z);
    const thick = clamp(t.h / 22, 0.3, 1.2);
    if (d < R * (1.05 - thick * 0.45) || (d < R && srnd() < 0.35)) fell(t, x, z, size * 6 * (1 - d / (R + 1)));
  }
  for (const c of DESTRUCT.crates) {
    if (c.gone) continue;
    const d = Math.hypot(c.x - x, c.z - z, (c.y - y) * 0.7);
    if (d < 2.2 + 2.2 * size) breakCrate(c, x, y, z, 7 * size * (1 - d / (2.4 + 2.2 * size)) + 2);
  }
  // топливные бочки детонируют с задержкой — цепная реакция
  for (const b of BARRELS) {
    if (!b.fuel || b.gone) continue;
    if (b.pos.distanceTo(_v.set(x, y, z)) < 3.5 * size + 1.2) {
      b.gone = true;
      setTimeout(() => detonateBarrel(b), 250 + srnd() * 700);
    }
  }
  const cut = shredUndergrowth(x, z, 1.4 + size * 1.3);
  const cutB = shredBushes(x, z, 1.6 + size * 1.5, x, z, size);
  const cutR = shredReeds(x, z, 1.5 + size * 1.4);
  for (const c of [...cut, ...cutB, ...cutR]) {
    const n = c.kind === 'sapling' || c.kind === 'bush' ? 7 : 3;
    const gy = hFast(c.x, c.z), dx = c.x - x, dz = c.z - z, dd = Math.hypot(dx, dz) + 0.3;
    for (let i = 0; i < n; i++) {
      FX.dirt.spawn({ x: c.x, y: gy + sr(0.2, 1.2), z: c.z, vx: dx / dd * sr(2, 7), vy: sr(2, 7), vz: dz / dd * sr(2, 7), size: sr(0.08, 0.22), grow: 0, life: sr(1.5, 3.5), col: c.kind === 'reed' ? [0.34, 0.33, 0.14] : [0.1, 0.2, 0.06], a: 0.95, grav: 5, drag: 1.2, floor: Math.max(gy, MAP.WATER_Y) });
    }
  }
}
function detonateBarrel(b) {
  b.im.setMatrixAt(b.k, _zero); b.im.instanceMatrix.needsUpdate = true;
  b.col.dead = true; b.rest = 99; b.dead = true;
  const { x, y, z } = b.pos;
  explode(x, y, z, 'fuel');
  for (let i = 0; i < 6; i++) spawnPiece('metal', x, y + 0.2, z, sr(0.25, 0.5), 0.02, sr(0.2, 0.4), x, y - 0.5, z, 9);
  burn(x, hFast(x, z), z, sr(22, 35));
}

export function updateDestruct(dt) {
  updateFallers(dt);
  updatePieces(dt);
  updateCrates(dt);
  updateFires(dt);
}
export const destructStats = () => ({ fallen: DESTRUCT.fallers.length, pieces: DESTRUCT.pieces.filter(p => !p.dead).length, crates: DESTRUCT.crates.filter(c => !c.gone).length, fires: DESTRUCT.fires.length });
