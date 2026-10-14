/**
 * The view onto the board: screen = board * k + (x, y).
 *
 * The board itself is one transformed element, so panning and zooming never
 * re-lay anything out. The dot grid is the stage background, moved and
 * scaled to match, and thinned out when zoomed far out so it never turns into
 * a grey wash.
 */

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 4;
const GRID = 24;

export function createCamera(stage, world, onChange) {
  const cam = { x: 0, y: 0, k: 1 };
  let queued = false;

  function apply() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    let spacing = GRID * cam.k;
    while (spacing < 12) spacing *= 4;
    stage.style.backgroundSize = `${spacing}px ${spacing}px`;
    stage.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    stage.style.setProperty('--pm-k', String(cam.k));
    onChange();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  }

  const camera = {
    get x() { return cam.x; },
    get y() { return cam.y; },
    get k() { return cam.k; },
    toWorld(sx, sy) {
      return { x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k };
    },
    toScreen(wx, wy) {
      return { x: wx * cam.k + cam.x, y: wy * cam.k + cam.y };
    },
    rectToScreen(r) {
      const p = camera.toScreen(r.x, r.y);
      return { x: p.x, y: p.y, w: r.w * cam.k, h: r.h * cam.k };
    },
    /** The part of the board currently on screen. */
    visibleRect() {
      const a = camera.toWorld(0, 0);
      const b = camera.toWorld(stage.clientWidth, stage.clientHeight);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    },
    set(x, y, k, now = false) {
      cam.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
      cam.x = x;
      cam.y = y;
      if (now) apply();
      else schedule();
    },
    panBy(dx, dy) {
      camera.set(cam.x + dx, cam.y + dy, cam.k);
    },
    /** Zooms by a factor, keeping the board point under (sx, sy) still. */
    zoomAt(sx, sy, factor) {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.k * factor));
      const w = camera.toWorld(sx, sy);
      camera.set(sx - w.x * k, sy - w.y * k, k);
    },
    zoomTo(k) {
      camera.zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, k / cam.k);
    },
    /** Frames a board rectangle, leaving room for the toolbars. */
    fit(rect, { maxZoom = 1, now = false } = {}) {
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const left = W > 720 ? 72 : 16;
      const top = 72;
      const right = 24;
      const bottom = W > 720 ? 64 : 80;
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        camera.set(left + (W - left - right) / 2 - (rect?.x ?? 0), top + (H - top - bottom) / 2 - (rect?.y ?? 0), 1, now);
        return;
      }
      const k = Math.min(maxZoom, (W - left - right) / rect.w, (H - top - bottom) / rect.h);
      const kk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
      camera.set(left + (W - left - right) / 2 - (rect.x + rect.w / 2) * kk, top + (H - top - bottom) / 2 - (rect.y + rect.h / 2) * kk, kk, now);
    },
    centreOn(point) {
      camera.set(stage.clientWidth / 2 - point.x * cam.k, stage.clientHeight / 2 - point.y * cam.k, cam.k);
    },
    snapshot() {
      return { ...cam };
    },
  };
  apply();
  return camera;
}
