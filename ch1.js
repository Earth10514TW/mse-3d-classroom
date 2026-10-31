'use strict';
(function () {
  /* =====================================================================
     Shared helpers
     ===================================================================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D2R = Math.PI / 180, S2 = Math.SQRT2, S3 = Math.sqrt(3);
  const EPS = 1e-6;
  const HAS3D = typeof THREE !== 'undefined' && THREE.OrbitControls;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  /* Language: every string lives next to its translation. tx() picks one at call time, DATA tables are rebuilt and
     HOOKS rewrite the generated text, so switching language never touches the 3D scenes or the state of any control. */
  const X = window.XI18N || { stored: () => 'en', save() {}, apply() {} };
  let LANG = X.stored();
  const tx = (en, zh) => (LANG === 'zh' ? zh : en);
  const DATA = [], HOOKS = [];
  const dataset = f => { DATA.push(f); f(); };
  const onLang = f => HOOKS.push(f);

  const COL = { corner: '#4F7FE0', face: '#1FA386', body: '#E7962A', plane: '#7A5CF0' };
  const T = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['stage', 'edge3d', 'ghost3d', 'ink', 'muted', 'accent', 'line', 'hi', 'grid', 'surface', 'ok', 'bad', 'film', 'filmline'])
      T[k] = cs.getPropertyValue('--' + k).trim();
  }
  readTheme();

  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
  const gcdN = arr => arr.reduce((g, x) => gcd(g, x), 0);
  const isInt = x => Math.abs(x - Math.round(x)) < EPS;
  const frac = x => { const f = x - Math.floor(x + EPS); return Math.abs(f) < EPS ? 0 : f; };
  const fmt = (x, d = 3) => (Math.abs(x) < 5e-10 ? 0 : x).toFixed(d);

  // Index formatting: negative numbers get an overbar, e.g. [1 -1 0] -> 1 1̄ 0
  function idxHTML(arr, br = '()') {
    return '<span class="idx">' + br[0] + arr.map(n => n < 0 ? `<span class="bar">${-n}</span>` : String(n)).join(arr.some(n => Math.abs(n) > 9) ? ' ' : '') + br[1] + '</span>';
  }
  const idxText = (arr, br = '()') => br[0] + arr.map(n => String(n)).join('') + br[1]; // "-" handled by sprite renderer
  const UNI = { '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞' };
  function fracStr(x) {
    if (!isFinite(x)) return '∞';
    if (isInt(x)) return String(Math.round(x)).replace('-', '−');
    const s = x < 0 ? '−' : ''; x = Math.abs(x);
    for (let den = 2; den <= 12; den++) {
      const num = x * den;
      if (isInt(num)) { const n = Math.round(num), g = gcd(n, den); const k = `${n / g}/${den / g}`; return s + (UNI[k] || k); }
    }
    return s + x.toFixed(3);
  }
  const fracTxt = x => fracStr(x); // for sprite labels (unicode fractions render fine)

  function seg(el, onPick) {
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      setSeg(el, b.dataset.v); onPick(b.dataset.v);
    });
  }
  function setSeg(el, v) { $$('button', el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
  const intIn = (el, lo = -4, hi = 4) => { let v = parseInt(el.value, 10); if (isNaN(v)) v = 0; return Math.max(lo, Math.min(hi, v)); };

  /* =====================================================================
     One WebGL renderer shared by every 3D stage (copied onto 2D canvases)
     ===================================================================== */
  let GL = null;
  if (HAS3D) {
    try { GL = new THREE.WebGLRenderer({ antialias: true, alpha: true }); GL.setPixelRatio(1); GL.localClippingEnabled = true; }
    catch (e) { GL = null; }
  }
  let glW = 0, glH = 0;
  function glEnsure(w, h) { if (w <= glW && h <= glH) return; glW = Math.max(glW, w); glH = Math.max(glH, h); GL.setSize(glW, glH, false); }

  const VIEWERS = [];
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
    for (const e of es) {
      const v = e.target.__viewer; if (!v) continue;
      v.visible = e.isIntersecting;
      if (v.visible) { v.dirty = true; if (v.init) { const f = v.init; v.init = null; f(); } }
      else v.setLive(false);
    }
  }, { rootMargin: '200px' }) : null;
  const ro = new ResizeObserver(es => { for (const e of es) { const v = e.target.__viewer; if (v) v.resize(); } });
  // Tapping outside a live stage hands touch scrolling back to the page
  document.addEventListener('pointerdown', e => { VIEWERS.forEach(v => { if (v.live && !v.host.contains(e.target)) v.setLive(false); }); }, true);

  const GEO = {};
  if (GL) {
    GEO.sphere = new THREE.SphereGeometry(1, 36, 18);
    GEO.cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
    GEO.cone = new THREE.ConeGeometry(1, 1, 20);
    Object.values(GEO).forEach(g => (g.userData.shared = true));
  }
  const UP = GL ? V3(0, 1, 0) : null;

  class Viewer {
    constructor(host, opt = {}) {
      this.host = host; host.__viewer = this;
      this.fov = opt.fov || 30; this.view = opt.view || [1, 0.42, 0.5];
      this.clearA = opt.clear ?? 1; // 0 = transparent, so the stage's CSS background shows through
      this.cv = document.createElement('canvas');
      this.cv.setAttribute('role', 'img'); this.labelFn = opt.label || (() => tx('3D model you can drag to rotate', '可以拖曳旋轉的 3D 模型'));
      host.appendChild(this.cv);
      this.ctx = this.cv.getContext('2d');
      this.scene = new THREE.Scene();
      this.cam = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 500); this.cam.up.set(0, 0, 1);
      this.scene.add(this.cam);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5d6578, 0.72));
      const dl = new THREE.DirectionalLight(0xffffff, 0.78); dl.position.set(-2, 3, 4); this.cam.add(dl);
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.ctl = new THREE.OrbitControls(this.cam, this.cv);
      this.ctl.enablePan = false; this.ctl.rotateSpeed = 0.85; this.ctl.autoRotateSpeed = 1.4; this.ctl.zoomSpeed = 0.8;
      this.ctl.addEventListener('change', () => { this.dirty = true; });
      const tools = document.createElement('div'); tools.className = 'stage-tools';
      tools.innerHTML = '<button type="button" data-act="in"></button><button type="button" data-act="out"></button><button type="button" data-act="reset"></button><button type="button" data-act="spin" aria-pressed="false"></button>';
      this.tools = tools;
      host.appendChild(tools);
      tools.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
        if (act === 'reset') this.reset(); else if (act === 'spin') this.setSpin(!this.spin); else this.zoomBy(act === 'in' ? 0.8 : 1.25);
      });
      this.spinBtn = $('[data-act=spin]', tools);
      this.hint = document.createElement('div'); this.hint.className = 'stage-hint'; host.appendChild(this.hint);
      this.live = false; this.applyLang();
      if (COARSE) {
        // Phones: the page scrolls through the model until it is tapped
        this.ctl.enabled = false; this.cv.style.touchAction = 'pan-y';
        this.cv.addEventListener('click', () => { if (!this.live) this.setLive(true); });
      } else {
        // Desktop: dragging always rotates; the wheel only zooms after a click, so page scrolling is never hijacked
        this.ctl.enableZoom = false;
        this.cv.addEventListener('pointerdown', () => this.setLive(true));
        host.addEventListener('pointerleave', () => this.setLive(false));
      }
      this.setLive(false);
      this.visible = !io; this.dirty = true; this.spin = false; this.anim = null; this.init = null;
      if (io) io.observe(host); ro.observe(host); VIEWERS.push(this); this.resize();
    }
    lazy(fn) { if (this.visible || !io) fn(); else this.init = fn; }
    setLive(on) {
      if (on === this.live && this.hint.textContent) return;
      this.live = on; this.host.classList.toggle('live', on);
      if (COARSE) { this.ctl.enabled = on; this.cv.style.touchAction = on ? 'none' : 'pan-y'; }
      else this.ctl.enableZoom = on;
      this.hint.textContent = this.hintText();
      this.hint.classList.toggle('cta', COARSE && !on);
    }
    hintText() {
      const on = this.live;
      return COARSE ? (on ? tx('One finger rotates, two fingers zoom · tap outside to scroll', '操作中：單指旋轉、雙指縮放・點模型外面就能繼續捲動') : tx('Tap the model to start', '點一下模型開始操作'))
        : (on ? tx('Drag to rotate · scroll to zoom', '拖曳旋轉・滾輪縮放') : tx('Drag to rotate · click first to zoom with the wheel', '拖曳旋轉・點一下後可用滾輪縮放'));
    }
    applyLang() {
      this.cv.setAttribute('aria-label', this.labelFn());
      const set = (act, text, label) => { const b = $(`[data-act=${act}]`, this.tools); b.textContent = text; if (label) b.setAttribute('aria-label', label); };
      set('in', tx('+', '＋'), tx('Zoom in', '放大')); set('out', tx('−', '－'), tx('Zoom out', '縮小'));
      set('reset', tx('Reset', '重設')); set('spin', tx('Spin', '旋轉'));
      this.hint.textContent = this.hintText();
    }
    setSpin(on) { this.spin = on; this.ctl.autoRotate = on; this.spinBtn.setAttribute('aria-pressed', String(on)); this.dirty = true; }
    fitDist() {
      const vf = this.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * this.cam.aspect);
      return this.radius / Math.sin(Math.min(vf, hf) / 2) * 1.02;
    }
    ratio() { return this.radius ? this.cam.position.distanceTo(this.ctl.target) / this.fitDist() : 1; }
    resize() {
      const r = this.host.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
      if (w === this.cv.width && h === this.cv.height) return;
      const k = this.ratio();
      this.cv.width = w; this.cv.height = h; this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      if (this.radius) this._place(this.cam.position.clone().sub(this.ctl.target), k);
      this.dirty = true;
    }
    // Re-centre on new content. Without an explicit direction the user's current angle and zoom are kept.
    frame(center, radius, dir) {
      const had = !!this.radius, cur = had ? this.cam.position.clone().sub(this.ctl.target) : null, k = this.ratio();
      this.center = center.clone(); this.radius = radius;
      if (dir) this.curView = dir; else if (!this.curView) this.curView = this.view;
      this.ctl.target.copy(this.center);
      if (dir || !had) this._place(V3(...this.curView), 1); else this._place(cur, k);
    }
    _place(dir, k = 1) {
      this.cam.position.copy(this.center).add(dir.clone().normalize().multiplyScalar(this.fitDist() * k));
      this.ctl.update(); this.dirty = true;
    }
    zoomBy(f) { if (!this.radius) return; const k = Math.max(0.35, Math.min(3, this.ratio() * f)); this._place(this.cam.position.clone().sub(this.ctl.target), k); }
    reset() { if (this.radius) this._place(V3(...this.curView), 1); }
    clear() {
      this.root.traverse(o => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      this.root.clear(); this.dirty = true;
    }
    render() {
      const w = this.cv.width, h = this.cv.height;
      glEnsure(w, h);
      GL.setViewport(0, 0, w, h); GL.setScissor(0, 0, w, h); GL.setScissorTest(true);
      GL.setClearColor(new THREE.Color(this.clearA ? T.stage : (T.film || T.stage)), this.clearA);
      GL.render(this.scene, this.cam);
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(GL.domElement, 0, glH - h, w, h, 0, 0, w, h);
    }
  }

  function loop(t) {
    for (const v of VIEWERS) {
      if (!v.visible) continue;
      if (v.spin) v.ctl.update();
      if (v.anim) v.anim(t);
      if (v.dirty) { v.dirty = false; v.render(); }
    }
    requestAnimationFrame(loop);
  }

  /* ---------- scene-building primitives ---------- */
  function mStd(color, o = {}) {
    const op = o.opacity ?? 1;
    return new THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.42, metalness: 0.04, transparent: op < 1, opacity: op, depthWrite: op >= 1,
      clippingPlanes: o.clip || null, side: o.clip ? THREE.DoubleSide : THREE.FrontSide,
      depthTest: o.depthTest ?? true, emissive: o.emissive || 0x000000
    });
  }
  function mBasic(color, o = {}) {
    const op = o.opacity ?? 1;
    return new THREE.MeshBasicMaterial({ color, transparent: op < 1, opacity: op, depthWrite: o.depthWrite ?? (op >= 1), depthTest: o.depthTest ?? true, side: o.side || THREE.FrontSide });
  }
  function atom(g, p, r, color, o = {}) {
    const m = new THREE.Mesh(GEO.sphere, mStd(color, o)); m.position.copy(p); m.scale.setScalar(r);
    if (o.order) m.renderOrder = o.order; g.add(m); return m;
  }
  function rod(g, a, b, r, mat) {
    const d = b.clone().sub(a), L = d.length(); if (L < 1e-9) return null;
    const m = new THREE.Mesh(GEO.cyl, mat); m.position.copy(a).addScaledVector(d, 0.5);
    m.scale.set(r, L, r); m.quaternion.setFromUnitVectors(UP, d.normalize()); g.add(m); return m;
  }
  function arrow(g, a, b, r, color, o = {}) {
    const mat = o.basic ? mBasic(color, o) : mStd(color, o);
    const d = b.clone().sub(a), L = d.length(); if (L < 1e-9) return;
    const u = d.clone().normalize(), hl = Math.min(r * 6, L * 0.4);
    const base = b.clone().addScaledVector(u, -hl);
    const s = rod(g, a, base, r, mat); if (s && o.order) s.renderOrder = o.order;
    const c = new THREE.Mesh(GEO.cone, mat); c.position.copy(base).addScaledVector(u, hl / 2);
    c.scale.set(r * 2.6, hl, r * 2.6); c.quaternion.setFromUnitVectors(UP, u); if (o.order) c.renderOrder = o.order; g.add(c);
  }
  function cellEdges(g, O, A, B, C, r, mat) {
    const P = (i, j, k) => O.clone().addScaledVector(A, i).addScaledVector(B, j).addScaledVector(C, k);
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      rod(g, P(0, i, j), P(1, i, j), r, mat); rod(g, P(i, 0, j), P(i, 1, j), r, mat); rod(g, P(i, j, 0), P(i, j, 1), r, mat);
    }
  }
  function dashed(g, pairs, color, o = {}) {
    const pts = []; pairs.forEach(([a, b]) => pts.push(a, b));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color, dashSize: o.dash || 0.06, gapSize: o.gap || 0.045, transparent: true, opacity: o.opacity ?? 0.9 });
    const ls = new THREE.LineSegments(geo, mat); ls.computeLineDistances(); g.add(ls); return ls;
  }
  function poly(g, pts, color, opacity = 0.32, outline = true) {
    const arr = [];
    for (let i = 1; i < pts.length - 1; i++) arr.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray());
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.Mesh(geo, mBasic(color, { opacity, side: THREE.DoubleSide, depthWrite: false })); m.renderOrder = 3; g.add(m);
    if (outline) { const lg = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]); g.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color }))); }
    return m;
  }
  // Text sprite. A "-" directly before a digit is drawn as an overbar on that digit.
  function measureIdx(x, s) { let w = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '-' && /\d/.test(s[i + 1] || '')) continue; w += x.measureText(s[i]).width; } return w; }
  function drawIdx(x, s, x0, y, fs, stroke) {
    let cx = x0;
    for (let i = 0; i < s.length; i++) {
      let ch = s[i], bar = false;
      if (ch === '-' && /\d/.test(s[i + 1] || '')) { bar = true; ch = s[++i]; }
      const w = x.measureText(ch).width;
      if (stroke) x.strokeText(ch, cx, y); else x.fillText(ch, cx, y);
      if (bar) { const yb = y - fs * 0.5; x.beginPath(); x.moveTo(cx + w * 0.12, yb); x.lineTo(cx + w * 0.88, yb); if (stroke) { x.lineWidth = fs * 0.32; x.stroke(); } else { x.lineWidth = fs * 0.075; x.strokeStyle = x.fillStyle; x.stroke(); } }
      cx += w;
    }
  }
  function label(g, text, p, o = {}) {
    const fs = 64, font = `${o.weight || 600} ${fs}px "IBM Plex Mono","IBM Plex Sans","Noto Sans TC",monospace`;
    const c = document.createElement('canvas'), x = c.getContext('2d'); x.font = font;
    const w = measureIdx(x, text);
    c.width = Math.ceil(w + fs * 0.6); c.height = Math.ceil(fs * 1.55);
    x.font = font; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const y = c.height * 0.56;
    x.strokeStyle = T.stage; x.lineWidth = fs * 0.32; drawIdx(x, text, fs * 0.3, y, fs, true);
    x.fillStyle = o.color || T.ink; drawIdx(x, text, fs * 0.3, y, fs, false);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: !!o.depth, depthWrite: false, transparent: true }));
    sp.renderOrder = 30; const s = (o.size || 0.12) * 1.2; sp.scale.set(s * c.width / c.height, s, 1);
    sp.position.copy(p); g.add(sp); return sp;
  }
  // Polygon where a plane n·p = val cuts a convex solid (vertices + edges)
  function slice(verts, edges, n, val) {
    const pts = [];
    const add = p => { if (!pts.some(q => q.distanceTo(p) < 1e-5)) pts.push(p); };
    verts.forEach(v => { if (Math.abs(n.dot(v) - val) < 1e-6) add(v.clone()); });
    edges.forEach(([i, j]) => {
      const a = verts[i], b = verts[j], fa = n.dot(a) - val, fb = n.dot(b) - val;
      if (fa * fb < -1e-12) add(a.clone().lerp(b, fa / (fa - fb)));
    });
    if (pts.length < 3) return null;
    const c = pts.reduce((s, p) => s.add(p), V3(0, 0, 0)).multiplyScalar(1 / pts.length);
    const nn = n.clone().normalize();
    const u = (Math.abs(nn.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0)).cross(nn).normalize(), w = nn.clone().cross(u);
    pts.sort((p, q) => Math.atan2(p.clone().sub(c).dot(w), p.clone().sub(c).dot(u)) - Math.atan2(q.clone().sub(c).dot(w), q.clone().sub(c).dot(u)));
    return pts;
  }
  // Part of a unit sphere kept by half-spaces n·d ≥ 0 through its centre, closed with flat caps.
  // Cut planes always run along the 7.5° tessellation lines, so the edges stay clean.
  const WEDGE = new Map();
  function wedgeGeo(ns) {
    const key = ns.map(n => n.toArray().map(x => x.toFixed(3)).join()).join('|');
    if (WEDGE.has(key)) return WEDGE.get(key);
    const src = new THREE.SphereGeometry(1, 48, 24).toNonIndexed(); src.rotateX(Math.PI / 2);
    const P = src.attributes.position.array, Nn = src.attributes.normal.array;
    const sp = [], sn = [], cp = [], cn = []; let kept = 0, total = 0;
    const tri = (a, b, c) => b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    for (let t = 0; t < P.length; t += 9) {
      const a = V3(P[t], P[t + 1], P[t + 2]), b = V3(P[t + 3], P[t + 4], P[t + 5]), c = V3(P[t + 6], P[t + 7], P[t + 8]);
      const ar = tri(a, b, c); total += ar;
      const m = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (ns.every(n => n.dot(m) >= -1e-7)) { kept += ar; for (let k = 0; k < 9; k++) { sp.push(P[t + k]); sn.push(Nn[t + k]); } }
    }
    ns.forEach((n, i) => {
      const w = Math.abs(n.z) > 0.9 ? V3(0, 1, 0) : V3(0, 0, 1);
      const u = Math.abs(n.z) > 0.9 ? V3(1, 0, 0) : w.clone().cross(n).normalize();
      for (let j = 0; j < 48; j++) {
        const a0 = j * Math.PI / 24, a1 = (j + 1) * Math.PI / 24;
        const p1 = u.clone().multiplyScalar(Math.cos(a0)).addScaledVector(w, Math.sin(a0));
        const p2 = u.clone().multiplyScalar(Math.cos(a1)).addScaledVector(w, Math.sin(a1));
        const m = p1.clone().add(p2).multiplyScalar(1 / 3);
        if (!ns.every((o, k) => k === i || o.dot(m) >= -1e-7)) continue;
        [V3(0, 0, 0), p1, p2].forEach(q => { cp.push(q.x, q.y, q.z); cn.push(-n.x, -n.y, -n.z); });
      }
    });
    const mk = (pos, nor) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.userData.shared = true; return g; };
    const out = { shell: mk(sp, sn), cap: mk(cp, cn), frac: kept / total };
    src.dispose(); WEDGE.set(key, out); return out;
  }
  // Atom cut by any of the given planes that pass through its centre; returns the kept fraction
  function cutAtom(g, p, r, color, planes, o = {}) {
    const ns = planes.filter(pl => Math.abs(pl.distanceToPoint(p)) < 1e-6).map(pl => pl.normal.clone());
    if (!ns.length) { atom(g, p, r, color, o); return 1; }
    const W = wedgeGeo(ns);
    const shell = new THREE.Mesh(W.shell, mStd(color, o));
    const cap = new THREE.Mesh(W.cap, mStd(new THREE.Color(color).multiplyScalar(0.72), { rough: 0.7, ...o }));
    cap.material.side = THREE.DoubleSide;
    [shell, cap].forEach(m => { m.position.copy(p); m.scale.setScalar(r); g.add(m); });
    return W.frac;
  }
  const CUBE_V = GL ? [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]].map(a => V3(...a)) : [];
  const CUBE_E = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const d = i ^ j; if (d === 1 || d === 2 || d === 4) CUBE_E.push([i, j]); }

  // Crystal bases in fractional coordinates
  const FCC_B = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
  const BASIS = {
    SC: [[0, 0, 0]],
    BCC: [[0, 0, 0], [.5, .5, .5]],
    FCC: FCC_B,
    DIA: [...FCC_B, ...FCC_B.map(p => p.map(x => x + .25))]
  };
  // All atom positions inside the closed cube [0,1]^3 (optionally range r0..r1)
  function sitesIn(basis, lo = 0, hi = 1) {
    const out = [], seen = new Set();
    for (let i = Math.floor(lo) - 1; i <= Math.ceil(hi); i++) for (let j = Math.floor(lo) - 1; j <= Math.ceil(hi); j++) for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi); k++)
      basis.forEach((b, bi) => {
        const p = [b[0] + i, b[1] + j, b[2] + k];
        if (p.every(x => x > lo - EPS && x < hi + EPS)) { const key = p.map(x => x.toFixed(4)).join(); if (!seen.has(key)) { seen.add(key); out.push({ p, bi }); } }
      });
    return out;
  }
  const onBound = p => p.filter(x => Math.abs(x) < EPS || Math.abs(x - 1) < EPS).length; // 3 corner, 1 face, 0 inside
  const kindColor = p => { const n = onBound(p); return n === 3 ? COL.corner : n === 0 ? COL.body : COL.face; };
  const hexVerts = (z, a = 1) => [0, 1, 2, 3, 4, 5].map(i => V3(a * Math.cos(i * Math.PI / 3), a * Math.sin(i * Math.PI / 3), z));
  function hexPrism(c, a = 1) {
    const v = [...hexVerts(0, a), ...hexVerts(c, a)], e = [];
    for (let i = 0; i < 6; i++) { e.push([i, (i + 1) % 6], [6 + i, 6 + (i + 1) % 6], [i, 6 + i]); }
    return { v, e };
  }
  function hexEdges(g, c, r, mat, z0 = 0) {
    const P = hexPrism(c); P.e.forEach(([i, j]) => rod(g, P.v[i].clone().setZ(P.v[i].z + z0), P.v[j].clone().setZ(P.v[j].z + z0), r, mat));
  }

  /* =====================================================================
     2D canvas helper
     ===================================================================== */
  function canvas2d(cv, draw) {
    const fit = () => {
      if (!cv || !cv.parentElement) return;
      const r = cv.parentElement.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (!r.width || !r.height) return;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); draw(x, r.width, r.height);
    };
    if (cv && cv.parentElement) {
      new ResizeObserver(fit).observe(cv.parentElement);
      requestAnimationFrame(fit);
    }
    return fit;
  }
  const FONT = (w, s) => tx(`${w} ${s}px "IBM Plex Sans",system-ui,sans-serif`, `${w} ${s}px "Noto Sans TC","PingFang TC",sans-serif`);
  const MFONT = (w, s) => `${w} ${s}px "IBM Plex Mono",monospace`;

  /* =====================================================================
     Chapter 4: shared pieces
     ===================================================================== */
  if (GL) { GEO.lo = new THREE.SphereGeometry(1, 18, 10); GEO.lo.userData.shared = true; }
  const rng = s => () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sci = (x, d = 1) => {
    if (!x) return '0';
    let e = Math.floor(Math.log10(Math.abs(x))), m = (x / 10 ** e).toFixed(d);
    if (Math.abs(+m) >= 10) { e++; m = (x / 10 ** e).toFixed(d); }
    return `${m} × 10${String(e).replace(/[-\d]/g, c => SUP[c])}`;
  };
  const EV = 1.602e-19;
  // Many equal spheres in one draw call
  function cloud(g, pts, r, color, o = {}) {
    if (!pts.length) return null;
    const m = new THREE.InstancedMesh(pts.length > 500 ? GEO.lo : GEO.sphere, mStd(color, o), pts.length), M = new THREE.Matrix4();
    pts.forEach((p, i) => { M.makeScale(r, r, r); M.setPosition(p.x, p.y, p.z); m.setMatrixAt(i, M); });
    m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; if (o.order) m.renderOrder = o.order; g.add(m); return m;
  }
  function shell(g, p, r, color, opacity) { const m = atom(g, p, r, color, { opacity, order: 6 }); return m; }
  function path(g, pts, r, mat, order) { for (let i = 1; i < pts.length; i++) { const m = rod(g, pts[i - 1], pts[i], r, mat); if (m && order) m.renderOrder = order; } }
  function arc(g, a, b, rad, color) {
    const pts = []; for (let i = 0; i <= 16; i++) pts.push(a.clone().lerp(b, i / 16).normalize().multiplyScalar(rad));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
  }
  // Triangles of the convex hull of a few points
  function hullFaces(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
      const n = pts[j].clone().sub(pts[i]).cross(pts[k].clone().sub(pts[i])); if (n.length() < 1e-6) continue;
      let pos = 0, neg = 0; pts.forEach(p => { const d = n.dot(p.clone().sub(pts[i])); if (d > 1e-6) pos++; else if (d < -1e-6) neg++; });
      if (!pos || !neg) out.push([pts[i], pts[j], pts[k]]);
    }
    return out;
  }
  const slide = (id, f) => { const e = $(id); e.addEventListener('input', f); return e; };

  /* =====================================================================
     Chapter 1: shared pieces
     ===================================================================== */
  const redraw2D = [];
  const sciH = (x, d = 1) => { const e = Math.floor(Math.log10(Math.abs(x))); return `${(x / 10 ** e).toFixed(d)} × 10<sup>${String(e).replace('-', '−')}</sup>`; };
  const big = n => n >= 1e9 ? tx(`${+(n / 1e9).toFixed(n < 1e10 ? 2 : 1)} billion`, `${+(n / 1e8).toFixed(n < 1e9 ? 1 : 0)} 億`) : n >= 1e6 ? tx(`${+(n / 1e6).toFixed(1)} million`, `${+(n / 1e4).toFixed(0)} 萬`) : n.toLocaleString('en');
  // random rotation matrix from a seeded generator
  function rot(rnd) {
    const q = new THREE.Quaternion(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    return new THREE.Matrix4().makeRotationFromQuaternion(q);
  }
  // atoms filling the box [0,L]^3: amorphous (random with a minimum spacing), crystal, or grains around seeds
  function amorphous(L, n, seed, keep) {
    const rnd = rng(seed), out = [], d2 = 0.92 * 0.92;
    for (let t = 0; t < n * 60 && out.length < n; t++) {
      const p = V3(rnd() * L, rnd() * L, rnd() * L); if (keep && !keep(p)) continue;
      if (out.every(q => q.distanceToSquared(p) > d2)) out.push(p);
    }
    return out;
  }
  function lattice(L, keep, M, c) {
    const out = [], R = Math.ceil(L * 1.8);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (let k = -R; k <= R; k++) {
      const p = V3(i, j, k); if (M) p.applyMatrix4(M); p.add(c || V3(0.5, 0.5, 0.5));
      if (p.x < 0.3 || p.y < 0.3 || p.z < 0.3 || p.x > L - 0.3 || p.y > L - 0.3 || p.z > L - 0.3) continue;
      if (!keep || keep(p)) out.push(p);
    }
    return out;
  }
  function grains(L, seeds, rnd) {
    const near = p => { let k = 0, d = 1e9; seeds.forEach((s, i) => { const e = s.distanceToSquared(p); if (e < d) { d = e; k = i; } }); return k; };
    const all = seeds.map((s, i) => { const M = rot(rnd); return lattice(L, p => near(p) === i, M, s); });
    // drop atoms that crowd an atom of another grain at the boundary
    const kept = all.map(() => []);
    all.forEach((g, i) => g.forEach(p => { if (!kept.some((h, j) => j !== i && h.some(q => q.distanceToSquared(p) < 0.6))) kept[i].push(p); }));
    return kept;
  }
  const GC = [COL.corner, COL.face, COL.body, COL.plane];

  /* =====================================================================
     Hero: the same atoms, amorphous on the left and crystalline on the right
     ===================================================================== */
  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [0.35, -1, 0.5], label: () => tx('A block of atoms, amorphous on one side and crystalline on the other', '一塊原子，一半非晶、一半晶體'), clear: 0 });
    v.rebuild = () => {
      v.clear(); const g = v.root, L = 8, C = V3(L / 2, L / 2, L / 2);
      const cr = lattice(L, p => p.x >= L / 2).map(p => p.sub(C)), am = amorphous(L, 260, 3, p => p.x < L / 2 - 0.5).map(p => p.sub(C));
      cloud(g, cr, 0.42, COL.corner); cloud(g, am, 0.42, COL.corner);
    };
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 6.6); if (!REDUCED) v.setSpin(true); });
  }

  /* =====================================================================
     01 Transistor count and process node (2D)
     ===================================================================== */
  // [year, chip, node in nm, transistors]; nodes and chips follow the slide's table
  const CHIPS = [[1971, 'Intel 4004', 10000, 2300], [1974, 'Intel 8080', 6000, 4500], [1978, 'Intel 8086', 3000, 29000], [1982, 'Intel 80286', 1500, 134000], [1985, 'Intel 80386', 1000, 275000],
    [1989, 'Intel 80486', 800, 1.2e6], [1993, 'Intel Pentium', 600, 3.1e6], [1995, 'Pentium Pro', 350, 5.5e6], [1997, 'Pentium II', 250, 7.5e6], [1999, 'Pentium III', 180, 9.5e6],
    [2001, 'Pentium 4 (Northwood)', 130, 55e6], [2003, 'Pentium 4 (Prescott)', 90, 125e6], [2006, 'Core 2 Duo', 65, 291e6], [2008, 'Core i7 (Nehalem)', 45, 731e6], [2010, 'Sandy Bridge', 32, 1.16e9],
    [2012, 'Ivy Bridge, first FinFET', 22, 1.4e9], [2014, 'Broadwell (Core M)', 14, 1.3e9], [2019, 'Apple A13 Bionic', 7, 8.5e9], [2020, 'Apple A14, first 5 nm chip', 5, 11.8e9], [2021, 'Apple A15', 5, 15e9],
    [2023, 'Apple A17 Pro', 3, 19e9], [2024, 'Apple A18 (TSMC N3E)', 3, 20e9]];
  function secTr() {
    const yS = $('#tr-y'), info = $('#tr-info'); yS.max = CHIPS.length - 1;
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 50, mr = 54, mt = 18, mb = 34, X = y => ml + (y - 1969) / (2027 - 1969) * (W - ml - mr);
      const YN = n => mt + (11 - Math.log10(n)) / 8 * (H - mt - mb);
      // the node axis runs downward as features shrink, so small nodes sit low
      const YLf = nm => H - mb - Math.log10(nm) / 4.5 * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.fillStyle = T.muted; x.font = MFONT(400, 10);
      for (let e = 3; e <= 11; e++) { x.beginPath(); x.moveTo(ml, YN(10 ** e)); x.lineTo(W - mr, YN(10 ** e)); x.stroke(); x.textAlign = 'right'; x.fillText('10' + String(e).replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]), ml - 6, YN(10 ** e) + 3); }
      x.fillStyle = T.muted; x.textAlign = 'center';
      for (let y = 1970; y <= 2025; y += 10) x.fillText(y, X(y), H - mb + 14);
      x.save(); x.translate(12, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.font = FONT(500, 11); x.fillStyle = COL.corner; x.fillText(tx('transistors per chip', '每顆晶片的電晶體數'), 0, 0); x.restore();
      x.save(); x.translate(W - 8, (mt + H - mb) / 2); x.rotate(Math.PI / 2); x.font = FONT(500, 11); x.fillStyle = COL.body; x.textAlign = 'center'; x.fillText(tx('process node', '製程節點'), 0, 0); x.restore();
      x.fillStyle = COL.body; x.font = MFONT(400, 10); x.textAlign = 'left';
      [[1, '1 nm'], [10, '10 nm'], [100, '100 nm'], [1000, '1 µm'], [10000, '10 µm']].forEach(([nm, s]) => x.fillText(s, W - mr + 6, YLf(nm) + 3));
      x.setLineDash([5, 4]); x.strokeStyle = T.edge3d; x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(1971), YN(2300)); x.lineTo(X(2014), YN(2300 * 2 ** ((2014 - 1971) / 2))); x.stroke(); x.setLineDash([]);
      const sel = +yS.value;
      x.strokeStyle = COL.body; x.lineWidth = 1.4; x.beginPath(); CHIPS.forEach((c, i) => { const px = X(c[0]), py = YLf(c[2]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
      x.strokeStyle = COL.corner; x.beginPath(); CHIPS.forEach((c, i) => { const px = X(c[0]), py = YN(c[3]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
      CHIPS.forEach((c, i) => {
        const on = i === sel;
        x.fillStyle = COL.body; x.beginPath(); x.arc(X(c[0]), YLf(c[2]), on ? 5.5 : 3, 0, 7); x.fill();
        x.fillStyle = COL.corner; x.beginPath(); x.arc(X(c[0]), YN(c[3]), on ? 5.5 : 3, 0, 7); x.fill();
      });
      const c = CHIPS[sel]; x.strokeStyle = T.hi; x.lineWidth = 1; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(X(c[0]), mt); x.lineTo(X(c[0]), H - mb); x.stroke(); x.setLineDash([]);
      x.fillStyle = T.ink; x.font = FONT(600, 12); x.textAlign = X(c[0]) > W * 0.6 ? 'right' : 'left'; x.fillText(c[1], X(c[0]) + (x.textAlign === 'right' ? -8 : 8), mt + 12);
    }
    function text() {
      const c = CHIPS[+yS.value], nm = c[2] >= 1000 ? `${c[2] / 1000} µm` : `${c[2]} nm`;
      $('#tr-y-v').textContent = c[0];
      info.innerHTML = `<h4>${c[1]}</h4>` + tx(`<dl class="stats"><dt>Year</dt><dd>${c[0]}</dd><dt>Process node</dt><dd>${nm}</dd><dt>Transistors</dt><dd>${big(c[3])}</dd><dt>Compared with the 4004</dt><dd>× ${big(Math.round(c[3] / 2300))}</dd></dl>`,
        `<dl class="stats"><dt>年份</dt><dd>${c[0]}</dd><dt>製程節點</dt><dd>${nm}</dd><dt>電晶體數</dt><dd>${big(c[3])}</dd><dt>和 4004 比</dt><dd>× ${big(Math.round(c[3] / 2300))}</dd></dl>`) +
        tx('<p class="note">The dashed line doubles every two years. Averaged from 1971 to 2024 the real count doubled about every 2.3 years.</p>', '<p class="note">虛線是每兩年翻一倍。從 1971 到 2024 年平均下來，實際大約每 2.3 年翻一倍。</p>');
    }
    const draw = canvas2d($('#tr-cv'), paint);
    yS.addEventListener('input', () => { draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     02 Materials tetrahedron (3D)
     ===================================================================== */
  function secPs() {
    const info = $('#ps-info'); let ex = 'sword';
    const P = { proc: V3(-1.63, -0.94, -0.67), str: V3(1.63, -0.94, -0.67), prop: V3(0, 1.89, -0.67), perf: V3(0, 0, 2) };
    const NAME = { proc: () => tx('Processing', '製程'), str: () => tx('Structure', '結構'), prop: () => tx('Properties', '性質'), perf: () => tx('Performance', '性能') };
    const EX = () => ({
      sword: { t: tx('Forged steel sword', '鍛造鋼劍'), proc: tx('Iron ore smelted to steel, then forged, folded, quenched and tempered.', '鐵礦煉成鋼，再經鍛打、摺疊、淬火、回火。'), str: tx('Finer grains, evenly spread carbon, hard martensite from the quench, fewer slag inclusions.', '晶粒更細、碳分布均勻、淬火產生的硬麻田散鐵、夾雜物更少。'), prop: tx('Higher strength and toughness at the same composition.', '成分不變，強度和韌性都提高。'), perf: tx('A blade that holds its edge without shattering.', '刀刃能保持鋒利又不會碎裂。') },
      cu: { t: tx('Nano-twinned copper', '奈米雙晶銅'), proc: tx('Pulsed electrodeposition (Lu et al., 2004).', '脈衝電鍍（Lu 等人，2004）。'), str: tx('Grains about 400 nm wide, filled with twin layers about 15 nm thick.', '晶粒約 400 nm，裡面布滿厚約 15 nm 的雙晶層。'), prop: tx('Twin boundaries block dislocations but barely scatter electrons: high strength and high conductivity together.', '雙晶界擋得住差排，卻幾乎不散射電子：同時有高強度和高導電性。'), perf: tx('Strong, conductive free-standing Cu interconnects.', '又強又導電的獨立式銅導線。') },
      solder: { t: tx('Pb–Sn solder', '鉛錫銲料'), proc: tx('Choose the composition, melt, then cool.', '選定成分、熔化、冷卻。'), str: tx('63Sn–37Pb freezes into fine eutectic layers. Other compositions first grow coarse proeutectic grains of α or β.', '63Sn–37Pb 凝固成細密的共晶層狀組織；其他成分會先長出粗大的初晶 α 或 β。'), prop: tx('The eutectic melts at the lowest temperature, 183 °C, and all at once.', '共晶成分熔點最低，183 °C，而且一次全部熔化。'), perf: tx('Joints that solder quickly and solidify cleanly in electronic packages.', '在電子封裝中焊得快、凝固乾淨的銲點。') },
      si: { t: tx('Silicon wafer', '矽晶圓'), proc: tx('Czochralski growth, slicing, polishing.', '柴氏法長晶、切片、拋光。'), str: tx('One single crystal with very few defects and little oxygen.', '整片是單晶，缺陷和氧都很少。'), prop: tx('Uniform, precisely controlled resistivity after doping.', '摻雜後電阻率均勻、可以精確控制。'), perf: tx('Billions of transistors per chip with high yield.', '每顆晶片數十億個電晶體，良率高。') }
    })[ex];
    const v = GL ? new Viewer($('#v-pspp'), { view: [0.25, -1, 0.35], label: () => tx('The materials tetrahedron', '材料四面體') }) : null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root, ks = Object.keys(P);
      ks.forEach((a, i) => ks.slice(i + 1).forEach(b => rod(g, P[a], P[b], 0.025, mStd(COL.plane, { opacity: 0.7 }))));
      const chain = ['proc', 'str', 'prop', 'perf'];
      chain.slice(1).forEach((k, i) => { const a = P[chain[i]], b = P[k], u = b.clone().sub(a).normalize(); arrow(g, a.clone().addScaledVector(u, 0.32), b.clone().addScaledVector(u, -0.32), 0.04, T.hi); });
      ks.forEach(k => { atom(g, P[k], 0.22, k === 'perf' ? T.hi : COL.corner); label(g, NAME[k](), P[k].clone().add(V3(0, 0, 0.42)), { size: 0.26, weight: 700 }); });
      atom(g, V3(0, 0, 0), 0.12, T.edge3d);
      label(g, tx('characterization · modeling', '分析鑑定・建模模擬'), V3(0, 0, -0.32), { size: 0.17, color: T.muted });
    };
    function text() {
      const e = EX();
      info.innerHTML = `<h4>${e.t}</h4><dl class="stats">${['proc', 'str', 'prop', 'perf'].map(k => `<dt>${NAME[k]()}</dt><dd style="font-family:var(--f-body)">${e[k]}</dd>`).join('')}</dl>`;
    }
    seg($('#ps-ex'), x => { ex = x; text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0.3), 2.5); });
    text(); onLang(() => { if (v && !v.init) v.rebuild(); text(); });
  }

  /* =====================================================================
     03 Amorphous, polycrystal, single crystal (3D)
     ===================================================================== */
  function secAr() {
    const info = $('#ar-info'); let mode = 'poly';
    const L = 8, C = V3(L / 2, L / 2, L / 2);
    const v = GL ? new Viewer($('#v-ar'), { view: [1, -0.8, 0.6], label: () => tx('Atoms in an amorphous solid, a polycrystal or a single crystal', '非晶、多晶或單晶中的原子') }) : null;
    let counts = [];
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root;
      if (mode === 'am') { const a = amorphous(L, 420, 11).map(p => p.sub(C)); cloud(g, a, 0.42, COL.corner); counts = [a.length]; }
      else if (mode === 'single') { const a = lattice(L).map(p => p.sub(C)); cloud(g, a, 0.42, COL.corner); counts = [a.length]; }
      else {
        const rnd = rng(5), seeds = [V3(1.5, 1.8, 2), V3(6.4, 2.2, 5.6), V3(2.4, 6.3, 6), V3(6, 6.4, 1.6)];
        const gs = grains(L, seeds, rnd); gs.forEach((a, i) => cloud(g, a.map(p => p.sub(C)), 0.42, GC[i])); counts = gs.map(a => a.length);
      }
      cellEdges(g, V3(-L / 2, -L / 2, -L / 2), V3(L, 0, 0), V3(0, L, 0), V3(0, 0, L), 0.02, mStd(T.ghost3d));
    };
    function text() {
      info.innerHTML = {
        am: tx('<h4>Amorphous</h4><p>Every atom keeps roughly the right distance from its neighbors, so there is short-range order. But turn the block any way you like: no direction shows rows of atoms. There is no long-range order.</p><p class="note">Examples: window glass, amorphous silicon in thin-film solar cells, most of a polymer.</p>', '<h4>非晶質</h4><p>每個原子和鄰居大致保持適當的距離，所以有短程規律；但不管怎麼轉，都找不到成列的原子，沒有長程規律。</p><p class="note">例子：窗戶玻璃、薄膜太陽能電池的非晶矽、高分子的大部分。</p>'),
        poly: tx(`<h4>Polycrystal: ${counts.length} grains</h4><p>Inside each colored grain the atoms line up in rows, but every grain is turned a different way. Where two grains meet, the rows do not match: that seam is a grain boundary.</p><p class="note">Most metals and ceramics are polycrystals. Chapter 4 shows how grains form when a liquid freezes.</p>`, `<h4>多晶：${counts.length} 顆晶粒</h4><p>每一顆有顏色的晶粒裡，原子都排成整齊的列，但每顆晶粒轉的方向都不同。兩顆晶粒相遇的地方，列接不起來，那條接縫就是晶界。</p><p class="note">大部分金屬和陶瓷都是多晶。第 4 章會說明液體凝固時晶粒怎麼形成。</p>`),
        single: tx('<h4>Single crystal</h4><p>One lattice runs through the whole block. Turn it to look down a row and every atom lines up behind the one in front.</p><p class="note">Silicon wafers and single-crystal turbine blades are made this way on purpose, because grain boundaries would hurt their performance.</p>', '<h4>單晶</h4><p>一套晶格貫穿整塊。轉到順著列的方向看，每個原子都剛好躲在前一個後面。</p><p class="note">矽晶圓和單晶渦輪葉片刻意做成這樣，因為晶界會降低它們的性能。</p>')
      }[mode];
    }
    seg($('#ar-mode'), m => { mode = m; if (v && !v.init) v.rebuild(); text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 6.9); text(); });
    text(); onLang(text);
  }

  /* =====================================================================
     04 Four families (3D)
     ===================================================================== */
  function secFam() {
    const info = $('#fam-info'); let mode = 'metal', el = null, elV = null;
    const v = GL ? new Viewer($('#v-fam'), { view: [1, -0.75, 0.55], label: () => tx('Atomic arrangement of a metal, a ceramic, a polymer or a composite', '金屬、陶瓷、高分子或複合材料的原子排列') }) : null;
    let FR = 4;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root; el = null;
      if (mode === 'metal') {
        const a = 2, pts = sitesIn(BASIS.FCC, 0, 3).map(s => V3(...s.p).multiplyScalar(a).sub(V3(3, 3, 3)));
        cloud(g, pts, 0.42, COL.corner, { opacity: 0.9 });
        const rnd = rng(3), pos = [], N = 160; elV = [];
        for (let i = 0; i < N; i++) { pos.push((rnd() - 0.5) * 6.4, (rnd() - 0.5) * 6.4, (rnd() - 0.5) * 6.4); elV.push(V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize()); }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        el = new THREE.Points(geo, new THREE.PointsMaterial({ color: T.hi, size: 4 * Math.min(devicePixelRatio || 1, 2), sizeAttenuation: false })); el.frustumCulled = false; g.add(el);
        FR = 5.2;
      } else if (mode === 'ceramic') {
        const a = 2.4, an = sitesIn(BASIS.FCC, 0, 2).map(s => V3(...s.p)), ca = [];
        for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) for (let k = 0; k <= 4; k++) { if ((i + j + k) % 2 === 1) ca.push(V3(i / 2, j / 2, k / 2)); }
        const sh = V3(1, 1, 1);
        cloud(g, an.map(p => p.clone().sub(sh).multiplyScalar(a)), 0.5, COL.corner);
        cloud(g, ca.map(p => p.clone().sub(sh).multiplyScalar(a)), 0.28, COL.body);
        FR = 4.3;
      } else if (mode === 'polymer') {
        const rnd = rng(17), mat = mStd(COL.corner), box = 3;
        for (let c = 0; c < 7; c++) {
          let p = V3((rnd() - 0.5) * 4, (rnd() - 0.5) * 4, (rnd() - 0.5) * 4), d = V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(); const pts = [p.clone()];
          for (let s = 0; s < 40; s++) { d.add(V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.1)).normalize(); p = p.clone().addScaledVector(d, 0.45); ['x', 'y', 'z'].forEach(k => { if (Math.abs(p[k]) > box) { d[k] *= -1; p[k] = Math.sign(p[k]) * box; } }); pts.push(p); }
          g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.07, 6), mat));
        }
        // a crystalline lamella: one chain folded back and forth in parallel stems
        const pts = [], x0 = -0.6, y0 = -1.6, z0 = -1.6;
        for (let s = 0; s < 7; s++) { const y = y0 + s * 0.42, up = s % 2 === 0; pts.push(V3(x0, y, up ? z0 : z0 + 2.4), V3(x0, y, up ? z0 + 2.4 : z0)); }
        g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2), 400, 0.08, 6), mStd(COL.body)));
        FR = 4.4;
      } else {
        const L = 6, box = new THREE.Mesh(new THREE.BoxGeometry(L, L * 0.75, L * 0.75), mStd(T.ghost3d, { opacity: 0.22 })); box.renderOrder = 4; g.add(box);
        cellEdges(g, V3(-L / 2, -L * 0.375, -L * 0.375), V3(L, 0, 0), V3(0, L * 0.75, 0), V3(0, 0, L * 0.75), 0.02, mStd(T.edge3d));
        const fm = mStd(COL.face);
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rod(g, V3(-L / 2 - 0.3, (i - 1.5) * 1.05, (j - 1.5) * 1.05), V3(L / 2 + 0.3, (i - 1.5) * 1.05, (j - 1.5) * 1.05), 0.26, fm);
        FR = 4.4;
      }
    };
    if (v) v.anim = t => {
      if (!el || REDUCED) return;
      const a = el.geometry.attributes.position, dt = 0.03;
      for (let i = 0; i < a.count; i++) {
        const d = elV[i]; d.add(V3(Math.sin(t / 300 + i), Math.cos(t / 370 + i * 1.7), Math.sin(t / 410 + i * 0.6)).multiplyScalar(0.15)).normalize();
        let x = a.getX(i) + d.x * dt * 2, y = a.getY(i) + d.y * dt * 2, z = a.getZ(i) + d.z * dt * 2;
        const w = c => (c > 3.2 ? c - 6.4 : c < -3.2 ? c + 6.4 : c); a.setXYZ(i, w(x), w(y), w(z));
      }
      a.needsUpdate = true; v.dirty = true;
    };
    function text() {
      info.innerHTML = {
        metal: tx('<h4>Metal: ion cores in an electron sea</h4><p>Metal atoms give up their outer electrons to a shared pool (red dots) that moves freely between the positive ion cores (blue), which pack closely in a crystal.</p><p class="note">Free electrons carry current and heat. The bond has no preferred direction, so layers of atoms can slide and the metal bends instead of breaking.</p>', '<h4>金屬：泡在電子海裡的離子核</h4><p>金屬原子把外層電子交給共用的電子池（紅點），電子在緊密堆積成晶體的正離子核（藍）之間自由移動。</p><p class="note">自由電子負責導電、導熱。這種鍵沒有偏好的方向，原子層可以滑動，所以金屬會彎而不會斷。</p>'),
        ceramic: tx('<h4>Ceramic: ions held in place</h4><p>Rock salt (NaCl): small cations (orange) and large anions (blue) alternate in every direction. Each electron is held tightly by one ion, so none is free to move.</p><p class="note">Strong ionic or covalent bonds make ceramics hard, heat resistant and insulating. Sliding a layer would bring like charges together, so they crack instead of bending.</p>', '<h4>陶瓷：被固定住的離子</h4><p>岩鹽（NaCl）：小的陽離子（橘）和大的陰離子（藍）在每個方向交替排列。每個電子都被一個離子緊緊抓住，沒有電子能自由移動。</p><p class="note">強的離子鍵或共價鍵讓陶瓷又硬、耐熱又絕緣。要讓一層滑動，會讓同號電荷靠在一起，所以陶瓷會裂而不會彎。</p>'),
        polymer: tx('<h4>Polymer: tangled long chains</h4><p>Each tube is one giant molecule, a chain of thousands of carbon atoms. Most of the solid is a random tangle (blue). In places chains fold back and forth in neat parallel stems, a crystalline region (orange).</p><p class="note">Stretching lines the chains up, making the polymer more crystalline: stronger and less flexible.</p>', '<h4>高分子：糾纏的長鏈</h4><p>每一根管子是一個巨大分子，由數千個碳原子串成。固體大部分是隨機糾纏的鏈（藍），有些地方鏈來回摺疊成整齊平行的段落，就是結晶區（橘）。</p><p class="note">拉伸會讓鏈排整齊，高分子變得更結晶：更強、也更不柔軟。</p>'),
        comp: tx('<h4>Composite: fibers in a matrix</h4><p>Strong, stiff fibers (green) carry the load; a lighter matrix (gray) binds them, spreads the load and protects them. The two bond but do not dissolve in each other.</p><p class="note">Fiberglass: glass fibers in polyester or epoxy. Concrete: gravel and steel rods in cement and sand. Aircraft wings use them to save weight and fuel.</p>', '<h4>複合材料：基材中的纖維</h4><p>又強又硬的纖維（綠）承受負荷；比較輕的基材（灰）把纖維黏在一起、分散負荷、保護纖維。兩者結合但不互溶。</p><p class="note">玻璃纖維：玻璃纖維在聚酯或環氧樹脂中。混凝土：碎石和鋼筋在水泥砂漿中。飛機機翼用它來減重、省油。</p>')
      }[mode];
    }
    seg($('#fam-mode'), m => { mode = m; if (v && !v.init) { v.rebuild(); v.frame(V3(0, 0, 0), FR); } text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), FR); });
    text(); onLang(text);
  }

  /* =====================================================================
     05 Conductivity scale (2D)
     ===================================================================== */
  function secEc() {
    const dS = $('#ec-d'), info = $('#ec-info');
    const Q = 1.602e-19, NI = 1.45e16, MUP = 0.045;
    const muN = N => 0.0068 + (0.1414 - 0.0068) / (1 + Math.pow(N / 9.2e22, 0.711)); // m²/(V·s), electrons in Si
    const N = () => (+dS.value === 0 ? 0 : 10 ** (16 + +dS.value));
    const sig = () => { const n0 = N(), n = n0 / 2 + Math.sqrt(n0 * n0 / 4 + NI * NI), p = NI * NI / n; return Q * (n * muN(n0) + p * MUP); };
    const MATS = [['Cu', '銅', 5.96e7], ['Al', '鋁', 3.77e7], ['Fe', '鐵', 1.0e7], ['Ge', '鍺', 2.2], ['Al₂O₃', '氧化鋁', 1e-12], ['PE', '聚乙烯', 1e-16]];
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 16, mr = 16, y0 = H * 0.52, X = s => ml + (Math.log10(s) + 18) / 27 * (W - ml - mr);
      const bands = [[1e-18, 1e-8, tx('insulators: ceramics, glasses, polymers', '絕緣體：陶瓷、玻璃、高分子'), T.surface], [1e-8, 1e4, tx('semiconductors', '半導體'), T.stage], [1e4, 1e9, tx('conductors: metals', '導體：金屬'), T.surface]];
      bands.forEach(([a, b, t, c], i) => { x.fillStyle = c; x.fillRect(X(a), 20, X(b) - X(a), H - 60); x.fillStyle = T.muted; x.font = FONT(600, 11); x.textAlign = 'center'; x.fillText(t, (X(a) + X(b)) / 2, 34); });
      x.strokeStyle = T.edge3d; x.lineWidth = 1.2; x.beginPath(); x.moveTo(ml, y0); x.lineTo(W - mr, y0); x.stroke();
      x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      for (let e = -18; e <= 9; e += 3) { x.beginPath(); x.moveTo(X(10 ** e), y0 - 4); x.lineTo(X(10 ** e), y0 + 4); x.stroke(); x.fillText('10' + String(e).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]), X(10 ** e), H - 26); }
      x.fillText(tx('electrical conductivity σ (S/m), logarithmic', '導電率 σ（S/m），對數座標'), W / 2, H - 8);
      MATS.forEach(([en, zh, s], i) => {
        const px = X(s), up = i % 2 === 0, yy = up ? y0 - 34 : y0 + 40;
        x.strokeStyle = T.ink; x.lineWidth = 1; x.beginPath(); x.moveTo(px, y0); x.lineTo(px, up ? yy + 6 : yy - 14); x.stroke();
        x.fillStyle = T.ink; x.beginPath(); x.arc(px, y0, 4, 0, 7); x.fill();
        x.font = FONT(600, 12); x.textAlign = 'center'; x.fillText(tx(en, zh), px, yy);
      });
      const s = sig(), px = X(s);
      x.fillStyle = COL.corner; x.beginPath(); x.arc(px, y0, 7, 0, 7); x.fill();
      x.font = FONT(700, 12); x.fillStyle = COL.corner; x.textAlign = 'center'; x.fillText(tx('Si', '矽'), px, y0 - 58);
      x.strokeStyle = COL.corner; x.beginPath(); x.moveTo(px, y0 - 52); x.lineTo(px, y0 - 9); x.stroke();
    }
    function text() {
      const n0 = N(), s = sig(), s0 = Q * (NI * (0.1414 + MUP));
      $('#ec-d-v').innerHTML = n0 ? `${sciH(n0 / 1e6, 1)} cm<sup>−3</sup>` : tx('none (pure Si)', '無（純矽）');
      info.innerHTML = tx(`<dl class="stats"><dt>Dopant fraction</dt><dd>${n0 ? (n0 / 5e28 * 1e6 < 0.01 ? sciH(n0 / 5e28 * 1e6, 1) : (n0 / 5e28 * 1e6).toPrecision(2)) + ' ppm' : '0'}</dd><dt>σ of silicon</dt><dd>${sciH(s, 1)} S/m</dd><dt>Compared with pure Si</dt><dd>× ${s / s0 < 1000 ? (s / s0).toFixed(1) : sciH(s / s0, 1)}</dd></dl><p class="note">${n0 ? 'Each donor atom adds one free electron. A few atoms per million is enough to move silicon across most of the semiconductor band.' : 'Pure silicon at room temperature has only about 1.5 × 10<sup>10</sup> free electrons per cm³, so it conducts poorly.'}</p>`,
        `<dl class="stats"><dt>摻雜比例</dt><dd>${n0 ? (n0 / 5e28 * 1e6 < 0.01 ? sciH(n0 / 5e28 * 1e6, 1) : (n0 / 5e28 * 1e6).toPrecision(2)) + ' ppm' : '0'}</dd><dt>矽的 σ</dt><dd>${sciH(s, 1)} S/m</dd><dt>和純矽比</dt><dd>× ${s / s0 < 1000 ? (s / s0).toFixed(1) : sciH(s / s0, 1)}</dd></dl><p class="note">${n0 ? '每個施體原子貢獻一個自由電子。每一百萬個原子摻幾個，就足以讓矽橫越大半個半導體範圍。' : '室溫下的純矽每 cm³ 只有約 1.5 × 10<sup>10</sup> 個自由電子，所以導電很差。'}</p>`);
    }
    const draw = canvas2d($('#ec-cv'), paint);
    dS.addEventListener('input', () => { draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     06-1 Lithium-ion battery (2D)
     ===================================================================== */
  function secLi() {
    const cv = $('#li-cv'), info = $('#li-info'); let mode = 'dis', last = null, on = false;
    const rnd = rng(7), ions = Array.from({ length: 16 }, (_, i) => ({ ph: i / 16, a: Math.floor(rnd() * 5), b: Math.floor(rnd() * 5), ja: rnd(), jb: rnd() }));
    let t = 0;
    function paint(x, W, H) {
      last = { x, W, H }; if (W < 100) return;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const top = 70, bot = H - 30, eW = W * 0.27, lx = 24, rx = W - 24 - eW, gap0 = lx + eW, gap1 = rx;
      // electrolyte and separator
      x.fillStyle = T.surface; x.fillRect(gap0, top, gap1 - gap0, bot - top);
      x.setLineDash([4, 4]); x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(W / 2, top); x.lineTo(W / 2, bot); x.stroke(); x.setLineDash([]);
      // graphite: flat layers
      const layers = 5, ly = i => top + 14 + i * (bot - top - 28) / (layers - 1);
      x.strokeStyle = T.edge3d; x.lineWidth = 4; for (let i = 0; i < layers; i++) { x.beginPath(); x.moveTo(lx, ly(i)); x.lineTo(lx + eW, ly(i)); x.stroke(); }
      // LiCoO2: CoO2 layers drawn as rows of small squares
      x.fillStyle = COL.plane; for (let i = 0; i < layers; i++) for (let k = 0; k < 9; k++) x.fillRect(rx + 4 + k * (eW - 8) / 9, ly(i) - 3, (eW - 8) / 9 - 3, 6);
      const mid = i => (ly(i) + ly(i + 1)) / 2;
      // Li+ ions
      const fromL = mode === 'dis';
      ions.forEach(o => {
        let p = (o.ph + t) % 1, xx, yy;
        const ax = lx + 10 + o.ja * (eW - 20), ay = mid(o.a % (layers - 1)), bx = rx + 10 + o.jb * (eW - 20), by = mid(o.b % (layers - 1));
        const A = fromL ? [ax, ay] : [bx, by], B = fromL ? [bx, by] : [ax, ay];
        if (p < 0.25) { xx = A[0]; yy = A[1]; } else if (p > 0.75) { xx = B[0]; yy = B[1]; } else { const s = (p - 0.25) / 0.5, e = s * s * (3 - 2 * s); xx = A[0] + (B[0] - A[0]) * e; yy = A[1] + (B[1] - A[1]) * e + Math.sin(s * Math.PI * 3 + o.ja * 6) * 6; }
        x.fillStyle = COL.body; x.beginPath(); x.arc(xx, yy, 5.5, 0, 7); x.fill();
        if (p > 0.25 && p < 0.75) { x.fillStyle = '#fff'; x.font = MFONT(700, 8); x.textAlign = 'center'; x.fillText('+', xx, yy + 3); }
      });
      // external circuit with electrons
      const wy = 26, path = [[lx + eW / 2, top], [lx + eW / 2, wy], [rx + eW / 2, wy], [rx + eW / 2, top]];
      x.strokeStyle = T.ink; x.lineWidth = 1.5; x.beginPath(); path.forEach((p, i) => (i ? x.lineTo(...p) : x.moveTo(...p))); x.stroke();
      x.fillStyle = T.stage; x.fillRect(W / 2 - 34, wy - 11, 68, 22); x.strokeRect(W / 2 - 34, wy - 11, 68, 22);
      x.fillStyle = T.ink; x.font = FONT(600, 11); x.textAlign = 'center'; x.fillText(mode === 'dis' ? tx('device', '裝置') : tx('charger', '充電器'), W / 2, wy + 4);
      const segL = [], tot = path.slice(1).reduce((s, p, i) => { const d = Math.hypot(p[0] - path[i][0], p[1] - path[i][1]); segL.push(d); return s + d; }, 0);
      x.fillStyle = T.hi;
      for (let k = 0; k < 14; k++) {
        let d = ((k / 14 + t * 1.3) % 1) * tot; if (!fromL) d = tot - d;
        let i = 0; while (i < segL.length - 1 && d > segL[i]) { d -= segL[i]; i++; }
        const a = path[i], b = path[i + 1], s = Math.min(1, d / segL[i]), px = a[0] + (b[0] - a[0]) * s, py = a[1] + (b[1] - a[1]) * s;
        if (Math.abs(px - W / 2) < 36 && Math.abs(py - wy) < 12) continue;
        x.beginPath(); x.arc(px, py, 3, 0, 7); x.fill();
      }
      x.fillStyle = T.muted; x.font = FONT(600, 11); x.textAlign = 'center';
      x.fillText(tx('graphite C₆ (anode)', '石墨 C₆（負極）'), lx + eW / 2, bot + 18); x.fillText(tx('LiCoO₂ (cathode)', 'LiCoO₂（正極）'), rx + eW / 2, bot + 18);
      x.fillText(tx('electrolyte', '電解質'), (gap0 + W / 2) / 2, bot + 18); x.fillText(tx('separator', '隔離膜'), W / 2 + 34, top - 6);
      x.fillStyle = T.hi; x.textAlign = 'left'; x.fillText(tx('e⁻ in the wire', '導線中的 e⁻'), lx, wy - 12);
    }
    function text() {
      info.innerHTML = mode === 'dis' ? tx('<div class="eq">anode:&emsp;LiC₆ → C₆ + Li⁺ + e⁻<br>cathode:&emsp;CoO₂ + Li⁺ + e⁻ → LiCoO₂</div><p>Lithium leaves the graphite layers as Li⁺ and slips between the CoO₂ layers. Its electron cannot pass the electrolyte, so it goes round through the device and powers it.</p>', '<div class="eq">負極：LiC₆ → C₆ + Li⁺ + e⁻<br>正極：CoO₂ + Li⁺ + e⁻ → LiCoO₂</div><p>鋰以 Li⁺ 的形式離開石墨層，鑽進 CoO₂ 層之間。它的電子過不了電解質，只能繞過裝置，順便供電。</p>')
        : tx('<div class="eq">anode:&emsp;C₆ + Li⁺ + e⁻ → LiC₆<br>cathode:&emsp;LiCoO₂ → CoO₂ + Li⁺ + e⁻</div><p>The charger pushes electrons back to the graphite, and Li⁺ follows through the electrolyte to slot between the graphite layers again.</p><p class="note">Both electrodes are layered crystals that let lithium in and out without falling apart. Choosing such materials is what battery research is about.</p>', '<div class="eq">負極：C₆ + Li⁺ + e⁻ → LiC₆<br>正極：LiCoO₂ → CoO₂ + Li⁺ + e⁻</div><p>充電器把電子推回石墨，Li⁺ 跟著穿過電解質，再度鑽進石墨層之間。</p><p class="note">兩個電極都是層狀晶體，可以讓鋰進出而不崩解。找出這種材料，就是電池研究在做的事。</p>');
    }
    const fit = canvas2d(cv, paint), again = () => { if (last) paint(last.x, last.W, last.H); };
    seg($('#li-mode'), m => { mode = m; again(); text(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { on = es[0].isIntersecting; }).observe(cv); else on = true;
    let prev = 0;
    const frame = now => { const dt = Math.min(50, now - prev) / 1000; prev = now; if (on && !REDUCED) { t = (t + dt * 0.12) % 1; again(); } requestAnimationFrame(frame); };
    if (REDUCED) t = 0.5;
    requestAnimationFrame(frame);
    text(); onLang(() => { again(); text(); });
    return () => fit();
  }

  /* =====================================================================
     07 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('Forging and quenching make a steel blade tougher. Which corner of the tetrahedron did they change directly?', '鍛造和淬火讓鋼刀更強韌。它們直接改變的是四面體的哪一個角？'), o: [tx('Processing, which then changed the structure', '製程，接著改變了結構'), tx('Performance, which then changed the processing', '性能，接著改變了製程'), tx('Properties, without changing the structure', '性質，結構沒有改變'), tx('Composition, by adding new elements', '成分，因為加入了新元素')], a: 0, e: tx('Forging and quenching are processing steps. They refine the grains and form hard phases (structure), which raises strength and toughness (properties).', '鍛造和淬火是製程步驟。它們讓晶粒變細、形成硬的相（結構），因而提高強度和韌性（性質）。') },
    { q: tx('What distinguishes an amorphous solid from a crystalline one?', '非晶質固體和晶體的差別是什麼？'), o: [tx('It has no long-range periodic arrangement of atoms', '原子沒有長程的週期排列'), tx('It has no short-range order between neighbors', '鄰近原子之間沒有短程規律'), tx('Its atoms are farther apart on average', '原子之間的平均距離比較遠'), tx('It is made of several different elements', '由好幾種不同元素組成')], a: 0, e: tx('Amorphous solids still keep near neighbors at about the right distance (short-range order), but the pattern does not repeat over long distances.', '非晶質固體的鄰近原子仍大致保持適當距離（短程規律），只是圖樣不會在長距離上重複。') },
    { q: tx('Which family of materials is typically hard, heat resistant and electrically insulating?', '哪一類材料通常又硬、又耐熱、又絕緣？'), o: [tx('Ceramics', '陶瓷'), tx('Metals', '金屬'), tx('Polymers', '高分子'), tx('Alloys', '合金')], a: 0, e: tx('Ceramics combine metallic and nonmetallic elements with strong ionic or covalent bonds: hard, wear resistant, very good insulators, used for furnace linings and heat shields.', '陶瓷由金屬與非金屬元素以強的離子鍵或共價鍵結合：硬、耐磨、非常絕緣，用於爐襯和隔熱片。') },
    { q: tx('Why are metals good electrical conductors?', '為什麼金屬導電性好？'), o: [tx('Their valence electrons move freely among the ions', '價電子可以在離子之間自由移動'), tx('Their ions move freely through the crystal', '離子可以在晶體中自由移動'), tx('Their atoms are packed less densely than others', '原子排得比其他材料鬆'), tx('Their atoms are lighter than other atoms', '原子比其他原子輕')], a: 0, e: tx('Metal atoms share their outer electrons in a common electron cloud. These free electrons carry current (and heat) when a voltage is applied.', '金屬原子把外層電子交到共用的電子雲裡。加上電壓時，這些自由電子就負責傳導電流（和熱）。') },
    { q: tx('Why is silicon, rather than copper, the basis of transistors?', '為什麼電晶體用矽而不是銅？'), o: [tx('Doping can tune its conductivity over many decades', '摻雜可以把導電率調整好幾個數量級'), tx('It conducts electricity better than copper', '它的導電性比銅好'), tx('It is a perfect insulator at room temperature', '它在室溫下是完美的絕緣體'), tx('It is much stronger than any metal', '它比任何金屬都強')], a: 0, e: tx('A semiconductor\'s conductivity can be set by doping, alloying and junction design. That control is what lets a transistor switch.', '半導體的導電率可以靠摻雜、合金化和接面設計來決定；正是這種控制，讓電晶體能開關。') },
    { q: tx('Which describes a composite material such as fiberglass?', '哪一句描述了玻璃纖維這類複合材料？'), o: [tx('Fibers bonded in a matrix, neither dissolving in the other', '纖維黏在基材裡，兩者互不溶解'), tx('Two metals melted together into one solid solution', '兩種金屬熔在一起成為固溶體'), tx('A single polymer with very long, aligned chains', '一種分子鏈很長、排列整齊的高分子'), tx('A ceramic with no grain boundaries at all', '完全沒有晶界的陶瓷')], a: 0, e: tx('A composite mixes a filler (glass fibers) and a binder (polyester or epoxy). They bond but stay separate materials, combining low weight with high strength.', '複合材料混合填充物（玻璃纖維）和黏結劑（聚酯或環氧樹脂）。兩者結合但仍是不同材料，兼具輕量與高強度。') }
  ]; });
  const QPERM = (() => { const r = rng(20261028); return Array.from({ length: 6 }, () => { const p = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; }); })();
  dataset(() => { QUIZ.forEach((q, i) => { const p = QPERM[i], o = q.o.slice(); q.o = p.map(k => o[k]); q.a = p.indexOf(q.a); }); });

  function boot() {
    if (GL) {
      try { heroScene(); } catch (e) { console.error(e); }
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    [secPs, secAr, secFam].forEach(f => { try { f(); } catch (e) { console.error(e); } });
    [secTr, secEc, secLi].forEach(f => { try { redraw2D.push(f()); } catch (e) { console.error(e); } });
    secQuiz(); toc();
  }

  function secQuiz() {
    const root = $('#quiz'), sc = $('#quiz-score'); let done = 0, right = 0;
    const verdict = ok => (ok ? tx('<b style="color:var(--ok)">Correct. </b>', '<b style="color:var(--ok)">答對了。</b>') : tx('<b style="color:var(--bad)">Not quite. </b>', '<b style="color:var(--bad)">再想想。</b>'));
    const scoreText = () => { sc.textContent = tx(`Answered ${done} / ${QUIZ.length}, correct ${right}`, `已作答 ${done} / ${QUIZ.length} 題，答對 ${right} 題`); };
    root.innerHTML = QUIZ.map((q, i) => `<div class="q" data-i="${i}"><p class="qt"><span>Q${i + 1}</span>${q.q}</p><div class="opts">${q.o.map((o, j) => `<button type="button" data-j="${j}"><span class="opt-l">${String.fromCharCode(65 + j)}</span><span>${o}</span></button>`).join('')}</div><p class="explain" hidden></p></div>`).join('');
    root.addEventListener('click', e => {
      const b = e.target.closest('.opts button'); if (!b) return; const box = b.closest('.q'), q = QUIZ[+box.dataset.i], j = +b.dataset.j;
      if (box.dataset.done) return; box.dataset.done = '1'; done++; if (j === q.a) right++;
      $$('.opts button', box).forEach((x, k) => { x.disabled = true; if (k === q.a) x.classList.add('right'); else if (k === j) x.classList.add('wrong'); });
      box.dataset.pick = j; const ex = $('.explain', box); ex.hidden = false; ex.innerHTML = verdict(j === q.a) + q.e;
      scoreText();
    });
    onLang(() => {
      $$('.q', root).forEach((box, i) => {
        const q = QUIZ[i];
        $('.qt', box).lastChild.nodeValue = q.q;
        $$('.opts button', box).forEach((x, j) => { x.lastElementChild.textContent = q.o[j]; });
        if (box.dataset.pick) $('.explain', box).innerHTML = verdict(+box.dataset.pick === q.a) + q.e;
      });
      scoreText();
    });
    scoreText();
  }

  /* =====================================================================
     TOC highlight
     ===================================================================== */
  function toc() {
    const links = $$('.toc a'), map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
    const ob = new IntersectionObserver(es => {
      es.forEach(e => {
        if (!e.isIntersecting) return;
        links.forEach(a => a.classList.remove('on')); const a = map.get(e.target.id); if (!a) return;
        a.classList.add('on');
        // measure against the scrolling list itself: offsetLeft counts from nav.toc and is off by the centred column's margin
        const ol = a.closest('ol'), x = a.getBoundingClientRect().left - ol.getBoundingClientRect().left + ol.scrollLeft;
        if (x < ol.scrollLeft || x + a.offsetWidth > ol.scrollLeft + ol.clientWidth) ol.scrollTo({ left: x - (ol.clientWidth - a.offsetWidth) / 2, behavior: REDUCED ? 'auto' : 'smooth' });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('section.unit').forEach(s => ob.observe(s));
  }

  function onTheme() {
    readTheme(); syncTheme();
    VIEWERS.forEach(v => { if (v.rebuild && !v.init) v.rebuild(); v.dirty = true; });
    redraw2D.forEach(f => f && f());
  }
  /* ---------- language switch: text only, nothing is rebuilt or reset ---------- */
  const ANCHORS = 'header.hero, .unit-head, .unit > h3, .lab, .key, .tbl-wrap, .cards, .flow, .unit > .prose, #quiz .q, footer';
  function syncChrome() {
    const zh = LANG === 'zh';
    document.documentElement.lang = zh ? 'zh-Hant' : 'en';
    document.title = tx("Introduction to Materials 3D Classroom", "材料科學導論 3D 教室");
    $('#lang-zh').setAttribute('aria-pressed', String(zh)); $('#lang-en').setAttribute('aria-pressed', String(!zh));
  }
  function setLang(lang) {
    if (lang === LANG) return;
    // keep the block nearest the top of the viewport where it is, because the two languages wrap differently
    let anchor = null, off = 0, gap = Infinity;
    if (window.scrollY > 2) $$(ANCHORS).forEach(e => { const t = e.getBoundingClientRect().top, g = Math.abs(t - 80); if (g < gap) { gap = g; anchor = e; off = t; } });
    LANG = lang; X.save(lang);
    syncChrome(); X.apply(lang);
    DATA.forEach(f => f());
    VIEWERS.forEach(v => v.applyLang());
    HOOKS.forEach(f => f());
    redraw2D.forEach(f => f && f());
    if (lang === 'zh' && document.fonts && document.fonts.load) document.fonts.load('500 12px "Noto Sans TC"', '入射光相對強度實部虛部').then(() => redraw2D.forEach(f => f && f()), () => {});
    if (!anchor) return;
    let live = true; const stop = () => { live = false; };
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(t => window.addEventListener(t, stop, { once: true, passive: true }));
    const place = () => { if (live && anchor.isConnected) window.scrollTo({ top: anchor.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); };
    place(); requestAnimationFrame(place); [150, 500, 1200].forEach(ms => setTimeout(place, ms));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  }
  $('#lang-zh').addEventListener('click', () => setLang('zh'));
  $('#lang-en').addEventListener('click', () => setLang('en'));

  const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const syncTheme = () => $('#theme-toggle').setAttribute('aria-pressed', String(isDark()));
  $('#theme-toggle').addEventListener('click', () => {
    const t = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = t;
    try { localStorage.setItem('xtal-theme', t); } catch (e) { /* storage unavailable: the choice lasts for this visit */ }
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  boot(); syncChrome(); syncTheme();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onTheme);
})();
