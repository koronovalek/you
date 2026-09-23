import * as THREE from 'three';
import { scene, camera, Q, NO_REFLECT } from '../core/env.js';
import { rng, TAU, lerp, clamp } from '../core/math.js';
import { MAP, isFree, lakeRho, pathInfluence, edgeDist, CLUSTERS } from './layout.js';
import { hFast } from './heightcache.js';
import { forestDensity, treeNear } from './forest.js';
import { M, TEX, depthFor, addTranslucency } from '../gen/materials.js';
import { injectWind } from './wind.js';
import { addSoft } from '../core/colliders.js';

/* ============================================================================
   КУСТЫ
   Лиственный подлесок — лещина, ива у воды, крушина по опушкам — и тёмные
   конусы можжевельника. Геометрия процедурная: веер стеблей от корня, листва
   карточками по верхним двум третям, нормали «сферические» от центра куста,
   поэтому куст освещается как объём, а против солнца светится. Сквозь куст
   можно продраться, но он тормозит и расступается (мягкая коллизия), от взрыва
   ложится и разлетается листвой.
============================================================================ */
const BUSH = { tiles: [], mats: [] };
const TILE = 40;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0), _ax = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

class G {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; }
  v(p, n, u, v, k) { this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.uv.push(u, v); this.c.push(k, k, k); return this.p.length / 3 - 1; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Лиственный куст высотой ~1: стебли + карточки листьев. */
function leafyBush(seed, quad, wide) {
  const R = rng(seed), F = new G();
  const center = V(0, 0.55, 0);
  const stems = R.int(7, 11);
  for (let s = 0; s < stems; s++) {
    const a = R() * TAU, spread = R.range(0.25, 0.6) * wide;
    const h = R.range(0.7, 1.05);
    const base = V(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06);
    const tip = V(Math.cos(a) * spread, h, Math.sin(a) * spread);
    const cards = R.int(5, 8);
    for (let k = 0; k < cards; k++) {
      const t = lerp(0.35, 1, k / (cards - 1)) + R.range(-0.05, 0.05);
      // точка на изогнутом стебле: наружу сильнее к вершине
      const pt = V(lerp(base.x, tip.x, Math.pow(t, 0.7)), lerp(base.y, tip.y, t), lerp(base.z, tip.z, Math.pow(t, 0.7)));
      const size = R.range(0.26, 0.42) * (1.1 - t * 0.3);
      const out = V(pt.x, 0, pt.z).normalize();
      if (out.lengthSq() < 0.1) out.set(1, 0, 0);
      const yaw = Math.atan2(out.z, out.x) + R.range(-0.9, 0.9);
      const side = V(-Math.sin(yaw), 0, Math.cos(yaw));
      const upv = V(Math.cos(yaw) * R.range(0.1, 0.6), 1, Math.sin(yaw) * R.range(0.1, 0.6)).normalize();
      const q = [quad % 2 * 0.5, Math.floor(quad / 2) * 0.5];
      const idx = [];
      for (let vv = 0; vv <= 1; vv++) for (let uu = 0; uu <= 1; uu++) {
        const p = pt.clone().addScaledVector(side, (uu - 0.5) * size).addScaledVector(upv, (vv - 0.35) * size);
        const n = p.clone().sub(center).normalize(); n.y = n.y * 0.6 + 0.45; n.normalize();
        const ao = clamp(0.45 + p.distanceTo(center) * 0.9 + p.y * 0.25, 0.4, 1.1);
        idx.push(F.v(p, n, q[0] + uu * 0.5, q[1] + vv * 0.5, ao));
      }
      F.i.push(idx[0], idx[1], idx[2], idx[1], idx[3], idx[2]);
    }
  }
  return F.build();
}
/** Можжевельник: узкий конус из ярусов еловых лап. */
function juniper(seed) {
  const R = rng(seed), F = new G();
  const center = V(0, 0.5, 0);
  const tiers = 9;
  for (let t = 0; t < tiers; t++) {
    const k = t / (tiers - 1), y = lerp(0.05, 0.95, k), rad = (1 - k) * 0.28 + 0.05;
    const n = 7;
    for (let b = 0; b < n; b++) {
      const a = b / n * TAU + R.range(-0.3, 0.3) + t;
      const dir = V(Math.cos(a), R.range(0.2, 0.7), Math.sin(a)).normalize();
      const side = V(-Math.sin(a), 0, Math.cos(a));
      const L = rad * R.range(1.1, 1.5) + 0.12, W = L * 0.9;
      const q = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]][R.int(0, 3)];
      const idx = [];
      for (let s = 0; s <= 1; s++) for (let e = 0; e <= 1; e++) {
        const p = V(0, y, 0).addScaledVector(dir, L * s).addScaledVector(side, (e - 0.5) * W * (s ? 1 : 0.4));
        const nn = p.clone().sub(center).normalize(); nn.y = nn.y * 0.5 + 0.5; nn.normalize();
        idx.push(F.v(p, nn, q[0] + s * 0.5, q[1] + e * 0.5, lerp(0.45, 1, s) * (0.8 + k * 0.3)));
      }
      F.i.push(idx[0], idx[2], idx[1], idx[1], idx[2], idx[3]);
    }
  }
  return F.build();
}

export function buildBushes() {
  const R = rng(8080);
  const wind = { amp: 0.14, stiff: 1.3, refH: 2.2, flutter: 0.07, trample: true, blast: 1.2, branch: 0.05 };
  M.bush.vertexColors = true;
  injectWind(M.bush, wind);
  const jmat = new THREE.MeshStandardMaterial({ map: TEX.spruce, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, vertexColors: true });
  jmat.emissive = new THREE.Color(0x060a05);
  addTranslucency(jmat, 0.6);
  injectWind(jmat, { amp: 0.06, stiff: 1.4, refH: 2, flutter: 0.03, trample: true, blast: 1, branch: 0.02 });
  const bushDepth = depthFor(M.bush, wind), junDepth = depthFor(jmat, { amp: 0.06, stiff: 1.4, refH: 2, flutter: 0.03, blast: 1 });
  const kinds = [
    { geo: leafyBush(11, 0, 1.0), mat: M.bush, depth: bushDepth, kind: 'bush', tint: [1, 1, 1], soft: 0.42 },          // лещина
    { geo: leafyBush(23, 1, 1.25), mat: M.bush, depth: bushDepth, kind: 'bush', tint: [0.95, 1.02, 1.0], soft: 0.45 },  // ива
    { geo: leafyBush(37, 2, 0.85), mat: M.bush, depth: bushDepth, kind: 'bush', tint: [0.9, 0.95, 0.9], soft: 0.38 },   // крушина
    { geo: leafyBush(41, 3, 1.1), mat: M.bush, depth: bushDepth, kind: 'bush', tint: [1.05, 1.05, 0.95], soft: 0.42 },
    { geo: juniper(53), mat: jmat, depth: junDepth, kind: 'juniper', tint: [0.7, 0.85, 0.8], soft: 0.3 }
  ];
  const lists = kinds.map(() => []);
  const want = Math.round(1500 * (Q.ferns ?? 1));
  for (let t = 0; t < want * 14 && lists.reduce((a, l) => a + l.length, 0) < want; t++) {
    const x = R.range(-MAP.PLAY + 3, MAP.PLAY - 3), z = R.range(-MAP.PLAY + 3, MAP.PLAY - 3);
    const d = forestDensity(x, z), rho = lakeRho(x, z);
    const pe = pathInfluence(x, z, 3.2) > 0 && pathInfluence(x, z, 1.4) === 0;
    // опушки, обочины троп, берег; под сомкнутым пологом — редко
    let p = 0.08 + (d > 0.2 && d < 0.65 ? 0.45 : 0) + (pe ? 0.35 : 0) + (rho > 1.08 && rho < 1.7 ? 0.55 : 0);
    for (const c of Object.values(CLUSTERS)) if (Math.hypot(x - c.x, z - c.z) < 30) p += 0.25;
    if (R() > p * 0.6) continue;
    if (!isFree(x, z, 0.9, { pathPad: 0.5, trenchPad: 1.2 }) || treeNear(x, z, 0.9)) continue;
    let k;
    if (rho < 1.7) k = R() < 0.7 ? 1 : 0;
    else if (d > 0.5 && R() < 0.3) k = 4;
    else k = [0, 2, 3, 0][R.int(0, 3)];
    lists[k].push([x, z]);
  }
  kinds.forEach((K, ki) => {
    const tiles = new Map();
    for (const p of lists[ki]) {
      const key = Math.floor(p[0] / TILE) * 1024 + Math.floor(p[1] / TILE);
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(p);
    }
    for (const list of tiles.values()) {
      const im = new THREE.InstancedMesh(K.geo, K.mat, list.length);
      const tile = { im, items: [], x: 0, z: 0, kind: K.kind };
      list.forEach(([x, z], i) => {
        const h = K.kind === 'juniper' ? R.range(1.4, 3.2) : R.range(1.1, 2.6);
        const w = h * R.range(0.8, 1.25) * (K.kind === 'juniper' ? 0.8 : 1);
        const y = hFast(x, z) - 0.06;
        _p.set(x, y, z); _q.setFromAxisAngle(_up, R() * TAU); _s.set(w, h, w);
        _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
        const v = R.range(0.8, 1.15); _c.setRGB(v * K.tint[0], v * K.tint[1], v * K.tint[2]); im.setColorAt(i, _c);
        const it = { x, z, i, m: _m.clone(), h };
        it.soft = addSoft(x, z, w * K.soft, y, y + h, K.kind);
        tile.items.push(it);
        tile.x += x / list.length; tile.z += z / list.length;
      });
      im.castShadow = Q.shadowTrees; im.receiveShadow = true;
      im.customDepthMaterial = K.depth;
      im.computeBoundingSphere();
      im.name = 'bushes';
      scene.add(im); NO_REFLECT.push(im);
      BUSH.tiles.push(tile);
    }
  });
}
/** Видимость по дистанции (кусты мельче деревьев — дальше 160 м не нужны). */
export function updateBushes() {
  const cp = camera.position;
  for (const t of BUSH.tiles) t.im.visible = Math.hypot(t.x - cp.x, t.z - cp.z) < 160 + TILE;
}
/** Взрыв: ближние кусты разлетаются, дальние ложатся от центра. */
export function shredBushes(x, z, r, bx, bz, power) {
  const out = [];
  for (const t of BUSH.tiles) {
    if (Math.hypot(t.x - x, t.z - z) > r * 1.8 + TILE) continue;
    let dirty = false;
    for (const it of t.items) {
      if (it.gone) continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (d > r * 1.8) continue;
      dirty = true;
      if (d < r) {
        it.gone = true; t.im.setMatrixAt(it.i, _zero);
        if (it.soft) it.soft.dead = true;
        out.push({ x: it.x, z: it.z, kind: 'bush' });
      } else {
        it.m.decompose(_p, _q, _s);
        _ax.set(it.z - bz, 0, bx - it.x).normalize();
        _q.premultiply(new THREE.Quaternion().setFromAxisAngle(_ax, 0.5 * (1 - (d - r) / (r * 0.8))));
        _s.multiplyScalar(0.85);
        it.m.compose(_p, _q, _s);
        t.im.setMatrixAt(it.i, it.m);
      }
    }
    if (dirty) t.im.instanceMatrix.needsUpdate = true;
  }
  return out;
}
export const bushStats = () => ({ bushes: BUSH.tiles.reduce((a, t) => a + t.items.filter(i => !i.gone).length, 0) });
