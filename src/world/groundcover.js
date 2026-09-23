import * as THREE from 'three';
import { scene, camera, Q, NO_REFLECT } from '../core/env.js';
import { rng, hash2, TAU, lerp } from '../core/math.js';
import { MAP, isFree, lakeRho, edgeDist } from './layout.js';
import { hFast, grassDensity } from './heightcache.js';
import { forestDensity, treeNear, saplingGeo } from './forest.js';
import { M } from '../gen/materials.js';
import { injectWind } from './wind.js';
import { addSoft } from '../core/colliders.js';

/* ============================================================================
   ПОДЛЕСОК: трава вокруг камеры, папоротник, черничник, подрост ёлок.
   Трава пересобирается по мере движения; позиции берутся из хеша ячейки,
   поэтому при возврате на место травинки те же — ничего не «прыгает».
============================================================================ */
export { GRASS, buildGrass, refreshGrass, finishGrass } from './grass.js';

const UG_TILE = 40;
const UNDER = [];      // плитки подлеска: {im, items, far, low}
const _cv = new THREE.Vector3();
/** Видимость плиток по дистанции; с высоты дрона мелочь не рисуется. */
export function updateUndergrowth() {
  const cp = camera.position;
  const agl = cp.y - hFast(cp.x, cp.z);
  for (const t of UNDER) {
    const d = Math.hypot(t.x - cp.x, t.z - cp.z) - UG_TILE * 0.7;
    t.im.visible = d < t.far && !(t.low && agl > 70);
  }
}
/** Взрыв: подлесок в радиусе r срезает (инстанс гасится), чуть дальше — приминает.
    Возвращает срезанные точки: из них летят листья и ветки. */
export function shredUndergrowth(x, z, r) {
  const out = [];
  for (const t of UNDER) {
    if (Math.hypot(t.x - x, t.z - z) > r + UG_TILE) continue;
    let dirty = false;
    for (const it of t.items) {
      if (it.gone) continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (d > r * 1.5) continue;
      if (d < r) {
        it.gone = true;
        _m.makeScale(0, 0, 0); t.im.setMatrixAt(it.i, _m);
        out.push({ x: it.x, z: it.z, s: it.s, kind: t.kind });
        if (it.soft) it.soft.dead = true;
      } else {
        // приминание: ниже и с наклоном от центра взрыва
        it.m.decompose(_p, _q, _s);
        _s.y *= 0.55; _cv.set(it.z - z, 0, x - it.x).normalize();
        _q.premultiply(new THREE.Quaternion().setFromAxisAngle(_cv, 0.5));
        t.im.setMatrixAt(it.i, _m.compose(_p, _q, _s));
      }
      dirty = true;
    }
    if (dirty) t.im.instanceMatrix.needsUpdate = true;
  }
  return out;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);

function clumpGeo(planes, w, h, segs = 2) {
  const parts = [];
  for (let p = 0; p < planes; p++) {
    const g = new THREE.PlaneGeometry(w, h, 1, segs);
    g.translate(0, h / 2, 0);
    g.rotateY(p / planes * Math.PI + 0.2);
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 0.9, n.getZ(i) * 0.3);
    parts.push(g);
  }
  const merged = new THREE.BufferGeometry();
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of parts) {
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + off);
    off += g.attributes.position.count;
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  return merged;
}

/** Статичный подлесок по всей игровой зоне. */
export function buildUndergrowth() {
  const R = rng(4242);
  injectWind(M.fern, { amp: 0.12, stiff: 1.5, refH: 0.9, flutter: 0.05, trample: true, blast: 1.2 });
  injectWind(M.shrub, { amp: 0.05, stiff: 1.5, refH: 0.5, flutter: 0.03, trample: true, blast: 1.0 });
  const place = (count, mat, geo, test, scale, tint, o = {}) => {
    const pts = [];
    for (let k = 0; k < count * 6 && pts.length < count; k++) {
      const x = R.range(-MAP.FENCE, MAP.FENCE), z = R.range(-MAP.FENCE, MAP.FENCE);
      if (!test(x, z)) continue;
      pts.push([x, z]);
    }
    // плитки 40 м: отсечение по пирамиде и дистанции, адресное разрушение
    const tiles = new Map();
    for (const p of pts) {
      const k = Math.floor(p[0] / UG_TILE) * 1024 + Math.floor(p[1] / UG_TILE);
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(p);
    }
    for (const list of tiles.values()) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const tile = { im, items: [], far: o.far ?? 95, low: !!o.low, x: 0, z: 0, kind: o.kind };
      list.forEach(([x, z], i) => {
        const s = R.range(scale[0], scale[1]);
        const y = hFast(x, z) - 0.04 - (o.sink ?? 0) * s;
        _p.set(x, y, z); _q.setFromAxisAngle(_up, R.range(0, TAU)); _s.set(s, s * R.range(0.8, 1.15), s);
        _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
        const v = R.range(0.75, 1.15); _c.setRGB(v * tint[0], v * tint[1], v * tint[2]); im.setColorAt(i, _c);
        const it = { x, z, i, s, m: _m.clone() };
        tile.items.push(it);
        tile.x += x / list.length; tile.z += z / list.length;
        if (o.soft) it.soft = addSoft(x, z, s * o.soft, y, y + s * (o.softH ?? 1), o.kind);
      });
      im.receiveShadow = true; im.castShadow = !!o.cast; im.frustumCulled = true;
      im.computeBoundingSphere();
      scene.add(im); NO_REFLECT.push(im);
      UNDER.push(tile);
    }
  };
  // папоротник — в тени и сырости
  place(Math.round(9000 * Q.ferns), M.fern, fernGeo(), (x, z) => {
    const d = forestDensity(x, z);
    return R() < d * 0.9 && isFree(x, z, 0.4, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.4) && edgeDist(x, z) < MAP.PLAY - 1;
  }, [0.7, 1.3], [0.95, 1, 0.9], { low: true, kind: 'fern' });
  // черничник — ковром на опушках
  place(Math.round(7000 * Q.ferns), M.shrub, clumpGeo(2, 0.7, 0.42, 1), (x, z) => {
    const d = forestDensity(x, z);
    return R() < 0.25 + d * 0.5 && isFree(x, z, 0.35, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.3);
  }, [0.7, 1.4], [1, 1, 1], { low: true, kind: 'shrub' });
  // подрост ёлок: укрытие от взгляда, но не от пули
  const sap = saplingGeo();
  place(Math.round(1400 * Q.trees), M.spruce, sap, (x, z) => {
    const d = forestDensity(x, z);
    return R() < d * 0.7 && isFree(x, z, 0.6, { pathPad: 0.8, trenchPad: 1.2 }) && !treeNear(x, z, 1.2) && edgeDist(x, z) < MAP.FENCE;
  }, [1.2, 3.2], [0.8, 0.95, 0.85], { far: 170, soft: 0.22, softH: 1, kind: 'sapling', cast: Q.shadowTrees });
}
/** Папоротник: вайи веером от центра, наклонены наружу. */
function fernGeo() {
  const pos = [], nrm = [], uv = [], idx = [];
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = f / fronds * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    for (let k = 0; k <= 2; k++) {
      const t = k / 2, L = 0.62 * t;
      const y = Math.sin(t * 1.9) * 0.34;         // дуга вверх и вниз к кончику
      for (let e = 0; e <= 1; e++) {
        const w = (e - 0.5) * 0.34;
        pos.push(ca * L - sa * w, y, sa * L + ca * w);
        nrm.push(ca * 0.2, 0.95, sa * 0.2);
        uv.push(e, t);
      }
    }
    for (let k = 0; k < 2; k++) { const i = base + k * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
