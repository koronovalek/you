import { renderer, Q } from './env.js';
import { composer, resizePost } from '../fx/post.js';

/* ============================================================================
   ДИНАМИЧЕСКОЕ РАЗРЕШЕНИЕ
   Графика не урезается: тени, трава, отражения, эффекты остаются как есть —
   если кадр не укладывается в бюджет, чуть снижается внутреннее разрешение
   (SMAA и блум скрывают разницу), а при запасе — возвращается. Решение
   принимается по сглаженному времени кадра с паузами, без «пилы».
============================================================================ */
export const PERF = { scale: 1, ms: 16.7, min: 0.62, low: false, fixed: false };
let cool = 2, applied = 1;

function apply() {
  const pr = Math.min(devicePixelRatio, Q.pixel) * PERF.scale;
  if (Math.abs(pr - applied) < 0.01) return;
  applied = pr;
  renderer.setPixelRatio(pr);
  if (composer) { composer.setPixelRatio(pr); resizePost(); }
}
export function updatePerf(dt) {
  if (PERF.fixed || dt <= 0 || dt > 0.25) return;
  PERF.ms += (dt * 1000 - PERF.ms) * 0.06;
  cool -= dt;
  PERF.low = PERF.scale < 0.8;
  if (cool > 0) return;
  // ~52 fps и хуже — ниже на ступень; 66+ fps — выше
  if (PERF.ms > 19.2 && PERF.scale > PERF.min) { PERF.scale = Math.max(PERF.min, PERF.scale - 0.07); apply(); cool = 0.8; }
  else if (PERF.ms < 15.2 && PERF.scale < 1) { PERF.scale = Math.min(1, PERF.scale + 0.04); apply(); cool = 2.5; }
}
export function initPerf() { applied = renderer.getPixelRatio(); PERF.fixed = new URLSearchParams(location.search).has('shot'); }
