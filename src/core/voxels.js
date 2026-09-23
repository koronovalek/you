/* ============================================================================
   ВОКСЕЛЬНАЯ КАРТА ЗАНЯТОСТИ (для дрона)
   Статическая геометрия после сборки растеризуется в битовую сетку 0.35 м:
   дрон сталкивается ровно с тем, что видно, — крыши, заборы, лодки, перила,
   ежи, беседка. Невидимых стен нет: занята только клетка, через которую
   проходит настоящий треугольник.
============================================================================ */
const CELL = 0.35, X0 = -130, Z0 = -130, Y0 = -8, NX = Math.ceil(260 / CELL), NZ = NX, NY = Math.ceil(40 / CELL);
const BITS = new Uint8Array(Math.ceil(NX * NY * NZ / 8));
export const VOX = { CELL, cells: 0 };

const idx = (i, j, k) => (j * NZ + k) * NX + i;
function mark(x, y, z) {
  const i = Math.floor((x - X0) / CELL), j = Math.floor((y - Y0) / CELL), k = Math.floor((z - Z0) / CELL);
  if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) return;
  const n = idx(i, j, k), b = 1 << (n & 7);
  if (!(BITS[n >> 3] & b)) { BITS[n >> 3] |= b; VOX.cells++; }
}
export function solid(i, j, k) {
  if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) return false;
  const n = idx(i, j, k);
  return (BITS[n >> 3] & (1 << (n & 7))) !== 0;
}
/** Треугольники мировых координат (плоский массив позиций без индексов). */
export function voxelize(pos) {
  const step = CELL * 0.7;
  for (let t = 0; t + 8 < pos.length; t += 9) {
    const ax = pos[t], ay = pos[t + 1], az = pos[t + 2], bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5], cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(e / step));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      mark(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
    }
  }
}
/** Выталкивание сферы из занятых клеток. Возвращает true при контакте;
    out — нормаль последнего толчка (для гашения скорости). */
export function voxPush(p, r, out) {
  let hit = false;
  for (let it = 0; it < 3; it++) {
    const i0 = Math.floor((p.x - r - X0) / CELL), i1 = Math.floor((p.x + r - X0) / CELL);
    const j0 = Math.floor((p.y - r - Y0) / CELL), j1 = Math.floor((p.y + r - Y0) / CELL);
    const k0 = Math.floor((p.z - r - Z0) / CELL), k1 = Math.floor((p.z + r - Z0) / CELL);
    let best = 0, nx = 0, ny = 0, nz = 0;
    for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      if (!solid(i, j, k)) continue;
      const bx0 = X0 + i * CELL, by0 = Y0 + j * CELL, bz0 = Z0 + k * CELL;
      const qx = Math.max(bx0, Math.min(p.x, bx0 + CELL)), qy = Math.max(by0, Math.min(p.y, by0 + CELL)), qz = Math.max(bz0, Math.min(p.z, bz0 + CELL));
      let dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
      let d = Math.hypot(dx, dy, dz);
      if (d >= r) continue;
      if (d < 1e-5) { dx = p.x - (bx0 + CELL / 2); dy = p.y - (by0 + CELL / 2); dz = p.z - (bz0 + CELL / 2); d = Math.hypot(dx, dy, dz) || 1; }
      const pen = r - Math.min(d, r);
      if (pen > best) { best = pen; nx = dx / d; ny = dy / d; nz = dz / d; }
    }
    if (best <= 0) break;
    p.x += nx * best; p.y += ny * best; p.z += nz * best;
    if (out) out.set(nx, ny, nz);
    hit = true;
  }
  return hit;
}
/** Отдельные (не объединённые) меши сцены: мостки, лодки, беседка, камни. */
export function voxelizeLoose(scene, THREE) {
  const v = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.name === 'static' || !o.visible) return;
    const m = o.material;
    if (!m || m.isShaderMaterial || m.transparent || m.alphaTest || !m.isMeshStandardMaterial) return;
    if (/terrain|lake|grass|crater/.test(o.name)) return;
    const g = o.geometry, p = g.attributes.position;
    if (!p || p.count > 20000) return;
    const I = g.index, n = I ? I.count : p.count, out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      v.fromBufferAttribute(p, I ? I.getX(k) : k).applyMatrix4(o.matrixWorld);
      out[k * 3] = v.x; out[k * 3 + 1] = v.y; out[k * 3 + 2] = v.z;
    }
    voxelize(out);
  });
}
