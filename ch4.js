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
     Dislocation in a simple cubic block (hero and unit 06)
     Displacement field of a straight dislocation along z in an isotropic elastic solid.
     be / bs: edge and screw parts of b in lattice steps.
     ===================================================================== */
  function disField(x, y, be, bs) {
    const nu = 0.3, r2 = x * x + y * y, th = Math.atan2(y, x);
    return [be / (2 * Math.PI) * (th + x * y / (2 * (1 - nu) * r2)),
      -be / (2 * Math.PI) * ((1 - 2 * nu) / (4 * (1 - nu)) * Math.log(r2) + (x * x - y * y) / (4 * (1 - nu) * r2)),
      bs / (2 * Math.PI) * th];
  }
  // World axes: x across, y along the dislocation line (into the screen), z up. Returns the index → position map.
  function disBlock(g, o) {
    const { nx, ny, nz, x0, be, bs } = o, cx = (nx - 1) / 2, cy = (ny - 1) / 2;
    const W = (i, j, k) => { const x = i - cx, y = j - cy, u = disField(x - x0, y, be, bs); return V3(x + u[0], k + u[2], y + u[1]); };
    let half = -1; // the upper column that ends at the core is the extra half-plane
    if (be) { let best = 0.75; for (let i = 0; i < nx; i++) { const d = Math.abs(W(i, ny / 2, 0).x - x0); if (d < best) { best = d; half = i; } } }
    const host = [], extra = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) (i === half && j >= ny / 2 ? extra : host).push(W(i, j, k));
    cloud(g, host, 0.47, COL.corner); cloud(g, extra, 0.47, COL.body);
    return W;
  }

  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [0.5, -1, 0.42], label: () => tx('Hard-sphere model of a crystal with an edge dislocation', '含有一條刃差排的晶體硬球模型'), clear: 0 });
    v.rebuild = () => {
      v.clear(); const g = v.root;
      disBlock(g, { nx: 9, ny: 8, nz: 5, x0: 0.5, be: 1, bs: 0 });
      rod(g, V3(0.5, -1.2, 0), V3(0.5, 5.2, 0), 0.07, mStd(T.hi));
    };
    v.rebuild(); v.frame(V3(0, 2, 0), 6.7);
    if (!REDUCED) v.setSpin(true);
  }

  /* =====================================================================
     01 Solidification: atoms freezing into grains (2D)
     ===================================================================== */
  function secSolid() {
    const cv = $('#so-cv'), tS = $('#so-t'), info = $('#so-info');
    const st = { mode: 'few', t: REDUCED ? 1 : 0, play: !REDUCED };
    let M = null, last = null, on = false, shown = '';
    function build(W, H) {
      const rnd = rng({ few: 11, many: 23, wall: 5 }[st.mode]), a = W < 480 ? 8 : 9.5, seeds = [];
      const add = (x, y) => seeds.push({ x, y, th: rnd() * Math.PI / 3 });
      if (st.mode === 'wall') {
        const n = Math.max(4, Math.round(H / 30)), m = Math.max(5, Math.round(W / 30));
        for (let i = 0; i < n; i++) { add(4, (i + 0.2 + 0.6 * rnd()) * H / n); add(W - 4, (i + 0.2 + 0.6 * rnd()) * H / n); }
        for (let i = 0; i < m; i++) add((i + 0.2 + 0.6 * rnd()) * W / m, H - 4);
      } else {
        const n = st.mode === 'few' ? 5 : Math.round(W * H / 5200);
        const gap = st.mode === 'few' ? Math.min(W, H) * 0.3 : 24;
        for (let i = 0, tries = 0; i < n && tries < 4000; tries++) { const x = (0.06 + 0.88 * rnd()) * W, y = (0.06 + 0.88 * rnd()) * H; if (seeds.some(q => Math.hypot(q.x - x, q.y - y) < gap)) continue; add(x, y); i++; }
      }
      // nearest and second-nearest seed
      // nearest seed, its distance, and the distance to the boundary with the next-nearest seed
      const near = (x, y) => { let k = -1, k2 = -1, d = 1e9, d2 = 1e9; for (let i = 0; i < seeds.length; i++) { const e = Math.hypot(x - seeds[i].x, y - seeds[i].y); if (e < d) { d2 = d; k2 = k; d = e; k = i; } else if (e < d2) { d2 = e; k2 = i; } } const sep = k2 < 0 ? 1 : Math.hypot(seeds[k].x - seeds[k2].x, seeds[k].y - seeds[k2].y); return [k, d, k2 < 0 ? 1e9 : (d2 * d2 - d * d) / (2 * sep)]; };
      const atoms = [], nmax = Math.ceil(Math.hypot(W, H) / a);
      seeds.forEach((s, si) => {
        const c = Math.cos(s.th), sn = Math.sin(s.th);
        for (let i = -nmax; i <= nmax; i++) for (let j = -nmax; j <= nmax; j++) {
          const u = (i + (j & 1) / 2) * a, w = j * a * 0.866, x = s.x + u * c - w * sn, y = s.y + u * sn + w * c;
          if (x < 7 || y < 4 || x > W - 7 || y > H - 7) continue;
          const [k, d, edge] = near(x, y);
          if (k === si && edge > a * 0.3) atoms.push({ x, y, d, s: si });
        }
      });
      const liq = [], nl = Math.round(atoms.length * 0.8);
      for (let i = 0; i < nl; i++) { const x = 7 + rnd() * (W - 14), y = 4 + rnd() * (H - 11); liq.push({ x, y, d: near(x, y)[1], ph: rnd() * 6.28 }); }
      return { W, H, mode: st.mode, a, seeds, atoms, liq, rmax: atoms.reduce((m, p) => Math.max(m, p.d), 0) };
    }
    function paint(x, W, H) {
      last = { x, W, H };
      if (!M || M.W !== W || M.H !== H || M.mode !== st.mode) M = build(W, H);
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const rho = st.t >= 1 ? 1e9 : st.t * M.rmax * 1.03, now = performance.now() / 260, ra = M.a * 0.4;
      x.fillStyle = T.ghost3d; x.beginPath();
      for (const p of M.liq) {
        if (p.d <= rho) continue;
        const dx = REDUCED ? 0 : 1.8 * Math.sin(now + p.ph), dy = REDUCED ? 0 : 1.8 * Math.cos(now * 1.3 + p.ph * 2);
        x.moveTo(p.x + dx + ra, p.y + dy); x.arc(p.x + dx, p.y + dy, ra, 0, 7);
      }
      x.fill();
      let solid = 0;
      for (let c = 0; c < 3; c++) {
        x.globalAlpha = [1, 0.8, 0.62][c]; x.fillStyle = COL.corner; x.beginPath();
        for (const p of M.atoms) { if (p.s % 3 !== c || p.d > rho) continue; solid++; x.moveTo(p.x + ra, p.y); x.arc(p.x, p.y, ra, 0, 7); }
        x.fill();
      }
      x.globalAlpha = 1;
      x.strokeStyle = T.accent; x.lineWidth = 5; x.beginPath(); x.moveTo(2.5, 0); x.lineTo(2.5, H - 2.5); x.lineTo(W - 2.5, H - 2.5); x.lineTo(W - 2.5, 0); x.stroke();
      M.frac = solid / Math.max(1, M.atoms.length);
    }
    function text() {
      if (!M) return;
      const n = M.seeds.length, pc = Math.round(M.frac * 100), done = st.t >= 1;
      const why = {
        few: tx('Only a few nuclei formed, so each one had room to grow. The result is a few large grains.', '晶核只有少數幾個，每個都有很大的空間可以長。結果是幾顆很大的晶粒。'),
        many: tx('Nuclei formed everywhere at once. Each one is stopped by its neighbors almost immediately, so the grains are small and equiaxed.', '到處同時出現晶核，每個才長一點就被鄰居擋住，所以晶粒細小，而且是等軸晶。'),
        wall: tx('Nuclei formed only on the cold mold wall. The crystals can only grow inward, and they crowd each other into long columnar grains.', '晶核只出現在冰冷的模壁上。晶體只能往內長，彼此擠成長條形的柱狀晶。')
      }[st.mode];
      const s = tx(`<h4>${done ? 'Fully solid' : pc ? 'Freezing' : 'All liquid'}</h4><dl class="stats"><dt>Nuclei</dt><dd>${n}</dd><dt>Grains when done</dt><dd>${n}</dd><dt>Solid so far</dt><dd>${pc}%</dd></dl><p>${why}</p><p class="note">Look at the rows of atoms inside each grain. They point a different way in every grain, and the thin gaps where the rows fail to meet are the grain boundaries.</p>`,
        `<h4>${done ? '完全凝固' : pc ? '凝固中' : '全是液體'}</h4><dl class="stats"><dt>晶核數</dt><dd>${n}</dd><dt>最後的晶粒數</dt><dd>${n}</dd><dt>已凝固</dt><dd>${pc}%</dd></dl><p>${why}</p><p class="note">看每顆晶粒裡原子排成的列。每顆晶粒的方向都不同，列與列接不上的那些細縫就是晶界。</p>`);
      if (s !== shown) { shown = s; info.innerHTML = s; }
    }
    const fit = canvas2d(cv, paint), again = () => { if (last) paint(last.x, last.W, last.H); text(); };
    seg($('#so-mode'), m => { st.mode = m; st.t = REDUCED ? 1 : 0; st.play = !REDUCED; tS.value = st.t; again(); });
    tS.addEventListener('input', () => { st.t = +tS.value; st.play = false; again(); });
    $('#so-play').addEventListener('click', () => { st.t = 0; st.play = true; tS.value = 0; again(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { on = es[0].isIntersecting; }).observe(cv); else on = true;
    let prev = 0;
    const frame = now => {
      if (on) {
        if (st.play) { st.t = Math.min(1, st.t + Math.min(100, now - prev) / 9000); tS.value = st.t; if (st.t >= 1) st.play = false; again(); }
        else if (!REDUCED && st.t < 1) again();
      }
      prev = now; requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    tS.value = st.t; onLang(() => { shown = ''; text(); });
    return () => { fit(); text(); };
  }

  /* =====================================================================
     01-1 Driving force: G of solid and liquid against T (copper)
     The absolute value of G has no meaning, so both lines are drawn through
     G = 0 at T_m. The solid slope is a free choice; only the slope
     difference ΔS = ΔH_f / T_m matters, and that is the real copper value.
     ===================================================================== */
  function secDG() {
    const tS = $('#dg-T'), info = $('#dg-info');
    const T0 = 1050, T1 = 1450, THOM = 1356 - 236, sS = 0.4;
    const dS = () => CU.Hf / CU.Tm;
    const gS = t => -sS * (t - CU.Tm), gL = t => -(sS + dS()) * (t - CU.Tm);
    const calc = () => { const t = +tS.value, dT = CU.Tm - t; return { t, dT, Gv: dT === 0 ? 0 : -CU.Hf * dT / CU.Tm }; };
    const head = (x, x0, y0, x1, y1, s) => { const a = Math.atan2(y1 - y0, x1 - x0); x.beginPath(); x.moveTo(x1, y1); x.lineTo(x1 - s * Math.cos(a - 0.45), y1 - s * Math.sin(a - 0.45)); x.lineTo(x1 - s * Math.cos(a + 0.45), y1 - s * Math.sin(a + 0.45)); x.closePath(); x.fill(); };
    function paint(x, W, H) {
      const c = calc(), Tm = CU.Tm;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 34, mr = 16, mt = 34, mb = 40, y1 = 590, y0 = -200;
      const X = t => ml + (t - T0) / (T1 - T0) * (W - ml - mr), Y = g => mt + (y1 - g) / (y1 - y0) * (H - mt - mb);
      // the solid-stable side, lightly shaded
      x.save(); x.globalAlpha = 0.55; x.fillStyle = T.surface; x.fillRect(ml, mt, X(Tm) - ml, H - mt - mb); x.restore();
      x.font = MFONT(400, 11); x.fillStyle = T.muted; x.strokeStyle = T.grid; x.lineWidth = 1; x.textAlign = 'center';
      const every = W < 520 ? 100 : 50;
      for (let t = T0; t <= T1; t += 50) { if ((t - T0) % every) continue; x.beginPath(); x.moveTo(X(t), mt); x.lineTo(X(t), H - mb); x.stroke(); x.fillText(t, X(t), H - mb + 16); }
      x.fillText(tx('temperature T (K)', '溫度 T（K）'), (ml + W - mr) / 2, H - 5);
      x.save(); x.translate(13, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.fillText(tx('G (relative)', 'G（相對值）'), 0, 0); x.restore();
      x.font = MFONT(500, 11); x.textAlign = 'left'; x.fillText(tx('SOLID IS STABLE', '固體穩定'), ml + 6, mt - 14);
      x.textAlign = 'right'; x.fillText(tx('LIQUID IS STABLE', '液體穩定'), W - mr - 6, mt - 14);
      // T_m and the homogeneous-nucleation limit of copper (Unit 2)
      x.setLineDash([4, 4]); x.lineWidth = 1.2;
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(X(Tm), mt); x.lineTo(X(Tm), H - mb); x.stroke();
      x.strokeStyle = COL.plane; x.beginPath(); x.moveTo(X(THOM), mt); x.lineTo(X(THOM), H - mb); x.stroke(); x.setLineDash([]);
      x.font = MFONT(600, 11); x.textAlign = 'left'; x.fillStyle = T.ink; x.fillText('Tm = 1356 K', X(Tm) + 5, mt + 13);
      x.fillStyle = COL.plane; x.font = FONT(500, 11); x.fillText(tx('Cu nucleates by itself', '銅自己成核'), X(THOM) + 5, mt + 13);
      x.save(); x.beginPath(); x.rect(ml, mt, W - ml - mr, H - mt - mb); x.clip();
      const line = (f, col) => { x.strokeStyle = col; x.lineWidth = 2.4; x.beginPath(); x.moveTo(X(T0), Y(f(T0))); x.lineTo(X(T1), Y(f(T1))); x.stroke(); };
      line(gL, T.edge3d); line(gS, COL.corner);
      // the gap at the chosen temperature
      const xs = X(c.t), ys = Y(gS(c.t)), yl = Y(gL(c.t));
      x.strokeStyle = T.ink; x.globalAlpha = 0.25; x.lineWidth = 1; x.beginPath(); x.moveTo(xs, mt); x.lineTo(xs, H - mb); x.stroke(); x.globalAlpha = 1;
      if (c.dT !== 0) { x.strokeStyle = T.accent; x.lineWidth = 5; x.beginPath(); x.moveTo(xs, ys); x.lineTo(xs, yl); x.stroke(); }
      const dot = (y, col, fill) => { x.beginPath(); x.arc(xs, y, 6, 0, 7); x.fillStyle = fill ? col : T.stage; x.fill(); x.strokeStyle = fill ? T.stage : col; x.lineWidth = 2; x.stroke(); };
      dot(yl, T.edge3d, c.dT < 0); dot(ys, COL.corner, c.dT >= 0);
      x.restore();
      // line labels at the right end, where the solid line is the upper one
      x.font = FONT(600, 12); x.textAlign = 'right';
      x.fillStyle = COL.corner; x.fillText(tx('GS  solid', 'GS 固體'), W - mr - 6, Y(gS(T1 - 10)) - 9);
      x.fillStyle = T.edge3d; x.fillText(tx('GL  liquid', 'GL 液體'), W - mr - 6, Y(gL(T1 - 10)) + 18);
      if (c.dT !== 0) {
        // both lines fall to the right, so the space above-right of the upper dot is clear;
        // near the right edge put it at the top of the guide line, under the T_m label
        const lab = `|ΔGv| = ${Math.abs(c.Gv).toFixed(0)} J/cm³`;
        x.font = MFONT(600, 12); x.fillStyle = T.accent;
        const fits = xs + 14 + x.measureText(lab).width < W - mr;
        x.textAlign = fits ? 'left' : 'right';
        x.fillText(lab, xs + (fits ? 12 : -8), fits ? Math.min(ys, yl) - 8 : mt + 32);
      }
      // ΔT bracket along the bottom
      if (Math.abs(c.dT) >= 6) {
        const yb = H - mb - 12, xa = X(c.t), xb = X(Tm);
        x.strokeStyle = T.ink; x.fillStyle = T.ink; x.lineWidth = 1.4;
        x.beginPath(); x.moveTo(xa, yb); x.lineTo(xb, yb); x.stroke(); head(x, xb, yb, xa, yb, 7); head(x, xa, yb, xb, yb, 7);
        x.font = MFONT(600, 12); x.textAlign = 'center'; x.fillText(`ΔT = ${c.dT < 0 ? '−' + -c.dT : c.dT} K`, (xa + xb) / 2, yb - 7);
      }
    }
    function text() {
      const c = calc(), s = dS(), mol = s * 7.09;
      const minus = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(0);
      const dTs = c.dT < 0 ? `(−${-c.dT})` : `${c.dT}`;
      $('#dg-T-v').textContent = c.t + ' K';
      const st = c.dT > 0 ? 'S' : c.dT < 0 ? 'L' : '0';
      const eq = `ΔS = ΔH<sub>f</sub> / T<sub>m</sub> = 1826 / 1356 = ${s.toFixed(2)} J/(cm³·K)<br>ΔG<sub>v</sub> ≈ −ΔS · ΔT = −${s.toFixed(2)} × ${dTs} = ${minus(c.Gv)} J/cm³`;
      info.innerHTML = tx(`<p>${st === 'S' ? '<span class="pill ok">Solid is stable</span> Below T<sub>m</sub> the solid line is lower. Freezing would lower G by the gap.' : st === 'L' ? '<span class="pill bad">Liquid is stable</span> Above T<sub>m</sub> the liquid line is lower. A solid here would melt.' : '<span class="pill">Equilibrium</span> The lines cross. Solid and liquid can coexist, and nothing drives freezing or melting.'}</p>
        <dl class="stats"><dt>Undercooling ΔT</dt><dd>${minus(c.dT)} K</dd><dt>Driving force ΔG<sub>v</sub></dt><dd>${minus(c.Gv)} J/cm³</dd><dt>ΔG<sub>v</sub> per kelvin of ΔT</dt><dd>−${s.toFixed(2)} J/(cm³·K), at every T</dd></dl>
        <div class="eq">${eq}</div>
        <p class="note">${c.t <= THOM ? 'This far below T<sub>m</sub>, pure copper nucleates on its own (about 236 K of undercooling, Unit 2).' : `Per mole the same ΔS is ${s.toFixed(2)} × 7.09 cm³/mol = ${mol.toFixed(1)} J/(mol·K), about ${(mol / 8.314).toFixed(1)} R. This is the “≈ R” on the slides.`}</p>`,
        `<p>${st === 'S' ? '<span class="pill ok">固體穩定</span>　低於 T<sub>m</sub>，固體的線比較低。凝固可以讓 G 降低這段距離。' : st === 'L' ? '<span class="pill bad">液體穩定</span>　高於 T<sub>m</sub>，液體的線比較低。這裡的固體會熔化。' : '<span class="pill">平衡</span>　兩條線相交。固體和液體可以共存，沒有東西推動凝固或熔化。'}</p>
        <dl class="stats"><dt>過冷度 ΔT</dt><dd>${minus(c.dT)} K</dd><dt>驅動力 ΔG<sub>v</sub></dt><dd>${minus(c.Gv)} J/cm³</dd><dt>每過冷 1 K 的 ΔG<sub>v</sub></dt><dd>−${s.toFixed(2)} J/(cm³·K)，每個溫度都一樣</dd></dl>
        <div class="eq">${eq}</div>
        <p class="note">${c.t <= THOM ? '比 T<sub>m</sub> 低這麼多，純銅會自己成核（過冷約 236 K，見第 2 單元）。' : `換成每莫耳，同一個 ΔS 是 ${s.toFixed(2)} × 7.09 cm³/mol = ${mol.toFixed(1)} J/(mol·K)，約 ${(mol / 8.314).toFixed(1)} R，就是投影片上的「≈ R」。`}</p>`);
    }
    const draw = canvas2d($('#dg-cv'), paint);
    const up = () => { draw(); text(); };
    tS.addEventListener('input', up);
    $('#dg-m').addEventListener('click', () => { tS.value = CU.Tm; up(); });
    draw(); text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     02 Critical nucleus (copper)
     ===================================================================== */
  const CU = { g: 177e-7, Hf: 1826, Tm: 1356, a: 0.3615 }; // J/cm², J/cm³, K, nm
  function fccPts(a, reach, keep, z0 = 0) {
    const out = [], n = Math.ceil(reach / a) + 1;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (let k = -n; k <= n; k++) for (const b of FCC_B) {
      const x = (i + b[0]) * a, y = (j + b[1]) * a, z = (k + b[2]) * a + z0; if (keep(x, y, z)) out.push(V3(x, y, z));
    }
    return out;
  }
  function secNuc() {
    const dt = $('#nu-dt'), rr = $('#nu-r'), info = $('#nu-info'); let n = 0;
    const calc = () => {
      const dT = +dt.value, r = +rr.value, Gv = -CU.Hf * dT / CU.Tm, rs = -2 * CU.g / Gv * 1e7, Gs = 16 * Math.PI * CU.g ** 3 / (3 * Gv * Gv) / EV;
      const vol = x => 4 / 3 * Math.PI * (x * 1e-7) ** 3 * Gv / EV, sur = x => 4 * Math.PI * (x * 1e-7) ** 2 * CU.g / EV;
      return { dT, r, Gv, rs, Gs, vol, sur, G: x => vol(x) + sur(x) };
    };
    const v = GL ? new Viewer($('#v-nuc'), { view: [1, 0.5, 0.4], label: () => tx('Cluster of copper atoms beside a sphere of the critical radius', '銅原子團和臨界半徑的球') }) : null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root, c = calc();
      const pts = fccPts(CU.a, c.r, (x, y, z) => x * x + y * y + z * z <= c.r * c.r + 1e-9);
      cloud(g, pts, CU.a * S2 / 4, c.r < c.rs ? T.hi : COL.corner); n = pts.length;
      shell(g, V3(0, 0, 0), c.rs, COL.plane, 0.15);
    };
    function paint(x, W, H) {
      const c = calc();
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 56, mr = 16, mt = 30, mb = 38, xm = 3.6, y1 = c.Gs * 1.9, y0 = -c.Gs * 1.3;
      const X = r => ml + r / xm * (W - ml - mr), Y = e => mt + (y1 - e) / (y1 - y0) * (H - mt - mb);
      x.font = MFONT(400, 11); x.fillStyle = T.muted; x.strokeStyle = T.grid; x.lineWidth = 1; x.textAlign = 'center';
      for (let r = 0; r <= 3.5; r += 0.5) { x.beginPath(); x.moveTo(X(r), mt); x.lineTo(X(r), H - mb); x.stroke(); x.fillText(r.toFixed(1), X(r), H - mb + 16); }
      x.fillText(tx('cluster radius r (nm)', '原子團半徑 r（nm）'), (ml + W - mr) / 2, H - 5);
      x.textAlign = 'right'; [-c.Gs, 0, c.Gs].forEach(e => x.fillText(e.toFixed(1), ml - 8, Y(e) + 4));
      x.save(); x.translate(13, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.fillText('ΔG (eV)', 0, 0); x.restore();
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, Y(0)); x.lineTo(W - mr, Y(0)); x.stroke();
      x.save(); x.beginPath(); x.rect(ml, mt - 12, W - ml - mr, H - mt - mb + 12); x.clip();
      const curve = (f, col, lw, dash) => { x.strokeStyle = col; x.lineWidth = lw; x.setLineDash(dash || []); x.beginPath(); for (let px = ml; px <= W - mr; px += 2) { const r = (px - ml) / (W - ml - mr) * xm, yy = Y(f(r)); px === ml ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); x.setLineDash([]); };
      curve(c.sur, COL.body, 1.6, [5, 4]); curve(c.vol, COL.corner, 1.6, [5, 4]); curve(c.G, T.accent, 2.6);
      x.setLineDash([3, 4]); x.strokeStyle = COL.plane; x.lineWidth = 1.4; x.beginPath(); x.moveTo(X(c.rs), Y(c.Gs)); x.lineTo(X(c.rs), H - mb); x.moveTo(ml, Y(c.Gs)); x.lineTo(X(c.rs), Y(c.Gs)); x.stroke(); x.setLineDash([]);
      const gy = Math.max(mt - 6, Math.min(H - mb, Y(c.G(c.r))));
      x.fillStyle = c.r < c.rs ? T.hi : COL.corner; x.beginPath(); x.arc(X(c.r), gy, 6.5, 0, 7); x.fill(); x.strokeStyle = T.stage; x.lineWidth = 2; x.stroke();
      x.restore();
      x.font = FONT(500, 12); x.textAlign = 'left';
      const lab = (t, r, f, col, dy) => { const yy = Math.max(mt + 10, Math.min(H - mb - 6, Y(f(r)) + dy)); x.fillStyle = col; x.fillText(t, X(r) + 6, yy); };
      const rS = Math.sqrt(y1 * 0.8 / c.sur(1)), rV = Math.cbrt(y0 * 0.8 / c.vol(1));
      lab(tx('surface term  4πr²γ', '表面項 4πr²γ'), rS, c.sur, COL.body, 4); lab(tx('volume term  (4/3)πr³ΔGv', '體積項 (4/3)πr³ΔGv'), rV, c.vol, COL.corner, 4);
      x.fillStyle = COL.plane; x.font = MFONT(600, 12); x.textAlign = 'center'; x.fillText('r*', X(c.rs), mt + (Y(c.Gs) - mt) * 0.4 > mt + 10 ? Y(c.Gs) - 9 : mt + 10);
      x.textAlign = 'left'; x.fillStyle = T.ink; x.font = FONT(700, 12); x.fillText(tx('total ΔG', '總和 ΔG'), Math.min(W - mr - 70, X(c.rs * 1.5) + 8), Math.max(mt + 12, Y(c.G(c.rs * 1.5)) - 8));
      x.fillStyle = T.muted; x.font = MFONT(500, 11); x.fillText(tx(`COPPER, ΔT = ${c.dT} K`, `銅，ΔT = ${c.dT} K`), ml + 6, mt - 14);
    }
    function text() {
      const c = calc(), ok = c.r >= c.rs, Ns = 4 / 3 * Math.PI * c.rs ** 3 * 4 / CU.a ** 3;
      $('#nu-dt-v').textContent = c.dT + ' K'; $('#nu-r-v').textContent = c.r.toFixed(2) + ' nm';
      const cnt = GL && !v.init ? n : Math.round(4 / 3 * Math.PI * c.r ** 3 * 4 / CU.a ** 3) || 1;
      info.innerHTML = tx(`<p>${ok ? '<span class="pill ok">Nucleus</span> Adding atoms now lowers the energy, so this cluster keeps growing.' : '<span class="pill bad">Embryo</span> Adding atoms still raises the energy, so this cluster shrinks and dissolves.'}</p>
        <dl class="stats"><dt>Critical radius r*</dt><dd>${c.rs.toFixed(2)} nm</dd><dt>Atoms in a critical nucleus</dt><dd>about ${Math.round(Ns / 10) * 10}</dd><dt>Energy barrier ΔG*</dt><dd>${c.Gs.toFixed(1)} eV</dd><dt>This cluster</dt><dd>${cnt} atom${cnt > 1 ? 's' : ''}, ΔG = ${c.G(c.r).toFixed(1)} eV</dd></dl>
        <div class="eq">ΔG<sub>v</sub> = −ΔH<sub>f</sub> ΔT / T<sub>m</sub> = −1826 × ${c.dT} / 1356 = ${c.Gv.toFixed(0)} J/cm³<br>r* = −2γ / ΔG<sub>v</sub> = 2 × 177 × 10⁻⁷ / ${(-c.Gv).toFixed(0)} = ${sci(c.rs * 1e-7, 2)} cm</div>
        <p class="note">Copper can be undercooled by at most about 236 K before it nucleates on its own. At that point a critical nucleus is about 1.1 nm in radius.</p>`,
        `<p>${ok ? '<span class="pill ok">晶核</span>　再加原子，能量會下降，所以這個原子團會一直長下去。' : '<span class="pill bad">晶胚</span>　再加原子，能量還在上升，所以這個原子團會縮小、溶回去。'}</p>
        <dl class="stats"><dt>臨界半徑 r*</dt><dd>${c.rs.toFixed(2)} nm</dd><dt>臨界晶核的原子數</dt><dd>約 ${Math.round(Ns / 10) * 10} 個</dd><dt>能量障礙 ΔG*</dt><dd>${c.Gs.toFixed(1)} eV</dd><dt>這個原子團</dt><dd>${cnt} 個原子，ΔG = ${c.G(c.r).toFixed(1)} eV</dd></dl>
        <div class="eq">ΔG<sub>v</sub> = −ΔH<sub>f</sub> ΔT / T<sub>m</sub> = −1826 × ${c.dT} / 1356 = ${c.Gv.toFixed(0)} J/cm³<br>r* = −2γ / ΔG<sub>v</sub> = 2 × 177 × 10⁻⁷ / ${(-c.Gv).toFixed(0)} = ${sci(c.rs * 1e-7, 2)} cm</div>
        <p class="note">銅最多能過冷大約 236 K，再低就會自己成核。這時臨界晶核的半徑大約 1.1 nm。</p>`);
    }
    const draw = canvas2d($('#nu-cv'), paint);
    const up = () => { if (v && !v.init) v.rebuild(); draw(); text(); };
    dt.addEventListener('input', up); rr.addEventListener('input', up);
    $('#nu-rs').addEventListener('click', () => { rr.value = Math.min(2.5, calc().rs).toFixed(2); up(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 2.9); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     03 Heterogeneous nucleation: a cap of the same sphere
     ===================================================================== */
  function secHet() {
    const th = $('#he-th'), info = $('#he-info'), R = 1.5, Ra = CU.a * S2 / 4; let n = 0;
    const f = t => (2 - 3 * Math.cos(t) + Math.cos(t) ** 3) / 4;
    const v = GL ? new Viewer($('#v-het'), { view: [1, 0.35, 0.3], label: () => tx('Cap-shaped nucleus on a flat surface', '平面上的球冠形晶核') }) : null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root, t = +th.value * D2R, zc = -R * Math.cos(t);
      const pts = fccPts(CU.a, R * 2, (x, y, z) => z > 0 && x * x + y * y + (z - zc) ** 2 <= R * R, Ra);
      cloud(g, pts, Ra, COL.corner); n = pts.length;
      shell(g, V3(0, 0, zc), R, COL.plane, 0.13);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 4.6, 0.16), mStd(T.ghost3d, { opacity: 0.55 })); slab.position.set(0, 0, -0.08); slab.renderOrder = 4; g.add(slab);
    };
    function text() {
      const d = +th.value, t = d * D2R, ft = f(t), N = 4 / 3 * Math.PI * R ** 3 * 4 / CU.a ** 3, cnt = v && !v.init ? n : Math.round(N * ft);
      $('#he-th-v').textContent = d + '°';
      info.innerHTML = tx(`<h4>${d >= 179 ? 'No wetting: a full sphere' : d <= 45 ? 'Good wetting: a flat cap' : 'A cap of the sphere'}</h4>
        <dl class="stats"><dt>Shape factor f(θ)</dt><dd>${ft.toFixed(3)}</dd><dt>Atoms in the full sphere</dt><dd>about ${Math.round(N / 10) * 10}</dd><dt>Atoms in the cap</dt><dd>${cnt} (${(cnt / N * 100).toFixed(0)}%)</dd><dt>Energy barrier</dt><dd>${(ft * 100).toFixed(1)}% of ΔG*<sub>hom</sub></dd></dl>
        <p>The purple sphere and the cap have the same radius, r* = ${R} nm here. Only the atoms above the surface have to be gathered.</p>
        <p class="note">For copper at ΔT = 236 K the homogeneous barrier is 5.7 eV. At this contact angle it falls to ${(5.7 * ft).toFixed(2)} eV, so nucleation happens at a much smaller undercooling.</p>`,
        `<h4>${d >= 179 ? '完全不潤濕：整顆球' : d <= 45 ? '潤濕良好：很扁的球冠' : '球的一部分'}</h4>
        <dl class="stats"><dt>形狀因子 f(θ)</dt><dd>${ft.toFixed(3)}</dd><dt>完整球的原子數</dt><dd>約 ${Math.round(N / 10) * 10} 個</dd><dt>球冠的原子數</dt><dd>${cnt} 個（${(cnt / N * 100).toFixed(0)}%）</dd><dt>能量障礙</dt><dd>ΔG*<sub>hom</sub> 的 ${(ft * 100).toFixed(1)}%</dd></dl>
        <p>紫色的球和球冠半徑相同，這裡 r* = ${R} nm。需要湊在一起的只有表面以上的原子。</p>
        <p class="note">銅在 ΔT = 236 K 時，均質成核的能量障礙是 5.7 eV。在這個接觸角下降到 ${(5.7 * ft).toFixed(2)} eV，所以過冷度小得多就能成核。</p>`);
    }
    th.addEventListener('input', () => { if (v && !v.init) v.rebuild(); text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0.5), 3.3); text(); });
    text(); onLang(text);
  }

  /* =====================================================================
     04-1 Random solid solution of n elements
     ===================================================================== */
  function secAlloy() {
    const v = new Viewer($('#v-alloy'), { view: [1, 0.45, 0.4], label: () => tx('FCC solid solution with atoms of several elements mixed at random', '多種元素隨機混合的 FCC 固溶體') });
    const nS = $('#al-n'), info = $('#al-info'), legend = $('#al-legend'); let seed = 3;
    const sites = sitesIn(FCC_B, 0, 3).map(s => V3(...s.p));
    const cols = () => [COL.corner, COL.body, COL.face, COL.plane, '#D46FA8', T.edge3d];
    v.rebuild = () => {
      v.clear(); const g = v.root, n = +nS.value, rnd = rng(seed), C = cols();
      const order = sites.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
      const groups = Array.from({ length: n }, () => []); order.forEach((s, i) => groups[i % n].push(sites[s]));
      groups.forEach((pts, e) => cloud(g, pts, S2 / 4 * 0.985, C[e]));
    };
    function text() {
      const n = +nS.value, S = Math.log(n), C = cols(); $('#al-n-v').textContent = n;
      const cls = n >= 5 ? tx('high entropy', '高熵') : n >= 3 ? tx('medium entropy', '中熵') : tx('low entropy', '低熵');
      legend.innerHTML = C.slice(0, n).map((c, i) => `<span><i style="background:${c}"></i>${tx('Element', '元素')} ${i + 1}${n > 1 ? `, ${(100 / n).toFixed(0)}%` : ''}</span>`).join('');
      info.innerHTML = tx(`<h4>${n === 1 ? 'A pure metal' : n + ' elements in equal amounts'}</h4>
        <div class="eq">ΔS<sub>conf</sub> = R ln ${n} = ${S.toFixed(2)} R = ${(S * 8.31).toFixed(1)} J/mol·K</div>
        <p><span class="pill ${n >= 5 ? 'ok' : 'bad'}">${cls}</span> ${n === 1 ? 'Every site holds the same atom. There is only one way to arrange them, so the entropy is zero.' : n >= 5 ? 'Every site could hold any of the elements. The number of arrangements is enormous, and that is what holds the solid solution together.' : 'Low: below 1R. Medium: 1R to 1.5R. High: 1.5R and above, which takes 5 or more elements.'}</p>
        <p class="note">All the atoms are drawn the same size. In a real alloy they differ, which is the lattice distortion effect.</p>`,
        `<h4>${n === 1 ? '純金屬' : n + ' 種元素等量混合'}</h4>
        <div class="eq">ΔS<sub>conf</sub> = R ln ${n} = ${S.toFixed(2)} R = ${(S * 8.31).toFixed(1)} J/mol·K</div>
        <p><span class="pill ${n >= 5 ? 'ok' : 'bad'}">${cls}</span>　${n === 1 ? '每個位置都是同一種原子，排法只有一種，所以熵是零。' : n >= 5 ? '每個位置都可能是任何一種元素，排法多到數不清，固溶體就是靠這個穩定下來。' : '低熵：小於 1R。中熵：1R 到 1.5R。高熵：1.5R 以上，要 5 種以上元素才到得了。'}</p>
        <p class="note">這裡所有原子畫成一樣大。真實合金裡大小不同，這就是晶格扭曲效應。</p>`);
    }
    nS.addEventListener('input', () => { v.rebuild(); text(); });
    $('#al-mix').addEventListener('click', () => { seed += 7; v.rebuild(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(1.5, 1.5, 1.5), 3.1); }); text(); onLang(text);
  }

  /* =====================================================================
     04-2 Interstitial sites
     ===================================================================== */
  function secVoid() {
    const v = new Viewer($('#v-void'), { view: [1, 0.5, 0.42], label: () => tx('Unit cell with an interstitial site and the atoms around it', '晶胞、間隙位置和圍住它的原子') });
    const st = { s: 'FCC', t: 'o', hard: false, all: false }, info = $('#vo-info');
    const perm = (f, rest) => { const out = []; for (let ax = 0; ax < 3; ax++) rest.forEach(r => { const p = r.slice(); p.splice(ax, 0, f); out.push(p); }); return out; };
    const edgeMid = perm(0.5, [[0, 0], [0, 1], [1, 0], [1, 1]]), faceCen = [...perm(0, [[.5, .5]]), ...perm(1, [[.5, .5]])];
    const bccT = [0, 1].flatMap(f => perm(f, [[.5, .25], [.5, .75], [.25, .5], [.75, .5]]));
    const SITE = {
      FCC: { o: { p: [.5, .5, .5], k: 6, all: [[.5, .5, .5], ...edgeMid], per: 4, how: '1 + 12 × ¼' }, t: { p: [.75, .75, .75], k: 4, all: [.25, .75].flatMap(x => [.25, .75].flatMap(y => [.25, .75].map(z => [x, y, z]))), per: 8, how: '8 × 1' } },
      BCC: { o: { p: [.5, .5, 1], k: 6, all: [...faceCen, ...edgeMid], per: 6, how: '6 × ½ + 12 × ¼' }, t: { p: [.5, .25, 1], k: 4, all: bccT, per: 12, how: '24 × ½' } }
    };
    const K = a => a.map(x => x.toFixed(3)).join(), inCell = a => a.every(x => x > -EPS && x < 1 + EPS);
    // Every object on stage has a key. A rebuild lists what should be there, and the stage eases from what it shows now to that list.
    const live = new Map(), fixed = new THREE.Group(), DUR = 550, ease = x => x < 0.5 ? 4 * x ** 3 : 1 - (2 - 2 * x) ** 3 / 2;
    v.root.add(fixed);
    let res = {}, t0 = 0, cam = null;
    const setOp = (m, op) => { const tr = op < 0.999; if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; } m.opacity = op; m.depthWrite = !tr; };
    function make(s) {
      if (s.kind === 'atom') return atom(v.root, s.p, s.r, s.col, { opacity: 0 });
      if (s.kind === 'rod') return rod(v.root, s.a, s.b, 0.012, mStd(COL.plane, { opacity: 0 }));
      if (s.kind === 'cell') { const g = new THREE.Group(); cellEdges(g, s.o, V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.005, mStd(s.col, { opacity: 0 })); v.root.add(g); return g; }
      const g = new THREE.Group(), tri = [], seg = [], seen = new Set();
      s.faces.forEach(f => {
        tri.push(...f[0].toArray(), ...f[1].toArray(), ...f[2].toArray());
        [[0, 1], [1, 2], [2, 0]].forEach(([i, j]) => { const id = [K(f[i].toArray()), K(f[j].toArray())].sort().join('|'); if (!seen.has(id)) { seen.add(id); seg.push(f[i], f[j]); } });
      });
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
      const face = new THREE.Mesh(geo, mBasic(COL.plane, { opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: COL.plane, transparent: true, opacity: 0 }));
      face.renderOrder = line.renderOrder = 3; g.add(face, line); g.userData = { face, line }; v.root.add(g); return g;
    }
    function apply(it) {
      const c = it.cur, o = it.obj;
      if (it.kind === 'poly') { setOp(o.userData.face.material, c.fo); o.userData.face.material.depthWrite = false; setOp(o.userData.line.material, c.lo); o.visible = c.lo > 0.002; return; }
      if (it.kind === 'cell') { const m = o.children[0].material; setOp(m, c.op); m.color.copy(c.col); o.visible = c.op > 0.002; return; }
      setOp(o.material, c.op); o.visible = c.op > 0.002;
      if (it.kind === 'atom') { o.position.copy(c.p); o.scale.setScalar(Math.max(c.r, 1e-4)); o.material.color.copy(c.col); }
    }
    const snap = c => ({ ...c, p: c.p && c.p.clone(), col: c.col && c.col.clone() });
    function show(list) {
      const keep = new Set();
      list.forEach(s => {
        keep.add(s.k); let it = live.get(s.k);
        const to = { op: s.op, r: s.r, fo: s.fo, lo: s.lo, p: s.p, col: s.col && new THREE.Color(s.col) };
        if (!it) {
          it = { kind: s.kind, obj: make(s) };
          it.cur = { ...snap(to), op: 0, fo: 0, lo: 0, r: s.r && s.r * 0.4 };
          live.set(s.k, it);
        }
        if (s.order) it.obj.renderOrder = s.order;
        it.to = to; it.dying = false;
      });
      live.forEach((it, k) => { if (!keep.has(k)) { it.dying = true; it.to = { ...snap(it.cur), op: 0, fo: 0, lo: 0, r: it.cur.r && it.cur.r * 0.4 }; } });
      live.forEach(it => { it.from = snap(it.cur); });
      t0 = performance.now(); v.anim = step;
    }
    function step(t) {
      const e = ease(Math.min(1, Math.max(0, (t - t0) / DUR)));
      live.forEach((it, k) => {
        const a = it.from, b = it.to, c = it.cur;
        for (const q of ['op', 'r', 'fo', 'lo']) if (b[q] !== undefined) c[q] = a[q] + (b[q] - a[q]) * e;
        if (b.p) c.p.lerpVectors(a.p, b.p, e);
        if (b.col) c.col.lerpColors(a.col, b.col, e);
        apply(it);
        if (e === 1 && it.dying) {
          const mats = new Set(); it.obj.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if (o.material) mats.add(o.material); });
          mats.forEach(m => m.dispose());
          v.root.remove(it.obj); live.delete(k);
        }
      });
      if (cam) { v.frame(cam.c0.clone().lerp(cam.c1, e), cam.r0 + (cam.r1 - cam.r0) * e); if (e === 1) cam = null; }
      v.dirty = true; if (e === 1) v.anim = null;
    }
    v.rebuild = () => {
      const S = SITE[st.s][st.t], R = st.s === 'FCC' ? S2 / 4 : S3 / 4, c = V3(...S.p), hard = st.hard;
      const pool = sitesIn(BASIS[st.s], -1, 2).map(a => ({ a: a.p, p: V3(...a.p) }));
      const near = q => pool.map(a => ({ ...a, d: a.p.distanceTo(q) })).sort((x, y) => x.d - y.d).slice(0, S.k);
      const nb = near(c), rv = nb[0].d - R;
      res = { rv, R, k: S.k, per: S.per, how: S.how, far: nb[S.k - 1].d - nb[0].d > 1e-6 };
      const others = st.all ? S.all.map(q => V3(...q)).filter(q => q.distanceTo(c) > 1e-6) : [];
      // With every site shown, the 6 cells that share a face with this one are drawn too, when some sites sit on the cell's surface
      const offs = others.some(q => onBound(q.toArray())) ? [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]] : [];
      const inBox = (a, o) => a.every((x, i) => x > o[i] - EPS && x < o[i] + 1 + EPS);
      // Atoms to draw: 0 = neighbors of the marked site, 1 = neighbors of other sites outside the drawn cells, 2 = the rest of this cell, 3 = the cells next door
      const role = new Map(), pt = new Map();
      pool.forEach(a => {
        if (inCell(a.a)) { role.set(K(a.a), 2); pt.set(K(a.a), a); }
        else if (offs.some(o => inBox(a.a, o))) { role.set(K(a.a), 3); pt.set(K(a.a), a); }
      });
      others.forEach(q => near(q).forEach(a => { const k = K(a.a); if (!role.has(k)) { role.set(k, 1); pt.set(k, a); } }));
      nb.forEach(a => { role.set(K(a.a), 0); pt.set(K(a.a), a); });
      const list = [];
      role.forEach((ro, k) => {
        const a = pt.get(k), inside = inCell(a.a);
        list.push({ k: 'a' + k, kind: 'atom', p: a.p, col: inside ? kindColor(a.a) : T.ghost3d, order: ro ? 4 : 5,
          r: hard ? R : inside || !ro ? 0.1 : 0.07, op: hard ? [0.5, 0.1, 0.12, 0.06][ro] : inside || !ro ? 1 : 0.8 });
      });
      list.push({ k: 'site', kind: 'atom', p: c, col: T.hi, r: hard ? rv : 0.055, op: 1 });
      others.forEach(q => list.push({ k: 's' + K(q.toArray()), kind: 'atom', p: q, col: T.hi, r: hard ? rv : 0.04, op: hard ? 0.9 : 0.8, order: 2 }));
      offs.forEach(o => list.push({ k: 'c' + K(o), kind: 'cell', o: V3(...o), col: T.edge3d, op: 0.45, order: 3 }));
      list.push({ k: 'P' + st.s + st.t, kind: 'poly', faces: hullFaces(nb.map(a => a.p)), fo: 0.2, lo: 1 });
      if (!hard) nb.forEach(a => list.push({ k: 'r' + st.s + K(S.p) + K(a.a), kind: 'rod', a: c, b: a.p, op: 1 }));
      fixed.children.forEach(o => o.material.dispose()); fixed.clear();
      cellEdges(fixed, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.008, mStd(T.edge3d));
      const c1 = st.all ? V3(0.5, 0.5, 0.5) : V3(0.5, 0.5, 0.6), r1 = offs.length ? 2.1 : st.all ? 1.5 : 1.35;
      if (v.radius && (Math.abs(v.radius - r1) > 1e-6 || !v.center.equals(c1))) cam = { c0: v.center.clone(), r0: v.radius, c1, r1 };
      show(list);
    };
    const SHARE = () => ({
      FCCo: tx('The one at the body center belongs to this cell alone. Each of the 12 on the edges is shared by 4 cells, and 2 of its 6 neighbors are face-center atoms of the cells next door (gray).', '體心那個完全屬於這個晶胞。稜邊上的 12 個各由 4 個晶胞共用，它的 6 個鄰居裡有 2 個是隔壁晶胞的面心原子（灰色）。'),
      FCCt: tx('All 8 sit inside the cell, one in the middle of each small cube of side a/2, so none are shared.', '8 個全在晶胞裡面，每個邊長 a/2 的小立方體中心各一個，所以沒有共用。'),
      BCCo: tx('Sites on the 6 faces are shared by 2 cells and those on the 12 edges by 4. Their neighbors include the body-center atoms of the cells next door. An edge site also touches the body centers of the cells diagonally across; those cells are not drawn, only their body-center atoms.', '6 個面心上的由 2 個晶胞共用，12 個稜邊中點上的由 4 個共用。它們的鄰居包括隔壁晶胞的體心原子。稜邊上的間隙還會碰到斜對角晶胞的體心，這些晶胞沒有畫出來，只畫了它們的體心原子。'),
      BCCt: tx('All 24 sit on the faces, 4 per face, and each is shared by 2 cells. Each one is held by 2 corners of this cell and the body centers on either side of the face.', '24 個全在面上，每面 4 個，各由 2 個晶胞共用。圍住每一個的是這個晶胞的 2 個角，加上這個面兩側晶胞的體心。')
    });
    function text() {
      const q = res.rv / res.R, name = st.t === 'o' ? tx('Octahedral', '八面體') : tx('Tetrahedral', '四面體');
      const fe = st.s === 'FCC' ? { n: tx('γ-iron (FCC, R = 0.129 nm)', 'γ 鐵（FCC，R = 0.129 nm）'), R: 0.129 } : { n: tx('α-iron (BCC, R = 0.124 nm)', 'α 鐵（BCC，R = 0.124 nm）'), R: 0.124 };
      const share = st.all ? `<p class="note">${SHARE()[st.s + st.t]}</p>` : '';
      const hard = st.hard ? `<p class="note">${tx('Every atom is drawn at true size. The site\'s neighbors are half see-through and the other atoms nearly clear, so the site stays in view.', '所有原子都是真實大小。圍住間隙的鄰居畫成半透明，其他原子幾乎全透明，才看得到中間的間隙。')}</p>` : '';
      info.innerHTML = tx(`<h4>${name} site in ${st.s}</h4>
        <dl class="stats"><dt>Neighbors</dt><dd>${res.k}${res.far ? ' (2 near, 4 further)' : ''}</dd><dt>Sites per unit cell</dt><dd>${res.per} = ${res.how}</dd><dt>Largest atom that fits</dt><dd>r = ${q.toFixed(3)} R</dd><dt>In ${fe.n}</dt><dd>r = ${(q * fe.R).toFixed(3)} nm</dd></dl>
        <p>${st.s === 'FCC' ? 'In FCC the octahedral site is the larger one. A carbon atom (r ≈ 0.075 nm) is still bigger than the hole, so it pushes the iron atoms apart, but not by much.' : 'In BCC the tetrahedral site is the larger one, and both are smaller than the octahedral site of FCC, even though BCC is less densely packed. Its empty space is split into more, smaller holes.'}</p>
        ${share}${hard}<p class="note">${st.s === 'BCC' && st.t === 'o' ? 'The BCC octahedron is squashed: 2 neighbors are at a/2 and 4 are at a/√2. ' : ''}This is why FCC iron dissolves up to about 2% carbon by weight and BCC iron only about 0.02%.</p>`,
        `<h4>${st.s} 的${name}間隙</h4>
        <dl class="stats"><dt>鄰居數</dt><dd>${res.k}${res.far ? '（2 個近、4 個遠）' : ''}</dd><dt>每個晶胞有幾個</dt><dd>${res.per} = ${res.how}</dd><dt>放得進去的最大原子</dt><dd>r = ${q.toFixed(3)} R</dd><dt>在${fe.n}裡</dt><dd>r = ${(q * fe.R).toFixed(3)} nm</dd></dl>
        <p>${st.s === 'FCC' ? 'FCC 裡比較大的是八面體間隙。碳原子（r ≈ 0.075 nm）還是比這個洞大，會把鐵原子撐開，不過撐得不多。' : 'BCC 裡比較大的是四面體間隙，而且兩種都比 FCC 的八面體間隙小。BCC 明明排得比較鬆，但空的地方被分成更多、更小的洞。'}</p>
        ${share}${hard}<p class="note">${st.s === 'BCC' && st.t === 'o' ? 'BCC 的八面體是壓扁的：2 個鄰居在 a/2，4 個在 a/√2。' : ''}FCC 的鐵最多能溶進大約 2 wt% 的碳，BCC 的鐵只有大約 0.02 wt%，原因就在這裡。</p>`);
    }
    const up = () => { v.rebuild(); text(); };
    seg($('#vo-s'), x => { st.s = x; up(); }); seg($('#vo-t'), x => { st.t = x; up(); });
    $('#vo-hard').addEventListener('change', e => { st.hard = e.target.checked; up(); });
    $('#vo-all').addEventListener('change', e => { st.all = e.target.checked; up(); });
    v.rebuild(); v.frame(V3(0.5, 0.5, 0.6), 1.35); text(); onLang(text);
  }

  /* =====================================================================
     05 Point defects (two-layer slabs of hard spheres)
     ===================================================================== */
  function secPoint() {
    const v = new Viewer($('#v-pt'), { view: [0.25, -0.75, 1], label: () => tx('Two layers of atoms with one point defect', '兩層原子，其中有一個點缺陷') });
    const st = { s: 'vac' }, info = $('#pt-info'), legend = $('#pt-legend');
    v.rebuild = () => {
      v.clear(); const g = v.root, s = st.s, host = [], H = Math.SQRT1_2;
      if (s === 'sch' || s === 'fre') {
        const cat = [], an = [], gone = [[0, 0, 0]]; if (s === 'sch') gone.push([1, 0, 0]);
        for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (let k = 0; k >= -1; k--) {
          if (gone.some(q => q[0] === i && q[1] === j && q[2] === k)) continue;
          ((i + j + k) % 2 === 0 ? cat : an).push(V3(i, j, k));
        }
        cloud(g, an, 0.46, COL.corner); cloud(g, cat, 0.26, COL.body);
        atom(g, V3(0, 0, 0), 0.26, T.hi, { opacity: 0.25, order: 6 });
        if (s === 'sch') atom(g, V3(1, 0, 0), 0.46, T.hi, { opacity: 0.25, order: 6 });
        else { atom(g, V3(0.5, 0.5, -0.5), 0.26, T.hi); dashed(g, [[V3(0, 0, 0), V3(0.5, 0.5, -0.5)]], T.hi, { dash: 0.05, gap: 0.04 }); }
        return;
      }
      const D = { vac: { c: V3(0, 0, 0), amp: -0.05, r0: 1 }, self: { c: V3(0.5, 0.5, 0), amp: 0.18, r0: H }, sub: { c: V3(0, 0, 0), amp: 0.06, r0: 1 }, int: { c: V3(0.5, 0.5, 0), amp: 0.015, r0: H } }[s];
      const move = p => { const d = p.clone().sub(D.c), r = d.length(); return r < 1e-6 ? p : p.add(d.multiplyScalar(D.amp * (D.r0 / r) ** 2 / r)); };
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) { if ((s === 'vac' || s === 'sub') && !i && !j) continue; host.push(move(V3(i, j, 0))); }
      for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) host.push(move(V3(i + 0.5, j + 0.5, -H)));
      cloud(g, host, 0.5, COL.corner);
      if (s === 'vac') atom(g, D.c, 0.5, T.hi, { opacity: 0.2, order: 6 });
      if (s === 'self') atom(g, V3(0.5, 0.5, 0.4), 0.5, T.hi);
      if (s === 'sub') atom(g, D.c, 0.56, COL.body);
      if (s === 'int') atom(g, D.c, 0.22, COL.body);
    };
    function text() {
      const ionic = st.s === 'sch' || st.s === 'fre';
      legend.innerHTML = ionic
        ? tx(`<span><i style="background:${COL.corner}"></i>Anion (large)</span><span><i style="background:${COL.body}"></i>Cation (small)</span><span><i style="background:${T.hi};opacity:.4"></i>Empty site</span><span>Ions are drawn at 72% of true size so the gaps can be seen.</span>`, `<span><i style="background:${COL.corner}"></i>陰離子（大）</span><span><i style="background:${COL.body}"></i>陽離子（小）</span><span><i style="background:${T.hi};opacity:.4"></i>空出來的位置</span><span>離子縮成真實大小的 72%，才看得到空隙。</span>`)
        : tx(`<span><i style="background:${COL.corner}"></i>Host atoms, true-size hard spheres</span><span><i style="background:${COL.body}"></i>Impurity atom</span><span><i style="background:${T.hi}"></i>The defect</span>`, `<span><i style="background:${COL.corner}"></i>基底原子，真實大小的硬球</span><span><i style="background:${COL.body}"></i>雜質原子</span><span><i style="background:${T.hi}"></i>缺陷</span>`);
      info.innerHTML = {
        vac: tx('<h4>Vacancy</h4><p>One atom is missing from the top layer. The pale red sphere marks the empty site. The neighbors relax slightly inward.</p><p class="note">A vacancy lets a neighboring atom hop into it. This is how atoms diffuse through a solid.</p>', '<h4>空位</h4><p>上層少了一個原子，淡紅色的球標出空出來的位置。周圍的鄰居稍微往內靠。</p><p class="note">有了空位，旁邊的原子可以跳進來。固體裡的原子就是這樣擴散的。</p>'),
        self: tx('<h4>Self-interstitial</h4><p>An extra atom of the same kind (red) is forced into the hollow between four atoms. The hollow only has room for a sphere 0.41 times as large, so the neighbors are pushed far out of place.</p><p class="note">The distortion costs several eV, far more than a vacancy, so self-interstitials are rare unless the crystal is irradiated.</p>', '<h4>自間隙原子</h4><p>一個同種的原子（紅色）硬擠進四個原子之間的凹處。這個凹處只放得下 0.41 倍大的球，所以鄰居被推開很多。</p><p class="note">這樣的變形要花好幾 eV，比空位高得多，所以除非晶體受過輻射，自間隙原子很少見。</p>'),
        sub: tx('<h4>Substitutional impurity</h4><p>A larger foreign atom (orange) sits on a lattice site and pushes its neighbors outward. A smaller one would pull them in.</p><p class="note">Either way the lattice is strained around it. That strain gets in the way of dislocations, which is how alloying strengthens a metal.</p>', '<h4>置換型雜質</h4><p>一個比較大的外來原子（橘色）佔了晶格位置，把鄰居往外推。如果它比較小，鄰居會往內靠。</p><p class="note">不管哪一種，周圍的晶格都有應變。這個應變會妨礙差排移動，合金化就是這樣讓金屬變強。</p>'),
        int: tx('<h4>Interstitial impurity</h4><p>A small foreign atom (orange) sits in the hollow between host atoms without taking a lattice site. Carbon in iron is the classic case.</p><p class="note">Only atoms much smaller than the host, such as H, C, N and O, can dissolve this way.</p>', '<h4>間隙型雜質</h4><p>一個小的外來原子（橘色）待在基底原子之間的凹處，不佔晶格位置。鐵裡面的碳是最典型的例子。</p><p class="note">只有比基底小很多的原子，例如 H、C、N、O，才能這樣溶進去。</p>'),
        sch: tx('<h4>Schottky defect</h4><p>One cation and one anion are missing. Taking out only one of them would leave the crystal charged, so vacancies in an ionic crystal come in pairs of opposite charge.</p>', '<h4>蕭特基缺陷</h4><p>少了一個陽離子和一個陰離子。只拿走其中一個，晶體會帶電，所以離子晶體的空位是正負成對出現的。</p>'),
        fre: tx('<h4>Frenkel defect</h4><p>A cation has left its site (pale red) and now sits in the gap between the two layers (solid red). Nothing was added or removed, so the crystal stays neutral.</p><p class="note">It is nearly always the cation that moves, because it is the smaller ion and fits into the gap.</p>', '<h4>法蘭克缺陷</h4><p>一個陽離子離開原位（淡紅色），跑到兩層之間的空隙裡（實心紅色）。沒有多也沒有少，晶體仍然是電中性。</p><p class="note">移動的幾乎都是陽離子，因為它比較小，才擠得進空隙。</p>')
      }[st.s];
    }
    const pick = (a, b) => x => { st.s = x; setSeg($(b), ''); v.rebuild(); text(); };
    seg($('#pt-s'), pick('#pt-s', '#pt-i')); seg($('#pt-i'), pick('#pt-i', '#pt-s'));
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, -0.3), 4.6); }); text(); onLang(text);
  }
  function secVac() {
    const T_ = $('#pv-T'), E_ = $('#pv-E'), out = $('#pv-out');
    const up = () => {
      const Tk = +T_.value, E = +E_.value, f = Math.exp(-E / (8.617e-5 * Tk));
      $('#pv-T-v').textContent = `${Tk} K (${Tk - 273} °C)`; $('#pv-E-v').textContent = E.toFixed(2) + ' eV';
      out.innerHTML = tx(`<div class="eq">n<sub>v</sub> / N = exp(−${E.toFixed(2)} / (8.62 × 10⁻⁵ × ${Tk})) = <b>${sci(f)}</b>&emsp;(taking C = 1)</div>
        <dl class="stats"><dt>One vacancy for every</dt><dd>${sci(1 / f)} atom sites</dd><dt>In 1 cm³ of copper (8.49 × 10²² atoms)</dt><dd>${sci(f * 8.49e22)} vacancies</dd></dl>
        <p class="note">With E<sub>v</sub> = 1 eV the fraction is 1.6 × 10⁻¹⁷ at 300 K and 9 × 10⁻⁶ at 1000 K, the two values on the slide. Heating by 700 K raises it about 10¹¹ times.</p>`,
        `<div class="eq">n<sub>v</sub> / N = exp(−${E.toFixed(2)} / (8.62 × 10⁻⁵ × ${Tk})) = <b>${sci(f)}</b>&emsp;（取 C = 1）</div>
        <dl class="stats"><dt>每多少個原子位置有一個空位</dt><dd>${sci(1 / f)}</dd><dt>1 cm³ 的銅（8.49 × 10²² 個原子）</dt><dd>${sci(f * 8.49e22)} 個空位</dd></dl>
        <p class="note">E<sub>v</sub> = 1 eV 時，300 K 是 1.6 × 10⁻¹⁷，1000 K 是 9 × 10⁻⁶，就是投影片上的兩個數字。升溫 700 K，空位比例增加大約 10¹¹ 倍。</p>`);
    };
    T_.addEventListener('input', up); E_.addEventListener('input', up); up(); onLang(up);
  }

  /* =====================================================================
     06 Dislocations
     ===================================================================== */
  function secDis() {
    const v = new Viewer($('#v-dis'), { view: [0.42, -1, 0.42], label: () => tx('Crystal block with a dislocation that can be moved', '可以移動差排的晶體') });
    const st = { s: 'edge', x: 0.5, loop: true }, N = { nx: 11, ny: 8, nz: 4 }, info = $('#di-info'), sl = $('#di-x');
    const B = { edge: [1, 0], screw: [0, 1], mixed: [1, 1] }, cx = (N.nx - 1) / 2, xl = -cx - 0.6, xr = cx + 0.6;
    v.rebuild = () => {
      v.clear(); const g = v.root, [be, bs] = B[st.s], y0 = -0.75, y1 = N.nz - 0.25;
      const W = disBlock(g, { ...N, x0: st.x, be, bs });
      poly(g, [V3(xl, y0, 0), V3(xr, y0, 0), V3(xr, y1, 0), V3(xl, y1, 0)], COL.plane, 0.14, true);
      const xs = Math.min(xr, Math.max(xl, st.x));
      if (xs > xl + 0.01) poly(g, [V3(xl, y0, 0), V3(xs, y0, 0), V3(xs, y1, 0), V3(xl, y1, 0)], COL.plane, 0.3, false);
      const inside = st.x > xl && st.x < xr;
      if (inside) rod(g, V3(st.x, y0 - 0.7, 0), V3(st.x, y1 + 0.7, 0), 0.07, mStd(T.hi));
      if (!st.loop) return;
      // Burgers circuit: atom-to-atom steps around the middle of the block
      const iL = cx - 2, iR = cx + 2, jT = N.ny / 2 + 1, jB = N.ny / 2 - 2, pts = [];
      let i = iR, j = jT, k = 0;
      const P = () => W(i, j, k).add(V3(0, -0.62, 0));
      const step = (di, dj) => {
        // crossing the part of the slip plane that has already slipped shifts the walk by b
        if (dj && (j + dj >= N.ny / 2) !== (j >= N.ny / 2) && i - cx < st.x) { i -= dj * be; k -= dj * bs; }
        i += di; j += dj; pts.push(P());
      };
      pts.push(P());
      for (let n = 0; n < iR - iL; n++) step(-1, 0);
      for (let n = 0; n < jT - jB; n++) step(0, -1);
      for (let n = 0; n < iR - iL; n++) step(1, 0);
      for (let n = 0; n < jT - jB; n++) step(0, 1);
      const mat = mBasic(T.accent, { depthTest: false });
      path(g, pts, 0.045, mat, 20);
      const a0 = atom(g, pts[0], 0.11, T.accent, { depthTest: false, order: 21 }); a0.material.depthTest = false;
      const end = pts[pts.length - 1];
      if (end.distanceTo(pts[0]) > 0.2) {
        arrow(g, end, pts[0], 0.06, T.hi, { basic: true, depthTest: false, order: 22 });
        label(g, 'b', end.clone().lerp(pts[0], 0.5).add(V3(0, -0.1, 0.42)), { color: T.hi, size: 0.5 });
      }
    };
    function text() {
      const s = st.s, inside = st.x > xl && st.x < xr, loopIn = st.x > -2 && st.x < 2;
      const kind = {
        edge: tx('<h4>Edge dislocation</h4><p>The orange column is the extra half-plane. It stops at the slip plane, and the red line along its lower edge is the dislocation. <b>b</b> points across the line, at 90° to it.</p>', '<h4>刃差排</h4><p>橘色那一排是多出來的半片原子面，到滑移面就結束了。沿著它底邊的紅線就是差排。<b>b</b> 橫過差排線，和它夾 90°。</p>'),
        screw: tx('<h4>Screw dislocation</h4><p>There is no extra half-plane. Atoms on the left of the line are shifted along the line, forward above the slip plane and backward below it. Turn the model: one trip around the red line moves you one layer deeper, like a spiral ramp. <b>b</b> points along the line.</p>', '<h4>螺旋差排</h4><p>沒有多出來的原子面。差排線左邊的原子沿著線的方向錯開：滑移面上方往前、下方往後。轉動模型看看：繞紅線一圈，就往裡面深一層，像螺旋坡道。<b>b</b> 順著差排線。</p>'),
        mixed: tx('<h4>Mixed dislocation</h4><p>The slip has both parts at once: an extra half-plane (edge part) and a shift along the line (screw part). <b>b</b> lies at 45° to the line here.</p>', '<h4>混合差排</h4><p>兩種成分同時存在：多出半片原子面（刃的成分），又沿著線的方向錯開（螺旋的成分）。這裡的 <b>b</b> 和差排線夾 45°。</p>')
      }[s];
      const where = !inside ? (st.x <= xl ? tx('<span class="pill ok">Not slipped yet</span> The dislocation has not entered. The crystal is perfect.', '<span class="pill ok">還沒滑移</span>　差排還沒進來，晶體是完美的。') : tx('<span class="pill ok">Slip complete</span> The dislocation has left on the right. The top half has moved by exactly b relative to the bottom half, and a step is left on each side.', '<span class="pill ok">滑移完成</span>　差排從右邊離開了。上半部相對下半部剛好移動了 b，兩側各留下一個台階。'))
        : tx('The crystal to the left of the line has slipped by b. The crystal to the right has not.', '差排線左邊的晶體已經滑了 b，右邊還沒有。');
      const loop = !st.loop ? '' : loopIn && inside ? tx('<p class="note">The circuit takes 4 steps left, 3 down, 4 right and 3 up. Around the dislocation it fails to close, and the red arrow <b>b</b> is the missing step.</p>', '<p class="note">迴路往左 4 步、往下 3 步、往右 4 步、往上 3 步。繞著差排走就合不起來，紅色箭頭 <b>b</b> 就是缺的那一步。</p>') : tx('<p class="note">The circuit does not go around the dislocation now, so it closes. Slide the line back inside the loop to see the gap.</p>', '<p class="note">現在迴路沒有把差排圍在裡面，所以合得起來。把差排線拉回迴路裡面，就會看到缺口。</p>');
      info.innerHTML = kind + `<p>${where}</p>` + loop;
    }
    const up = () => { v.rebuild(); text(); };
    seg($('#di-s'), x => { st.s = x; up(); });
    sl.addEventListener('input', () => { v.anim = null; st.x = +sl.value; up(); });
    $('#di-loop').addEventListener('change', e => { st.loop = e.target.checked; up(); });
    $('#di-go').addEventListener('click', () => {
      if (REDUCED) { st.x = 6.5; sl.value = st.x; up(); return; }
      let t0 = null;
      v.anim = t => { if (t0 === null) t0 = t; const u = Math.min(1, (t - t0) / 6000); st.x = -6.5 + 13 * u; sl.value = st.x; up(); if (u >= 1) v.anim = null; };
    });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 1.5, 0), 7.2); }); text(); onLang(text);
  }

  function secSchmid() {
    const v = new Viewer($('#v-sch'), { view: [0.3, -1, 0.28], label: () => tx('Cylinder of crystal under tension with a slip plane', '受拉的圓柱形晶體和其中的滑移面') });
    const phi = $('#sm-phi'), be = $('#sm-be'), sig = $('#sm-sig'), info = $('#sm-info'), st = { crss: 13.7 };
    v.rebuild = () => {
      v.clear(); const g = v.root, p = +phi.value * D2R, b = +be.value * D2R, R = 0.6, H = 2.4, O = V3(0, 0, 0);
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 2 * H, 48, 1, true), mStd(T.ghost3d, { opacity: 0.22 })); cyl.rotation.x = Math.PI / 2; cyl.material.side = THREE.DoubleSide; g.add(cyl);
      [-H, H].forEach(z => { const pts = []; for (let i = 0; i <= 48; i++) pts.push(V3(R * Math.cos(i * Math.PI / 24), R * Math.sin(i * Math.PI / 24), z)); g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: T.edge3d }))); });
      const el = []; for (let i = 0; i < 48; i++) { const t = i * Math.PI / 24; el.push(V3(R * Math.cos(t), R * Math.sin(t), -Math.tan(p) * R * Math.cos(t))); }
      poly(g, el, COL.plane, 0.5, true);
      const n = V3(Math.sin(p), 0, Math.cos(p)), d = V3(-Math.cos(p), 0, Math.sin(p)).multiplyScalar(Math.cos(b)).add(V3(0, -Math.sin(b), 0)), z = V3(0, 0, 1);
      dashed(g, [[V3(0, 0, -H - 0.3), V3(0, 0, H + 0.3)]], T.edge3d, { dash: 0.08, gap: 0.06 });
      arrow(g, V3(0, 0, H), V3(0, 0, H + 1), 0.04, T.accent); arrow(g, V3(0, 0, -H), V3(0, 0, -H - 1), 0.04, T.accent);
      arrow(g, O, n.clone().multiplyScalar(1.7), 0.022, COL.plane); arrow(g, O, d.clone().multiplyScalar(1.7), 0.04, T.hi);
      arc(g, z, n, 0.8, COL.plane); arc(g, z, d, 1.05, T.hi);
      label(g, 'F', V3(0.22, 0, H + 0.85), { color: T.accent, size: 0.36 }); label(g, 'n', n.clone().multiplyScalar(1.92), { color: COL.plane, size: 0.36 });
      label(g, 'φ', z.clone().lerp(n, 0.5).normalize().multiplyScalar(0.98), { color: COL.plane, size: 0.36 });
      label(g, 'λ', z.clone().lerp(d, 0.5).normalize().multiplyScalar(1.25), { color: T.hi, size: 0.36 });
    };
    function text() {
      const p = +phi.value, b = +be.value, s = +sig.value, cl = Math.sin(p * D2R) * Math.cos(b * D2R), lam = Math.acos(cl) / D2R, m = Math.cos(p * D2R) * cl, tau = s * m, go = tau >= st.crss;
      $('#sm-phi-v').textContent = p + '°'; $('#sm-be-v').textContent = b + '°'; $('#sm-sig-v').textContent = s + ' MPa';
      info.innerHTML = tx(`<dl class="stats"><dt>φ (pull to plane normal)</dt><dd>${p}°</dd><dt>λ (pull to slip direction)</dt><dd>${lam.toFixed(1)}°</dd><dt>cos φ cos λ</dt><dd>${m.toFixed(3)}</dd></dl>
        <div class="eq">τ<sub>r</sub> = σ cos λ cos φ = ${s} × ${m.toFixed(3)} = <b>${tau.toFixed(1)} MPa</b></div>
        <p>${go ? `<span class="pill ok">Slips</span> τ<sub>r</sub> has reached the CRSS of ${st.crss} MPa. Dislocations on this slip system start to move.` : `<span class="pill bad">Does not slip</span> τ<sub>r</sub> is below the CRSS of ${st.crss} MPa. ${m > 0.01 ? `Slip would need σ = ${(st.crss / m).toFixed(0)} MPa.` : ''}`}</p>
        <p class="note">φ + λ = 90° only when the slip direction is the steepest line in the plane (second slider at 0°). Turn it and λ grows, so less of the pull acts along the slip direction.</p>`,
        `<dl class="stats"><dt>φ（拉力對滑移面法線）</dt><dd>${p}°</dd><dt>λ（拉力對滑移方向）</dt><dd>${lam.toFixed(1)}°</dd><dt>cos φ cos λ</dt><dd>${m.toFixed(3)}</dd></dl>
        <div class="eq">τ<sub>r</sub> = σ cos λ cos φ = ${s} × ${m.toFixed(3)} = <b>${tau.toFixed(1)} MPa</b></div>
        <p>${go ? `<span class="pill ok">會滑移</span>　τ<sub>r</sub> 達到 CRSS ${st.crss} MPa，這個滑移系統上的差排開始移動。` : `<span class="pill bad">不會滑移</span>　τ<sub>r</sub> 還低於 CRSS ${st.crss} MPa。${m > 0.01 ? `要到 σ = ${(st.crss / m).toFixed(0)} MPa 才會滑。` : ''}`}</p>
        <p class="note">只有滑移方向是面上最陡的那條線時（第二支滑桿在 0°），φ + λ 才等於 90°。把它轉開，λ 變大，拉力沿滑移方向的分量就變小。</p>`);
    }
    [phi, be].forEach(e => e.addEventListener('input', () => { v.rebuild(); text(); })); sig.addEventListener('input', text);
    seg($('#sm-crss'), x => { st.crss = +x; text(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 3.7); }); text(); onLang(text);
  }

  /* =====================================================================
     07 Planar defects
     ===================================================================== */
  function secGB() {
    const v = new Viewer($('#v-gb'), { view: [0.1, -1, 0.08], label: () => tx('Two grains meeting at a tilt boundary', '兩顆晶粒在傾斜晶界相接') });
    const th = $('#gb-th'), info = $('#gb-info'), HX = 6.6, HZ = 7.2;
    v.rebuild = () => {
      v.clear(); const g = v.root, a = +th.value * D2R / 2, c = Math.cos(a), s = Math.sin(a), per = 1 / s, n = Math.ceil((HX + HZ) * 1.5 + per);
      const A = [], Bm = [], cols = [new Map(), new Map()];
      const put = (m, i, p) => { if (!m.has(i)) m.set(i, []); m.get(i).push(p); };
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = i * c - j * s, z = i * s + j * c;
        if (x <= 0.02 && x >= -HX && Math.abs(z) <= HZ) { A.push([x, z]); put(cols[0], i, [x, z]); }
      }
      const edge = A.filter(p => p[0] > -0.85);
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = -(i * c - j * s), z = i * s + j * c + per / 2;
        if (x < -0.02 || x > HX || Math.abs(z) > HZ) continue;
        if (x < 0.85 && edge.some(p => Math.hypot(p[0] - x, p[1] - z) < 0.8)) continue;
        Bm.push([x, z]); put(cols[1], i, [x, z]);
      }
      const pts = []; [...A, ...Bm].forEach(p => { pts.push(V3(p[0], 0, p[1]), V3(p[0], 1, p[1])); });
      cloud(g, pts, 0.48, COL.corner);
      const mat = mBasic(T.accent);
      cols.forEach(m => m.forEach(list => { if (list.length < 2) return; list.sort((p, q) => p[1] - q[1]); const p = list[0], q = list[list.length - 1]; rod(g, V3(p[0], -0.56, p[1]), V3(q[0], -0.56, q[1]), 0.03, mat); }));
      poly(g, [V3(0, -0.8, -HZ - 0.5), V3(0, 1.8, -HZ - 0.5), V3(0, 1.8, HZ + 0.5), V3(0, -0.8, HZ + 0.5)], COL.plane, 0.16, true);
      for (let i = -40; i <= 40; i++) [i * per, (i + 0.5) * per].forEach(z => { if (Math.abs(z) < HZ - 0.4) label(g, '⊥', V3(0, -0.9, z - 0.3), { color: T.hi, size: 1.05, weight: 700 }); });
    };
    function text() {
      const d = +th.value, t = d * D2R, D = 1 / (2 * Math.sin(t / 2)), b = 0.2556;
      $('#gb-th-v').textContent = d.toFixed(1) + '°';
      info.innerHTML = tx(`<h4>${d <= 15 ? 'Low-angle boundary' : 'High-angle boundary'}</h4>
        <dl class="stats"><dt>Tilt angle θ</dt><dd>${d.toFixed(1)}° = ${t.toFixed(3)} rad</dd><dt>Dislocation spacing D</dt><dd>${D.toFixed(1)} atom spacings</dd><dt>In copper (b = 0.256 nm)</dt><dd>${(D * b).toFixed(2)} nm</dd></dl>
        <div class="eq">D = b / (2 sin(θ/2)) ≈ b / θ = ${b} / ${t.toFixed(3)} = ${(b / t).toFixed(2)} nm</div>
        <p>${d <= 15 ? 'Follow the dark lines upward. Every so often one more line starts at the boundary. Each start is the edge of an extra half-plane, an edge dislocation, and between them the two lattices fit well.' : 'Above about 15° the dislocations are only a few atoms apart and their cores overlap. The boundary is better described as a thin disordered layer.'}</p>`,
        `<h4>${d <= 15 ? '小角度晶界' : '大角度晶界'}</h4>
        <dl class="stats"><dt>傾斜角 θ</dt><dd>${d.toFixed(1)}° = ${t.toFixed(3)} rad</dd><dt>差排間距 D</dt><dd>${D.toFixed(1)} 個原子間距</dd><dt>換成銅（b = 0.256 nm）</dt><dd>${(D * b).toFixed(2)} nm</dd></dl>
        <div class="eq">D = b / (2 sin(θ/2)) ≈ b / θ = ${b} / ${t.toFixed(3)} = ${(b / t).toFixed(2)} nm</div>
        <p>${d <= 15 ? '順著深色的線往上看。每隔一段距離，晶界上就多冒出一條線。每個起點都是半片原子面的邊，也就是一個刃差排；差排和差排之間，兩邊的晶格接得很好。' : '超過大約 15° 之後，差排之間只隔幾個原子，核心互相重疊。這時把晶界看成一層很薄的混亂區比較貼切。'}</p>`);
    }
    th.addEventListener('input', () => { v.rebuild(); text(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0.5, 0), 9.3); }); text(); onLang(text);
  }

  function secSF() {
    const v = new Viewer($('#v-sf'), { view: [1, -0.16, 0.08], label: () => tx('Close-packed layers seen from the side', '從側面看的最密排原子層') });
    const st = { s: 'tw' }, info = $('#sf-info'), h = Math.sqrt(2 / 3);
    // [stacking from bottom to top, layers marked red, heights of the fault planes in layers]
    const SEQ = { ok: ['ABCABCABCABCA', [], []], in: ['ABCABABCABCAB', [], [4.5]], ex: ['ABCABCACBCABC', [7], [7]], tw: ['ABCABCACBACAB', [6, 10], [6, 10]] };
    const OFF = { A: [0, 0], B: [0.5, S3 / 6], C: [0, S3 / 3] }, LC = { A: COL.corner, B: COL.body, C: COL.face };
    v.rebuild = () => {
      v.clear(); const g = v.root, [seq, red, planes] = SEQ[st.s], by = { A: [], B: [], C: [] };
      [...seq].forEach((L, n) => {
        for (let i = 0; i < 4; i++) for (let j = 0; j < 6; j++) by[L].push(V3(i + (j % 2) / 2 + OFF[L][0], j * S3 / 2 + OFF[L][1], n * h));
        label(g, L, V3(1.75, -1.25, n * h), { color: red.includes(n) ? T.hi : LC[L], size: 0.5 });
      });
      'ABC'.split('').forEach(L => cloud(g, by[L], 0.5, LC[L]));
      planes.forEach(n => poly(g, [V3(-0.9, -0.8, n * h), V3(4.6, -0.8, n * h), V3(4.6, 6.1, n * h), V3(-0.9, 6.1, n * h)], COL.plane, 0.3, true));
    };
    function text() {
      const [seq, red] = SEQ[st.s];
      const html = [...seq].map((L, n) => `<b style="color:${red.includes(n) ? T.hi : LC[L]}${red.includes(n) ? ';text-decoration:underline' : ''}">${L}</b>${st.s === 'in' && n === 4 ? '<span style="color:var(--hi)">|</span>' : ''}`).join('');
      info.innerHTML = `<div class="eq big" style="letter-spacing:.12em">${html}</div>` + {
        ok: tx('<h4>Perfect FCC</h4><p>Read from the bottom up. Every layer steps the same way, A → B → C → A, so the columns of atoms lean in one direction all the way up.</p>', '<h4>完美的 FCC</h4><p>從下往上讀。每一層都往同一邊跨，A → B → C → A，所以原子排成的斜線從頭到尾往同一邊傾。</p>'),
        in: tx('<h4>Stacking fault: one layer missing</h4><p>A C layer is missing at the red mark, so the order reads …AB|AB… there. Those four layers are stacked ABAB, the HCP order, inside an FCC crystal.</p><p class="note">Every atom still has 12 nearest neighbors, so the energy cost is small. This is the fault drawn on the slide.</p>', '<h4>疊差：少一層</h4><p>紅色記號的地方少了一層 C，所以那裡讀起來是 …AB|AB…。這四層的疊法是 ABAB，等於在 FCC 晶體裡夾了一小片 HCP。</p><p class="note">每個原子還是有 12 個最近鄰，所以能量代價很小。投影片上畫的就是這種疊差。</p>'),
        ex: tx('<h4>Stacking fault: one extra layer</h4><p>An extra C layer (red) is inserted between an A and a B. The order steps backward twice, once on each side of the inserted layer.</p>', '<h4>疊差：多一層</h4><p>在 A 和 B 之間多插進一層 C（紅色）。順序在這一層的上下各倒退一次。</p>'),
        tw: tx('<h4>Twin</h4><p>At each red layer the stepping direction reverses: ABC going up becomes CBA. The layers between the two red ones are a mirror image of the crystal outside, a twin. Each red layer is a twin boundary.</p><p class="note">In the model the columns of atoms lean one way, then the other, then back. The sequence is the one on the slide.</p>', '<h4>雙晶</h4><p>到每個紅色的層，跨的方向就反過來：往上的 ABC 變成 CBA。兩個紅色層之間的部分是外面晶體的鏡像，也就是雙晶。每個紅色層就是一道雙晶界。</p><p class="note">模型裡原子排成的斜線先往一邊傾，再往另一邊，然後又傾回來。這個順序就是投影片上的那一個。</p>')
      }[st.s];
    }
    seg($('#sf-s'), x => { st.s = x; v.rebuild(); text(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(1.75, 2.3, 6 * h), 6.3); }); text(); onLang(text);
  }

  /* =====================================================================
     08 Grain size: simulated micrograph (2D)
     ===================================================================== */
  function secGrain() {
    const nS = $('#gs-n'), info = $('#gs-info'), st = { mat: 'fe' }; let R = {};
    const HP = { fe: [70, 0.74], cu: [25, 0.11], ti: [80, 0.40] }; // σ0 (MPa), k (MPa·m^1/2)
    const clip = (poly, mx, my, dx, dy) => {
      const out = [], f = p => (p[0] - mx) * dx + (p[1] - my) * dy;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
        if (fa <= 0) out.push(a);
        if (fa * fb < 0) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      return out;
    };
    function paint(x, W, H) {
      const n = +nS.value, N = 2 ** (n - 1), want = N * W / H, cols = Math.max(1, Math.round(Math.sqrt(want * W / H))), rows = Math.max(1, Math.round(want / cols));
      const rnd = rng(40 + n), cw = W / cols, ch = H / rows, seeds = [];
      for (let c = -1; c <= cols; c++) for (let r = -1; r <= rows; r++) seeds.push([(c + 0.5 + (rnd() - 0.5) * 0.8) * cw, (r + 0.5 + (rnd() - 0.5) * 0.8) * ch, rnd()]);
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const reach = 3.2 * Math.max(cw, ch);
      x.lineJoin = 'round'; x.strokeStyle = T.ink; x.lineWidth = n >= 9 ? 0.8 : 1.3;
      seeds.forEach(s => {
        let P = [[-W, -H], [2 * W, -H], [2 * W, 2 * H], [-W, 2 * H]];
        for (const o of seeds) { if (o === s) continue; const dx = o[0] - s[0], dy = o[1] - s[1]; if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue; P = clip(P, (s[0] + o[0]) / 2, (s[1] + o[1]) / 2, dx, dy); if (P.length < 3) return; }
        x.beginPath(); P.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.closePath();
        x.globalAlpha = 0.08 + 0.42 * s[2]; x.fillStyle = T.ghost3d; x.fill(); x.globalAlpha = 1; x.stroke();
      });
      // test line across the middle: count the grains it passes through
      const y = H * 0.5, near = px => { let k = 0, d = 1e9; for (let i = 0; i < seeds.length; i++) { const e = (seeds[i][0] - px) ** 2 + (seeds[i][1] - y) ** 2; if (e < d) { d = e; k = i; } } return k; };
      let cnt = 1, cur = near(0); const ticks = [];
      for (let px = 1; px <= W; px++) { const k = near(px); if (k !== cur) { cur = k; cnt++; ticks.push(px); } }
      x.strokeStyle = T.hi; x.lineWidth = 2.2; x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); ticks.forEach(t => { x.moveTo(t, y - 6); x.lineTo(t, y + 6); }); x.stroke();
      // scale bar: the picture height is 1 inch at 100×, that is 254 µm of metal
      const bar = H * 100 / 254; x.fillStyle = T.stage; x.fillRect(10, H - 34, bar + 12, 26);
      x.strokeStyle = T.ink; x.lineWidth = 2; x.beginPath(); x.moveTo(16, H - 15); x.lineTo(16 + bar, H - 15); x.moveTo(16, H - 20); x.lineTo(16, H - 10); x.moveTo(16 + bar, H - 20); x.lineTo(16 + bar, H - 10); x.stroke();
      x.fillStyle = T.ink; x.font = MFONT(600, 11); x.textAlign = 'left'; x.fillText('100 µm', 20, H - 21);
      R = { n, N, cnt, L: W / H }; text();
    }
    function text() {
      if (!R.n) return;
      const { n, N, cnt, L } = R, nL = cnt / L, dIn = 1.5 / (nL * 100), d = dIn * 25400, [s0, k] = HP[st.mat], sy = s0 + k / Math.sqrt(d * 1e-6);
      $('#gs-n-v').textContent = n;
      const cls = n <= 3 ? tx('coarse-grained', '粗晶粒') : n <= 6 ? tx('medium-grained', '中等晶粒') : n <= 9 ? tx('fine-grained', '細晶粒') : tx('ultrafine-grained', '超細晶粒');
      info.innerHTML = tx(`<h4>n = ${n}: ${cls}</h4>
        <dl class="stats"><dt>Grains per in² at 100×</dt><dd>N = 2<sup>${n - 1}</sup> = ${N}</dd><dt>Test line</dt><dd>${L.toFixed(2)} in, crosses ${cnt} grains</dd><dt>n<sub>L</sub></dt><dd>${nL.toFixed(1)} grains per inch</dd></dl>
        <div class="eq">d = C / (n<sub>L</sub> M) = 1.5 / (${nL.toFixed(1)} × 100) = ${dIn.toFixed(4)} in = <b>${d.toFixed(0)} µm</b><br>σ<sub>y</sub> = ${s0} + ${k} / √(${sci(d * 1e-6)} m) = <b>${sy.toFixed(0)} MPa</b></div>
        <p class="note">Each step up in n doubles the number of grains. The Hall–Petch constants are typical textbook values (σ<sub>0</sub> in MPa, k in MPa·m<sup>1/2</sup>), so read the strength as an estimate.</p>`,
        `<h4>n = ${n}：${cls}</h4>
        <dl class="stats"><dt>100 倍下每平方英吋的晶粒數</dt><dd>N = 2<sup>${n - 1}</sup> = ${N}</dd><dt>測試線</dt><dd>長 ${L.toFixed(2)} 英吋，穿過 ${cnt} 顆晶粒</dd><dt>n<sub>L</sub></dt><dd>每英吋 ${nL.toFixed(1)} 顆</dd></dl>
        <div class="eq">d = C / (n<sub>L</sub> M) = 1.5 / (${nL.toFixed(1)} × 100) = ${dIn.toFixed(4)} in = <b>${d.toFixed(0)} µm</b><br>σ<sub>y</sub> = ${s0} + ${k} / √(${sci(d * 1e-6)} m) = <b>${sy.toFixed(0)} MPa</b></div>
        <p class="note">n 每加 1，晶粒數就加倍。霍爾–貝曲常數用的是課本上的典型值（σ<sub>0</sub> 單位 MPa，k 單位 MPa·m<sup>1/2</sup>），算出來的強度當作估計值看。</p>`);
    }
    const draw = canvas2d($('#gs-cv'), paint);
    nS.addEventListener('input', draw); seg($('#gs-mat'), m => { st.mat = m; text(); }); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     09 Microscopes
     ===================================================================== */
  function secEM() {
    const kv = $('#em-kv'), out = $('#em-out');
    const up = () => {
      const V = +kv.value * 1000, l0 = 12.264 / Math.sqrt(V), l1 = 12.264 / Math.sqrt(V * (1 + 0.9785e-6 * V));
      $('#em-kv-v').textContent = kv.value + ' kV';
      out.innerHTML = tx(`<dl class="stats"><dt>λ = h / √(2mE)</dt><dd>${l0.toFixed(4)} Å</dd><dt>With the relativistic correction</dt><dd>${l1.toFixed(4)} Å = ${(l1 * 100).toFixed(2)} pm</dd><dt>Compared with green light (5000 Å)</dt><dd>${sci(5000 / l1)} times shorter</dd></dl>
        <p class="note">Atoms in a metal are about 2.5 Å apart. An SEM usually works at 1 to 30 kV and a TEM at 100 to 300 kV. Above about 50 kV the electron moves fast enough that the simple formula is a few percent too large.</p>`,
        `<dl class="stats"><dt>λ = h / √(2mE)</dt><dd>${l0.toFixed(4)} Å</dd><dt>加上相對論修正</dt><dd>${l1.toFixed(4)} Å = ${(l1 * 100).toFixed(2)} pm</dd><dt>和綠光（5000 Å）相比</dt><dd>短了 ${sci(5000 / l1)} 倍</dd></dl>
        <p class="note">金屬裡的原子間距大約 2.5 Å。SEM 通常用 1 到 30 kV，TEM 用 100 到 300 kV。超過大約 50 kV 之後電子速度很快，簡單公式算出來的值會偏大幾個百分點。</p>`);
    };
    kv.addEventListener('input', up); up(); onLang(up);
  }

  function secSTM() {
    const v = new Viewer($('#v-stm'), { view: [0.12, -1, 0.22], label: () => tx('Tip scanning over a surface of atoms with a vacancy and a step', '探針掃過有空位和台階的原子表面') });
    const st = { m: 'cc', x: 1.2 }, sl = $('#stm-x'), info = $('#stm-info'), legend = $('#stm-legend'), H = Math.SQRT1_2, GAP = 0.35;
    const atoms = [];
    for (let i = -6; i <= 6; i++) for (let j = -2; j <= 2; j++) if (!(i === -3 && j === 0)) atoms.push(V3(i, j, 0));
    for (let i = -6; i <= 5; i++) for (let j = -2; j <= 1; j++) atoms.push(V3(i + 0.5, j + 0.5, -H));
    for (let i = 2; i <= 5; i++) for (let j = -2; j <= 1; j++) atoms.push(V3(i + 0.5, j + 0.5, H));
    // height of a point that keeps a fixed gap g above the hard spheres, along the row y = 0
    const env = (x, g) => { let h = -9; for (const a of atoms) { const q = (0.5 + g) ** 2 - (x - a.x) ** 2 - a.y ** 2; if (q > 0) h = Math.max(h, a.z + Math.sqrt(q)); } return h; };
    let zc = -9; for (let x = -6; x <= 6; x += 0.05) zc = Math.max(zc, env(x, GAP));
    const cur = x => Math.exp(-2 * 2.55 * (zc - env(x, GAP))); // relative current: κ ≈ 1 Å⁻¹, one atom diameter ≈ 2.55 Å
    let lmin = 0; for (let x = -6; x <= 6; x += 0.05) lmin = Math.min(lmin, Math.log10(cur(x)));
    v.rebuild = () => {
      v.clear(); const g = v.root, cc = st.m === 'cc', z = cc ? env(st.x, GAP) : zc;
      cloud(g, atoms, 0.5, COL.corner);
      const cone = new THREE.Mesh(GEO.cone, mStd(T.edge3d)); cone.scale.set(0.75, 2.3, 0.75); cone.quaternion.setFromUnitVectors(UP, V3(0, 0, -1)); cone.position.set(st.x, 0, z + 0.2 + 1.15); g.add(cone);
      atom(g, V3(st.x, 0, z + 0.2), 0.2, T.hi);
      const tr = [], sig = [];
      for (let x = -6; x <= st.x + 1e-6; x += 0.1) { tr.push(V3(x, 0, cc ? env(x, GAP) : zc)); sig.push(V3(x, 0, zc + 3 + 1.3 * (1 - Math.log10(cur(x)) / lmin))); }
      if (tr.length > 1) path(g, tr, 0.035, mBasic(cc ? T.hi : T.accent));
      if (!cc) { if (sig.length > 1) path(g, sig, 0.035, mBasic(T.hi)); dashed(g, [[V3(-6, 0, zc + 3), V3(6, 0, zc + 3)]], T.edge3d, { dash: 0.1, gap: 0.08 }); label(g, 'I', V3(-6.5, 0, zc + 3.7), { color: T.hi, size: 0.5 }); }
      else label(g, 'z', V3(-6.5, 0, env(-6, GAP) + 0.2), { color: T.hi, size: 0.5 });
    };
    function text() {
      const cc = st.m === 'cc', I = cur(st.x), gap = (GAP + (cc ? 0 : zc - env(st.x, GAP))) * 0.255;
      legend.innerHTML = cc
        ? tx(`<span><i class="sq" style="background:${T.hi}"></i>Path of the tip = recorded height z</span><span><i style="background:${COL.corner}"></i>Surface atoms, with one vacancy and one step</span>`, `<span><i class="sq" style="background:${T.hi}"></i>探針走過的路徑＝記錄下來的高度 z</span><span><i style="background:${COL.corner}"></i>表面原子，有一個空位和一個台階</span>`)
        : tx(`<span><i class="sq" style="background:var(--accent)"></i>Path of the tip (level)</span><span><i class="sq" style="background:${T.hi}"></i>Recorded current I, log scale</span><span><i style="background:${COL.corner}"></i>Surface atoms</span>`, `<span><i class="sq" style="background:var(--accent)"></i>探針走過的路徑（水平）</span><span><i class="sq" style="background:${T.hi}"></i>記錄下來的電流 I（對數刻度）</span><span><i style="background:${COL.corner}"></i>表面原子</span>`);
      info.innerHTML = cc
        ? tx(`<h4>Constant current</h4><p>A feedback loop moves the tip up and down to keep the current fixed, so the gap stays the same. The recorded signal is the height z of the tip, and it traces the surface: a bump over each atom, a dip at the vacancy, a rise at the step.</p><dl class="stats"><dt>Gap</dt><dd>${gap.toFixed(2)} nm (held)</dd><dt>Current</dt><dd>held constant</dd></dl><p class="note">Slower, but safe on rough surfaces because the tip follows the surface.</p>`, `<h4>定電流模式</h4><p>回饋電路讓探針上下移動，把電流維持在固定值，所以空隙寬度不變。記錄的訊號是探針高度 z，它描出表面的形狀：每個原子上方凸起，空位的地方凹下去，台階的地方升高。</p><dl class="stats"><dt>空隙</dt><dd>${gap.toFixed(2)} nm（固定）</dd><dt>電流</dt><dd>維持不變</dd></dl><p class="note">比較慢，但探針會跟著表面走，粗糙的表面也安全。</p>`)
        : tx(`<h4>Constant height</h4><p>The tip travels in a straight level line and the current is recorded. Where the surface is closer the current is far larger, so the upper terrace on the right swamps everything else, and the lower terrace is almost dark.</p><dl class="stats"><dt>Gap here</dt><dd>${gap.toFixed(2)} nm</dd><dt>Current here</dt><dd>${I > 0.095 ? I.toFixed(2) : sci(I)} of the maximum</dd></dl><p class="note">Faster, because nothing moves vertically. It only works on very flat surfaces, and the tip would crash into a taller step.</p>`, `<h4>定高度模式</h4><p>探針沿水平直線前進，記錄電流。表面離得近的地方電流大得多，所以右邊的上層台階蓋過其他一切，下層幾乎沒有訊號。</p><dl class="stats"><dt>這裡的空隙</dt><dd>${gap.toFixed(2)} nm</dd><dt>這裡的電流</dt><dd>最大值的 ${I > 0.095 ? I.toFixed(2) : sci(I)} 倍</dd></dl><p class="note">比較快，因為探針不必上下動。只適合非常平的表面，遇到更高的台階探針會撞上去。</p>`);
    }
    const up = () => { v.rebuild(); text(); };
    seg($('#stm-m'), m => { st.m = m; up(); });
    sl.addEventListener('input', () => { v.anim = null; st.x = +sl.value; up(); });
    $('#stm-go').addEventListener('click', () => {
      if (REDUCED) { st.x = 6; sl.value = 6; up(); return; }
      let t0 = null;
      v.anim = t => { if (t0 === null) t0 = t; const u = Math.min(1, (t - t0) / 7000); st.x = -6 + 12 * u; sl.value = st.x; up(); if (u >= 1) v.anim = null; };
    });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 1.3), 7.3); }); text(); onLang(text);
  }

  /* =====================================================================
     10 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('A melt is cooled further below its melting point. What happens to the critical radius r* of a nucleus?', '把熔液冷到比熔點更低的溫度，晶核的臨界半徑 r* 會怎麼變？'), o: [tx('It gets smaller', '變小'), tx('It gets larger', '變大'), tx('It stays the same', '不變'), tx('It becomes zero at once', '馬上變成零')], a: 0, e: tx('r* = 2γT_m / (ΔH_f ΔT). A larger undercooling ΔT gives a smaller r*, so nuclei form more easily.', 'r* = 2γT_m / (ΔH_f ΔT)。過冷度 ΔT 越大，r* 越小，越容易成核。') },
    { q: tx('Compared with homogeneous nucleation at the same undercooling, a nucleus that forms on a mold wall has', '在相同的過冷度下，和均質成核相比，長在模壁上的晶核'), o: [tx('a smaller r* and the same number of atoms', 'r* 比較小，原子數相同'), tx('the same r*, fewer atoms and a lower energy barrier', 'r* 相同，原子數比較少，能量障礙比較低'), tx('a larger r* and a higher energy barrier', 'r* 比較大，能量障礙比較高'), tx('the same r* and the same energy barrier', 'r* 相同，能量障礙也相同')], a: 1, e: tx('The cap has the same radius of curvature as the full sphere. Its volume and its barrier are both smaller by the factor f(θ).', '球冠的曲率半徑和完整的球一樣。體積和能量障礙都乘上 f(θ)，所以都比較小。') },
    { q: tx('A little Ti or B is added to molten aluminum before casting. What is the purpose?', '鑄造前在鋁液裡加一點 Ti 或 B，目的是什麼？'), o: [tx('To lower the melting point', '降低熔點'), tx('To grow a single crystal', '長出單晶'), tx('To give many nucleation sites and so a fine grain size', '提供大量成核位置，讓晶粒變細'), tx('To remove grain boundaries', '消除晶界')], a: 2, e: tx('These are grain refiners. More nuclei means more grains, and each grain is smaller.', '這是晶粒細化劑。晶核越多，晶粒越多，每顆就越小。') },
    { q: tx('Why does Pb hardly dissolve in solid Cu (0.1%), while Ni dissolves completely?', 'Pb 幾乎不溶於固態的 Cu（0.1%），Ni 卻能完全互溶，為什麼？'), o: [tx('Pb has a much lower melting point', 'Pb 的熔點低很多'), tx('The atomic radius of Pb differs from Cu by 36.7%, far above 15%', 'Pb 和 Cu 的原子半徑差了 36.7%，遠超過 15%'), tx('Pb is not a metal', 'Pb 不是金屬'), tx('Pb has too many electrons', 'Pb 的電子太多')], a: 1, e: tx('The first Hume-Rothery rule: the radii must differ by no more than 15%. Cu and Ni differ by only 2.3%.', '休姆–羅瑟里法則第一條：原子半徑相差不能超過 15%。Cu 和 Ni 只差 2.3%。') },
    { q: tx('How many octahedral interstitial sites does one FCC unit cell contain?', '一個 FCC 晶胞裡有幾個八面體間隙？'), o: ['2', '4', '8', '12'], a: 1, e: tx('One at the body center, plus 12 edge centers each shared by 4 cells: 1 + 12 × ¼ = 4. There are 8 tetrahedral sites.', '體心 1 個，加上 12 個稜邊中點、每個由 4 個晶胞共用：1 + 12 × ¼ = 4。四面體間隙有 8 個。') },
    { q: tx('With E_v = 1 eV, the vacancy fraction is 1.6 × 10⁻¹⁷ at 300 K. About what is it at 1000 K?', 'E_v = 1 eV 時，300 K 的空位比例是 1.6 × 10⁻¹⁷。1000 K 時大約是多少？'), o: ['5 × 10⁻¹⁷', '1.6 × 10⁻¹⁴', '9 × 10⁻⁶', '0.3'], a: 2, e: tx('exp(−1 / (8.62 × 10⁻⁵ × 1000)) = 9 × 10⁻⁶. The fraction rises exponentially, here by about 10¹¹ times.', 'exp(−1 / (8.62 × 10⁻⁵ × 1000)) = 9 × 10⁻⁶。空位比例隨溫度呈指數上升，這裡增加了大約 10¹¹ 倍。') },
    { q: tx('How is the Burgers vector of an edge dislocation oriented?', '刃差排的布格向量是什麼方向？'), o: [tx('Parallel to the dislocation line', '平行於差排線'), tx('Perpendicular to the dislocation line', '垂直於差排線'), tx('At 45° to the dislocation line', '和差排線夾 45°'), tx('It has no fixed relation to the line', '和差排線沒有固定關係')], a: 1, e: tx('Edge: b ⟂ line. Screw: b ∥ line. A mixed dislocation is in between.', '刃差排：b ⟂ 差排線。螺旋差排：b ∥ 差排線。混合差排介於兩者之間。') },
    { q: tx('A single crystal is pulled with σ = 100 MPa. For one slip system φ = 45° and λ = 45°. What is the resolved shear stress?', '用 σ = 100 MPa 拉一顆單晶。某個滑移系統的 φ = 45°、λ = 45°，分解剪應力是多少？'), o: ['25 MPa', '50 MPa', '71 MPa', '100 MPa'], a: 1, e: tx('τ = σ cos λ cos φ = 100 × 0.707 × 0.707 = 50 MPa. This is the largest value any slip system can have.', 'τ = σ cos λ cos φ = 100 × 0.707 × 0.707 = 50 MPa。這是任何滑移系統能得到的最大值。') },
    { q: tx('Which stacking sequence contains a twin boundary?', '下列哪一種堆疊順序裡有雙晶界？'), o: ['ABCABCABC', 'ABABABAB', 'ABCABCBACBA', 'ABCABABCABC'], a: 2, e: tx('In ABCAB<u>C</u>BACBA the order reverses at the underlined C, so the two sides mirror each other. The last option has a stacking fault (one C missing).', 'ABCAB<u>C</u>BACBA 的順序在畫底線的 C 反轉，兩側互為鏡像。最後一個選項是疊差（少了一層 C）。') },
    { q: tx('A steel has ASTM grain size number n = 5. How many grains are there per square inch at 100×?', '某種鋼的 ASTM 晶粒度號數 n = 5。在 100 倍下每平方英吋有幾顆晶粒？'), o: ['5', '10', '16', '32'], a: 2, e: tx('N = 2^(n−1) = 2⁴ = 16.', 'N = 2^(n−1) = 2⁴ = 16。') }
  ]; });

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
      es.forEach(e => { if (e.isIntersecting) { links.forEach(a => a.classList.remove('on')); const a = map.get(e.target.id); if (a) { a.classList.add('on'); const ol = a.closest('ol'); if (a.offsetLeft < ol.scrollLeft || a.offsetLeft + a.offsetWidth > ol.scrollLeft + ol.clientWidth) ol.scrollTo({ left: a.offsetLeft - 16, behavior: REDUCED ? 'auto' : 'smooth' }); } } });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('section.unit').forEach(s => ob.observe(s));
  }

  const redraw2D = [];
  function boot() {
    if (GL) {
      [heroScene, secAlloy, secVoid, secPoint, secDis, secSchmid, secGB, secSF, secSTM].forEach(f => { try { f(); } catch (e) { console.error(e); } });
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    redraw2D.push(secSolid(), secDG(), secNuc(), secGrain());
    secHet(); secVac(); secEM(); secQuiz(); toc();
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
    document.title = tx('Solidification and Defects 3D Classroom', '凝固與缺陷 3D 教室');
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
