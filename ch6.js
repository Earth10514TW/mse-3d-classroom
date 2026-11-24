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
     Chapter 6: shared pieces
     ===================================================================== */
  const redraw2D = [];
  const sciH = (x, d = 1) => {
    if (!x) return '0';
    let e = Math.floor(Math.log10(Math.abs(x))), m = (x / 10 ** e).toFixed(d);
    if (Math.abs(+m) >= 10) { e++; m = (x / 10 ** e).toFixed(d); }
    return e === 0 ? m : `${m} × 10<sup>${String(e).replace('-', '−')}</sup>`;
  };
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function blank(x, W, H) { x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H); }
  function axisLabel(x, s, px, py, rot, color) {
    x.save(); x.translate(px, py); if (rot) x.rotate(rot); x.font = FONT(500, 11); x.fillStyle = color || T.muted; x.textAlign = 'center'; x.fillText(s, 0, 0); x.restore();
  }
  function arrow2d(x, x0, y0, x1, y1, color, w = 2) {
    const a = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0); if (L < 2) return;
    const h = Math.min(9, L * 0.45);
    x.strokeStyle = color; x.fillStyle = color; x.lineWidth = w;
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1 - h * Math.cos(a) * 0.8, y1 - h * Math.sin(a) * 0.8); x.stroke();
    x.beginPath(); x.moveTo(x1, y1); x.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42)); x.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42)); x.closePath(); x.fill();
  }
  // Monotone cubic (Fritsch–Carlson) through points [[x, y], ...]; flat outside the range
  function mono(pts) {
    const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), d = [], m = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return x => {
      if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0; while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  // any CSS color → [r, g, b]
  const RGBC = document.createElement('canvas').getContext('2d');
  function rgbOf(c) {
    RGBC.fillStyle = '#000'; RGBC.fillStyle = c; const s = RGBC.fillStyle;
    if (s[0] === '#') return [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
    return s.match(/[\d.]+/g).slice(0, 3).map(Number);
  }
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  // Ellipsoid instances (one draw call)
  function blobs(g, list, color, o = {}) {
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(GEO.sphere, mStd(color, o), list.length), M = new THREE.Matrix4();
    list.forEach((b, i) => { M.makeScale(b.sx, b.sy, b.sz); M.setPosition(b.x, b.y, b.z); m.setMatrixAt(i, M); });
    m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; g.add(m); return m;
  }

  /* =====================================================================
     Hero: a round tensile bar that has started to neck (3D)
     ===================================================================== */
  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [0.35, -1, 0.5], label: () => tx('A round tensile specimen with a neck forming in the gauge section', '圓形拉伸試片，標距段正在頸縮'), clear: 0 });
    v.rebuild = () => {
      v.clear(); const g = v.root, prof = [];
      const r = y => {
        const a = Math.abs(y);
        let base = a > 4.4 ? 1.05 : a < 3.4 ? 0.62 : 0.62 + 0.43 * smooth(3.4, 4.4, a);
        return base - 0.24 * Math.exp(-(((y - 0.7) / 0.5) ** 2));
      };
      for (let i = 0; i <= 160; i++) { const y = -5.6 + 11.2 * i / 160; prof.push(new THREE.Vector2(r(y), y)); }
      prof.unshift(new THREE.Vector2(0, -5.6)); prof.push(new THREE.Vector2(0, 5.6));
      const geo = new THREE.LatheGeometry(prof, 56), pos = geo.attributes.position, cols = [];
      const cb = new THREE.Color(COL.corner), ch = new THREE.Color(T.hi);
      for (let i = 0; i < pos.count; i++) { const k = Math.exp(-(((pos.getY(i) - 0.7) / 0.55) ** 2)); const c = cb.clone().lerp(ch, k * 0.9); cols.push(c.r, c.g, c.b); }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.12 }));
      m.rotation.z = -Math.PI / 2; g.add(m);
      arrow(g, V3(5.7, 0, 0), V3(7.4, 0, 0), 0.07, COL.body); arrow(g, V3(-5.7, 0, 0), V3(-7.4, 0, 0), 0.07, COL.body);
    };
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 6.4); if (!REDUCED) v.setSpin(true); });
  }

  /* =====================================================================
     01 Forming processes: animated cutaway schematics (3D)
     Every part is a 2D section polygon (x, z) extruded along y. Each scene
     has draw(u) with u in 0..1, so the timeline can be scrubbed.
     ===================================================================== */
  function secForm() {
    let ready = false;
    const v = new Viewer($('#v-form'), { view: [0.17, -1, 0.14], label: () => (ready ? tx(`Animated cutaway of ${scene().en}`, `${scene().zh}的剖面示意動畫`) : tx('Animated cutaway of a metal forming process', '金屬成形製程的剖面示意動畫')) });
    const W = 2.6, famEl = $('#pf-f'), varEl = $('#pf-v'), heatEl = $('#pf-h'), rS = $('#pf-r'), tS = $('#pf-t'), playB = $('#pf-play'), info = $('#pf-info');
    const pick = { cast: 'die', roll: 'roll', ext: 'direct', forge: 'closed' }; let fam = 'cast', heat = 'hot', u = REDUCED ? 0.6 : 0, playing = !REDUCED, last = 0, shown = -1;
    let cache = new Map(), used = new Set(), grains = null;

    const R = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const ph = (a, b) => smooth(a, b, u);
    const move = (p, dx = 0, dz = 0) => p.map(q => [q[0] + dx, q[1] + dz]);
    const turn = (p, a, cx = 0, cz = 0) => { const c = Math.cos(a), s = Math.sin(a); return p.map(q => { const x = q[0] - cx, z = q[1] - cz; return [cx + x * c - z * s, cz + x * s + z * c]; }); };
    const disc = (cx, cz, r, n = 56) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI), cz + r * Math.sin(i / n * 2 * Math.PI)]);
    const tint = (a, b, k) => { const c = mix(rgbOf(a), rgbOf(b), Math.max(0, Math.min(1, k))); return `rgb(${c[0]},${c[1]},${c[2]})`; };
    const metal = () => (heat === 'hot' ? COL.body : COL.corner);

    // Draw (or update) one extruded polygon; anything not drawn this frame is hidden
    function D(name, pts, color, o = {}) {
      used.add(name);
      const d = o.d ?? W, op = o.op ?? 1; let e = cache.get(name);
      if (!e) { const m = new THREE.Mesh(new THREE.BufferGeometry(), mStd(color)); v.root.add(m); e = { m, key: '' }; cache.set(name, e); }
      const key = d + '|' + pts.map(q => q[0].toFixed(3) + ',' + q[1].toFixed(3)).join(' ');
      if (key !== e.key) {
        e.key = key; e.m.geometry.dispose();
        const s = new THREE.Shape(pts.map(q => new THREE.Vector2(q[0], q[1])));
        const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 1 });
        geo.rotateX(Math.PI / 2); geo.translate(0, d / 2, 0); e.m.geometry = geo;
      }
      const mat = e.m.material; mat.color.set(color);
      const tr = op < 1; if (mat.transparent !== tr) { mat.transparent = tr; mat.depthWrite = !tr; mat.needsUpdate = true; }
      mat.opacity = op; e.m.visible = op > 0.01;
    }
    function bands(name, rects, lo, hi, color, o = {}, xf = p => p) {
      rects.forEach((r, i) => { const a = Math.max(r[1], lo), b = Math.min(r[3], hi); if (b > a) D(name + i, xf(R(r[0], a, r[2], b)), color, o); });
    }
    function push(name, x0, z0, x1, z1, color = T.hi) {
      const a = Math.atan2(z1 - z0, x1 - x0), L = Math.hypot(x1 - x0, z1 - z0), h = Math.min(0.42, L * 0.5);
      D(name, turn([[0, -0.07], [L - h, -0.07], [L - h, -0.2], [L, 0], [L - h, 0.2], [L - h, 0.07], [0, 0.07]], a).map(q => [q[0] + x0, q[1] + z0]), color, { d: W + 0.3 });
    }
    function ladle(name, x, z, tilt, fill, color) {
      const f = xs => move(turn(xs, tilt), x, z);
      D(name, f([[-0.8, 0.55], [-0.65, 0.55], [-0.65, -0.36], [0.65, -0.36], [0.65, 0.55], [0.8, 0.55], [0.8, -0.52], [-0.8, -0.52]]), T.edge3d, { d: 1.5 });
      if (fill > 0.03) D(name + 'm', f(R(-0.65, -0.36, 0.65, -0.36 + 0.75 * fill)), color, { d: 1.3 });
    }
    const stepped = (list, s, g) => list.map(q => [q[0], s * (q[1] + g)]);

    const SCENES = {
      die: {
        en: 'die casting', zh: '壓鑄', src: 4,
        leg: [['--bad', 'Molten metal', '熔融金屬'], ['--c-corner', 'Solid casting', '凝固鑄件'], ['--edge3d', 'Die, sleeve, plunger', '模具、壓室、柱塞']],
        steps: [[0, 'Pour', '注入', 'A measured charge of molten metal goes into the pressure chamber.', '定量的熔融金屬倒進壓室。'], [0.24, 'Inject', '高壓射出', 'The plunger drives the metal through the sprue and fills the die cavity under high pressure.', '柱塞推動金屬通過澆道，以高壓填滿模穴。'], [0.62, 'Solidify', '凝固', 'Pressure is held while the metal solidifies against the cool die.', '維持壓力，金屬貼著模具凝固。'], [0.76, 'Open', '開模', 'The ejector die pulls away, carrying the casting with it.', '頂出模退開，鑄件跟著離開固定模。'], [0.86, 'Eject', '頂出', 'Ejector pins push the finished part out of the cavity.', '頂出銷把成品推出模穴。']],
        draw() {
          const pour = ph(0.03, 0.2), p = ph(0.24, 0.62), cool = ph(0.62, 0.76), open = ph(0.76, 0.86), ej = ph(0.86, 0.96), hotM = tint(T.bad, COL.corner, cool), px = -4.4 + 2.2 * p, f = Math.max(0, (p - 0.04) / 0.96), dx = 1.8 * open - 0.9 * ej;
          [[-5.4, -3.3], [-2.5, -1]].forEach((a, i) => D('sl' + i, R(a[0], 0.42, a[1], 0.64), T.edge3d)); D('slb', R(-5.4, -0.64, -1, -0.42), T.edge3d);
          D('fa', [[-3.3, 0.64], [-3.5, 0.64], [-4, 1.7], [-3.8, 1.7]], T.edge3d); D('fb', [[-2.5, 0.64], [-2.3, 0.64], [-1.8, 1.7], [-2, 1.7]], T.edge3d);
          D('lt', [[-1, 0.25], [0.2, 0.25], [0.2, 1.6], [1, 1.6], [1, 2.6], [-1, 2.6]], T.edge3d); D('lb', [[-1, -0.25], [-1, -2.6], [1, -2.6], [1, -1.6], [0.2, -1.6], [0.2, -0.25]], T.edge3d);
          D('rd', move([[1, 1.6], [1, 2.6], [3.4, 2.6], [3.4, -2.6], [1, -2.6], [1, -1.6], [1.8, -1.6], [1.8, 1.6]], 1.8 * open), tint(T.edge3d, T.stage, 0.18));
          [-0.9, 0.9].forEach((z, i) => D('pin' + i, R(1.8 + dx, z - 0.13, 4.7 + dx, z + 0.13), T.muted, { d: W + 0.12 }));
          D('rod', R(-6.8, -0.18, px - 0.3, 0.18), T.muted); D('head', R(px - 0.3, -0.4, px, 0.4), T.muted);
          if (pour > 0) D('mS', R(px, -0.42, -1, -0.42 + 0.84 * Math.max(pour, p > 0 ? 1 : 0)), hotM, { d: W - 0.08 });
          if (u < 0.2 && pour > 0) D('st', R(-3, -0.2, -2.8, 2.6), T.bad, { d: 0.5 });
          if (u < 0.24) ladle('la', -2.05, 3.2, 0.25 + 0.65 * ph(0, 0.08), 1 - pour, T.bad);
          if (f > 0) D('mG', R(-1, -0.25, -1 + 1.2 * Math.min(1, f / 0.2), 0.25), hotM, { d: W - 0.08 });
          if (f > 0.2) D('mC', R(0.2 + dx, -1.6, 0.2 + dx + 1.6 * (open > 0 ? 1 : (f - 0.2) / 0.8), 1.6), hotM, { d: W - 0.04 });
          if (p > 0.05 && p < 1) push('pa', px - 1.6, 0.95, px - 0.3, 0.95);
        }
      },
      sand: {
        en: 'sand casting', zh: '砂模鑄造', src: 5,
        leg: [['--muted', 'Packed sand (cope, drag)', '壓實的砂（上模、下模）'], ['--c-face', 'Pattern', '模型'], ['--bad', 'Molten metal', '熔融金屬'], ['--c-corner', 'Solid casting', '凝固鑄件']],
        steps: [[0, 'Pack the drag', '做下模', 'Sand is packed around a pattern shaped like the part.', '在和零件同形的模型周圍填砂壓實。'], [0.16, 'Add the cope', '加上模', 'A top flask is packed with sand, with passages for the sprue and riser.', '上砂箱填砂，並留出澆口和冒口的通道。'], [0.3, 'Remove the pattern', '取出模型', 'The cope is lifted, the pattern comes out, and the empty cavity remains.', '掀開上模取出模型，留下空的模穴。'], [0.48, 'Pour', '澆注', 'Metal runs down the sprue, through the runner and in gate, and rises into the riser.', '金屬從澆口流下，經流道和進料口進入模穴，再升到冒口。'], [0.76, 'Shake out', '落砂', 'After solidifying, the sand is broken away. The gate and riser are cut off later.', '凝固後打掉砂模，澆口和冒口之後再切除。']],
        draw() {
          const sand = T.muted, drag = ph(0, 0.14), cope = ph(0.16, 0.28), lift = 2.5 * (ph(0.3, 0.36) - ph(0.42, 0.48)), out = ph(0.34, 0.42), pour = ph(0.5, 0.74), cool = ph(0.74, 0.82), shake = ph(0.82, 0.96), hotM = tint(T.bad, COL.corner, cool);
          const CAV = [[-1.8, -1.8, 1.8, 0], [-0.9, 0, 0.9, 1]], PAT = [[-1.8, -1.8, 1.8, 0], [-0.9, 0, 0.9, 1]];
          const sOp = 1 - shake;
          D('fL', R(-4.25, -3.2, -4, 3.2), T.edge3d, { op: sOp }); D('fR', R(4, -3.2, 4.25, 3.2), T.edge3d, { op: sOp }); D('fB', R(-4.25, -3.4, 4.25, -3.2), T.edge3d, { op: sOp });
          if (u < 0.3) {
            D('dR', R(-4, -3.2, 4, -3.2 + 3.2 * Math.max(drag, 0.02)), sand);
            if (cope > 0) D('cR', R(-4, 0, 4, 3 * cope), sand);
            bands('pat', PAT, -9, 9, COL.face, { d: W + 0.06 });
          } else {
            D('dP', [[-4, -3.2], [4, -3.2], [4, 0], [3.1, 0], [3.1, -0.4], [1.8, -0.4], [1.8, -1.8], [-1.8, -1.8], [-1.8, -0.4], [-3.2, -0.4], [-3.2, 0], [-4, 0]], sand, { op: sOp });
            [[[-4, 0], [-3.2, 0], [-3.2, 3], [-4, 3]], [[-2.7, 0], [-0.9, 0], [-0.9, 1], [0.9, 1], [0.9, 0], [2.4, 0], [2.4, 3], [-2.7, 3]], [[3.1, 0], [4, 0], [4, 3], [3.1, 3]]].forEach((q, i) => D('c' + i, move(q, 0, lift), sand, { op: sOp }));
            if (out < 1) bands('pOut', PAT, -9, 9, COL.face, { d: W + 0.06, op: 1 - out }, q => move(q, 0, 2 * out));
          }
          if (pour > 0) {
            const L = -1.8 + 4.7 * pour;
            D('runL', R(-3.2, -0.4, -1.8, Math.min(0, -0.4 + pour * 6)), hotM, { d: W - 0.06 });
            bands('fill', CAV, -9, L, hotM, { d: W - 0.06 });
            if (L > -0.4) D('runR', R(1.8, -0.4, 3.1, Math.min(0, L)), hotM, { d: W - 0.06 });
            if (L > 0) D('ris', R(2.4, 0, 3.1, Math.min(2.8, L)), hotM, { d: W - 0.06 });
            D('spr', R(-3.2, 0, -2.7, pour < 1 ? 3.4 : Math.min(2.8, L)), hotM, { d: W - 0.06 });
          }
          if (u > 0.46 && u < 0.76) ladle('la', -2.05, 4.15, 0.7 * ph(0.47, 0.52), 1 - pour * 0.85, T.bad);
        }
      },
      inv: {
        en: 'investment casting', zh: '脫蠟鑄造', src: 6,
        leg: [['--c-face', 'Wax pattern', '蠟模'], ['--c-plane', 'Ceramic shell', '陶瓷殼'], ['--bad', 'Molten metal', '熔融金屬'], ['--c-corner', 'Solid casting', '凝固鑄件']],
        steps: [[0, 'Wax tree', '組蠟樹', 'Injected wax patterns are attached to a central wax sprue.', '射出成形的蠟模黏到中央的蠟澆道上。'], [0.18, 'Build the shell', '做陶瓷殼', 'The tree is dipped in ceramic slurry and stuccoed, repeatedly, until the shell is thick enough.', '蠟樹反覆沾漿、撒砂，直到陶瓷殼夠厚。'], [0.44, 'Dewax', '脫蠟', 'The shell is inverted and heated, so the wax melts out and leaves a cavity.', '把殼倒過來加熱，蠟熔化流出，留下空腔。'], [0.64, 'Pour', '澆注', 'Molten metal fills the cavity, copying the smooth inner surface of the shell.', '熔融金屬填滿空腔，複製殼內光滑的表面。'], [0.8, 'Break out', '破殼', 'The shell is broken off.', '打掉陶瓷殼。'], [0.9, 'Cut off', '切件', 'Each part is cut from the tree and finished.', '把零件從樹上切下，再做表面加工。']],
        draw() {
          const tree = g => [[-0.3 - g, -2.6 - g, 0.3 + g, 2.3 + g], [-0.85 - g, 2.3 - g, 0.85 + g, 3 + g], ...[1.25, 0, -1.25].flatMap(z => [[-2 - g, z - 0.42 - g, -0.3 + g, z + 0.42 + g], [0.3 - g, z - 0.42 - g, 2 + g, z + 0.42 + g]])];
          const att = ph(0.02, 0.16), dip = Math.max(ph(0.2, 0.25) - ph(0.27, 0.31), ph(0.33, 0.37) - ph(0.39, 0.43)), th = 0.03 + 0.14 * ph(0.25, 0.3) + 0.15 * ph(0.37, 0.42), flip = Math.PI * (ph(0.44, 0.49) - ph(0.59, 0.64)), wax = 1 - ph(0.49, 0.59), pour = ph(0.66, 0.78), cool = ph(0.78, 0.82), brk = ph(0.82, 0.9), cut = ph(0.92, 0.99), hotM = tint(T.bad, COL.corner, cool), xf = q => turn(q, flip);
          const parts = tree(0), hasShell = u > 0.2;
          if (u < 0.2) parts.forEach((r, i) => { const off = i < 2 ? 0 : (r[0] < 0 ? -1 : 1) * 2.4 * (1 - att); D('w' + i, move(R(...r), off), COL.face, { d: W - 0.1 }); });
          else {
            if (hasShell && brk < 1) tree(th).forEach((r, i) => D('sh' + i, xf(R(...r)), COL.plane, { d: W + 0.1, op: 1 - brk }));
            parts.forEach((r, i) => D('void' + i, xf(R(...r)), T.stage, { d: W + 0.16, op: u < 0.82 ? 1 : 1 - brk }));
            if (wax > 0) { const lo = 3 - 5.6 * wax; bands('wx', parts, lo, 9, COL.face, { d: W + 0.2 }, xf); if (wax < 1 && flip > 3) D('drip', R(-0.12, -5 + 2 * (u * 40 % 1), 0.12, -4.5 + 2 * (u * 40 % 1)), COL.face, { d: 0.3 }); }
            if (pour > 0) {
              const level = -2.6 + 5.6 * pour;
              if (cut > 0) parts.forEach((r, i) => D('m' + i, move(R(...r), i < 2 ? 0 : (r[0] < 0 ? -0.7 : 0.7) * cut), COL.corner, { d: W + 0.22 }));
              else { bands('m', parts, -9, level, hotM, { d: W + 0.22 }); if (pour < 1) D('stream', R(-0.13, level, 0.13, 3.8), T.bad, { d: W + 0.24 }); }
            }
            if (dip > 0) D('tank', R(-3.4, -3.8, 3.4, -3.8 + 7.4 * dip), T.ink, { d: W + 0.5, op: 0.18 });
            if (u > 0.64 && u < 0.8) ladle('la', 1.1, 4.45, 0.65 * ph(0.64, 0.67), 1 - pour * 0.85, T.bad);
          }
        }
      },
      roll: {
        en: 'rolling', zh: '軋延', src: 8, loop: 1, dur: 7,
        leg: [[null, 'Grains in the metal', '金屬裡的晶粒'], ['--edge3d', 'Rolls', '滾輪']],
        steps: [[0, 'Continuous pass', '連續通過', '', '']],
        draw() {
          const red = +rS.value / 100, T0 = 1.6, RR = 2.4, tt = T0 * (1 - red), zc = tt / 2 + RR, xb = -Math.sqrt(Math.max(0, RR * RR - (zc - T0 / 2) ** 2));
          const h = x => (x >= 0 ? tt : x <= xb ? T0 : 2 * (zc - Math.sqrt(RR * RR - x * x))), X0 = -6.8, X1 = 6.8, xs = [], S = []; let acc = 0;
          for (let i = 0; i <= 340; i++) { const x = X0 + (X1 - X0) * i / 340; if (i) acc += (h(x) / T0) * (X1 - X0) / 340; xs.push(x); S.push(acc); }
          const prof = xs.filter((_, i) => i % 4 === 0); D('slab', [...prof.map(x => [x, -h(x) / 2]), ...prof.slice().reverse().map(x => [x, h(x) / 2])], metal(), { d: 2.2, op: 0.17 });
          [1, -1].forEach(s => { D('r' + s, disc(0, s * zc, RR, 72), T.edge3d, { d: 2.9 }); D('m' + s, move(turn(R(0.5, -0.09, RR - 0.12, 0.09), -s * 2 * Math.PI * 2 * u), 0, s * zc), T.stage, { d: 2.96 }); D('ax' + s, disc(0, s * zc, 0.16, 20), T.muted, { d: 3.4 }); });
          const sp = 0.4, cols = Math.ceil(acc / sp), L = cols * sp, list = [], recr = heat === 'hot';
          for (let c = 0; c < cols; c++) {
            const s = (c * sp + u * L * 0.25) % L; let i = 0, lo = 0, hi = S.length - 1;
            while (hi - lo > 1) { i = (lo + hi) >> 1; if (S[i] < s) lo = i; else hi = i; }
            const x = xs[lo] + (xs[hi] - xs[lo]) * ((s - S[lo]) / Math.max(1e-6, S[hi] - S[lo])), hx = h(x), st = T0 / hx, renew = recr ? smooth(0.2, 1.5, x) : 0;
            const sxC = 0.18 * st, szC = 0.18 / st, eq = Math.min(0.18, hx / 8.6), sx = sxC + (eq - sxC) * renew, sz = szC + (eq - szC) * renew, sy = 0.18 + (eq - 0.18) * renew;
            for (let k = 0; k < 4; k++) for (let j = 0; j < 5; j++) list.push({ x, y: -0.88 + j * 0.44, z: -hx / 2 + (k + 0.5) * hx / 4, sx, sy, sz });
          }
          used.add('_g');
          if (!grains || grains.count !== list.length || grains.userData.color !== metal()) {
            if (grains) { v.root.remove(grains); grains.material.dispose(); grains.dispose && grains.dispose(); }
            grains = blobs(v.root, list, metal()); grains.userData.color = metal();
          } else {
            const M = new THREE.Matrix4(); list.forEach((b, i) => { M.makeScale(b.sx, b.sy, b.sz); M.setPosition(b.x, b.y, b.z); grains.setMatrixAt(i, M); });
            grains.instanceMatrix.needsUpdate = true;
          }
          push('fi', -7.4, 1.5, -5.9, 1.5, T.muted); push('fo', 5.3, 1.5, 6.8, 1.5, T.muted);
        }
      },
      direct: {
        en: 'direct extrusion', zh: '直接擠製', src: 10, thermal: 1,
        leg: [[null, 'Billet and product', '胚料與擠製品'], ['--edge3d', 'Container and die', '容器與模具'], ['--muted', 'Ram', '衝桿'], ['--hi', 'Motion, friction', '運動、摩擦']],
        steps: [[0, 'Load', '裝料', 'The billet sits in the container, and the die is fixed to the container.', '胚料放進容器，模具固定在容器上。'], [0.12, 'Push', '擠壓', 'The ram pushes the whole billet along the wall. This sliding contact causes high friction and a large ram force.', '衝桿推動整塊胚料沿器壁滑動，這段滑動接觸造成高摩擦和很大的衝桿力。'], [0.86, 'End of stroke', '行程結束', 'The ram stops before the die, leaving a short butt of unextruded metal.', '衝桿停在模具前，留下一小段未擠出的料頭。']],
        draw() {
          const ratio = 2.4, xD = 1.0, stroke = 2.1 * ph(0.12, 0.86), xR = -3.1 + stroke, m = metal();
          D('ct', R(-5, 1.22, 1, 2.3), T.edge3d); D('cb', R(-5, -2.3, 1, -1.22), T.edge3d);
          D('dt', [[1, 0.5], [1.6, 0.5], [1.6, 2.3], [1, 2.3]], tint(T.edge3d, T.stage, 0.2)); D('db', [[1, -2.3], [1.6, -2.3], [1.6, -0.5], [1, -0.5]], tint(T.edge3d, T.stage, 0.2));
          D('ram', R(-7, -0.5, xR - 0.5, 0.5), T.muted); D('rh', R(xR - 0.5, -1.2, xR, 1.2), T.muted);
          D('bil', R(xR, -1.2, xD, 1.2), m, { d: W - 0.06 }); D('neck', R(xD, -0.5, 1.6, 0.5), m, { d: W - 0.06 });
          if (stroke > 0) D('prod', R(1.6, -0.5, 1.6 + stroke * ratio, 0.5), m, { d: W - 0.06 });
          for (let i = 0; i < 9; i++) {
            const s0 = 0.2 + i * 0.45, s = s0 - stroke;
            if (s > 0) D('b' + i, R(xD - s - 0.03, -1.2, xD - s + 0.03, 1.2), T.ink, { d: W, op: 0.55 });
            else D('b' + i, R(1.6 - s * ratio - 0.05, -0.5, 1.6 - s * ratio + 0.05, 0.5), T.ink, { d: W, op: 0.55 });
          }
          push('pr', -6.9, 0, -5.1 + stroke, 0, T.ink);
          if (u > 0.12 && u < 0.86) [-1, 1].forEach(sg => [-2.2, -1.1, 0].forEach((x, i) => { if (x > xR) push('fr' + sg + i, x + 0.6, sg * 1.42, x, sg * 1.42, T.hi); }));
        }
      },
      indirect: {
        en: 'indirect extrusion', zh: '間接擠製', src: 10, thermal: 1,
        leg: [[null, 'Billet and product', '胚料與擠製品'], ['--edge3d', 'Container (closed end)', '容器（封閉端）'], ['--muted', 'Hollow ram with die', '中空衝桿與模具']],
        steps: [[0, 'Load', '裝料', 'The billet sits in a closed container, and the die is mounted on a hollow ram.', '胚料放進封閉的容器，模具裝在中空衝桿上。'], [0.12, 'Push', '擠壓', 'The die moves into a billet that stays still, so there is no sliding along the wall. Friction and ram force are small.', '模具推進靜止的胚料，器壁沒有相對滑動，所以摩擦和衝桿力都小。'], [0.86, 'End of stroke', '行程結束', 'The product has left through the ram. The hollow ram is what limits its shape and size.', '擠製品穿過衝桿離開，中空衝桿也限制了它的形狀和尺寸。']],
        draw() {
          const ratio = 2.4, x0 = 0.5, stroke = 1.9 * ph(0.12, 0.86), xd = x0 + stroke, m = metal();
          D('ct', R(-1.6, 1.22, 5.4, 2.3), T.edge3d); D('cb', R(-1.6, -2.3, 5.4, -1.22), T.edge3d); D('ce', R(4.6, -1.22, 5.4, 1.22), T.edge3d);
          D('rt', R(-7, 0.52, xd - 0.45, 1.16), T.muted); D('rb', R(-7, -1.16, xd - 0.45, -0.52), T.muted);
          D('dt', R(xd - 0.45, 0.5, xd, 1.2), tint(T.edge3d, T.stage, 0.2), { d: W + 0.03 }); D('db', R(xd - 0.45, -1.2, xd, -0.5), tint(T.edge3d, T.stage, 0.2), { d: W + 0.03 });
          D('bil', R(xd, -1.2, 4.6, 1.2), m, { d: W - 0.06 }); D('neck', R(xd - 0.45, -0.5, xd, 0.5), m, { d: W - 0.06 });
          if (stroke > 0) D('prod', R(xd - 0.45 - stroke * ratio, -0.5, xd - 0.45, 0.5), m, { d: W - 0.06 });
          for (let i = 0; i < 9; i++) {
            const xm = x0 + 0.2 + i * 0.45;
            if (xm > xd) D('b' + i, R(xm - 0.03, -1.2, xm + 0.03, 1.2), T.ink, { d: W, op: 0.55 });
            else { const x = xd - 0.45 - (xd - xm) * ratio; D('b' + i, R(x - 0.05, -0.5, x + 0.05, 0.5), T.ink, { d: W, op: 0.55 }); }
          }
          push('pu', -5.2 + stroke, 1.6, -3.7 + stroke, 1.6, T.ink); push('pd', -5.2 + stroke, -1.6, -3.7 + stroke, -1.6, T.ink);
        }
      },
      closed: {
        en: 'closed-die forging', zh: '閉模鍛造', src: 11,
        leg: [['--c-body', 'Hot workpiece', '高溫工件'], ['--edge3d', 'Upper and lower die', '上模與下模'], ['--hi', 'Press force', '鍛壓力']],
        steps: [[0, 'Contact', '接觸', 'A hot billet sits in the lower die and the moving die comes down.', '高溫胚料放在下模上，上模往下壓。'], [0.26, 'Lateral flow', '橫向流動', 'The billet spreads sideways until the die walls restrict it, which forces metal into the cavity.', '胚料往兩側擴展，碰到模壁後受限，金屬被迫流進模穴。'], [0.56, 'Fill the die', '填滿模穴', 'The cavity fills, and the small excess squeezes out as thin flash.', '模穴填滿，少量多餘的金屬擠成薄薄的毛邊。'], [0.78, 'Open', '開模', 'The dies open. The part has the die shape, with pores closed.', '開模，工件成為模穴的形狀，孔隙也被壓合。']],
        draw() {
          const Hx = x => { const a = Math.abs(x); return a < 0.75 ? 1.75 : a < 2.2 ? 0.72 : 0.1; }, g = 3.1 * (1 - ph(0.08, 0.74)) + 2.2 * ph(0.82, 0.96), area = (a, gap) => { let t = 0; for (let i = 0; i < 200; i++) { const x = -a + 2 * a * (i + 0.5) / 200; t += Math.min(prof(x, a), Hx(x) + gap / 2) * 2 * a / 200; } return t; }, prof = (x, a) => 2 * Math.pow(Math.max(0, 1 - Math.abs(x / a) ** 4), 0.25), A0 = area(3.05, 0);
          let lo = 0.6, hi = 3.2; const gg = Math.min(g, 3.1 * (1 - ph(0.08, 0.74))); for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (area(m, gg) < A0) lo = m; else hi = m; } const a = (lo + hi) / 2;
          const face = [[-4.4, 0.1], [-2.2, 0.1], [-2.2, 0.72], [-0.75, 0.72], [-0.75, 1.75], [0.75, 1.75], [0.75, 0.72], [2.2, 0.72], [2.2, 0.1], [4.4, 0.1]];
          const up = stepped(face, 1, g / 2), dn = stepped(face, -1, g / 2);
          D('up', [...up, [4.4, up[0][1] + 2.2], [-4.4, up[0][1] + 2.2]], T.edge3d); D('dn', [...dn, [4.4, dn[0][1] - 2.2], [-4.4, dn[0][1] - 2.2]], tint(T.edge3d, T.stage, 0.16));
          const n = 150, top = [], bot = []; for (let i = 0; i <= n; i++) { const x = -a + 2 * a * i / n, zz = Math.max(0.005, Math.min(prof(x, a), Hx(x) + gg / 2)); top.push([x, zz]); bot.unshift([x, -zz]); }
          D('w', [...bot.reverse().map(q => q), ...top.slice().reverse()], COL.body, { d: W - 0.08 });
          if (u > 0.06 && u < 0.74) push('f', 0, up[0][1] + 3.7, 0, up[0][1] + 2.4);
        }
      },
      open: {
        en: 'open-die forging', zh: '開模鍛造', src: 11,
        leg: [['--c-body', 'Hot workpiece', '高溫工件'], ['--edge3d', 'Flat dies', '平面模'], ['--muted', 'Tongs', '夾鉗'], ['--hi', 'Hammer blow', '錘擊']],
        steps: [[0, 'Blow after blow', '逐段錘擊', 'Flat dies do not enclose the piece. Tongs feed it through and each blow thins one section.', '平面模不包住工件，夾鉗一段段送料，每一錘壓薄一段。'], [0.84, 'Elongated', '拉長完成', 'The bar is thinner and longer. Its grains are elongated and its structure is closer, which improves its properties.', '棒材變薄變長，晶粒被拉長、組織更緻密，機械性質跟著提升。']],
        draw() {
          const n = 6, T0 = 1.9, T1 = 1.15, l0 = 0.72, sec = Array.from({ length: n }, (_, i) => { const t = u / 0.84 * n - i; return Math.max(0, Math.min(1, smooth(0.32, 0.62, t) )); });
          const hs = sec.map(p => T0 + (T1 - T0) * p), ls = hs.map(h => l0 * T0 / h), idx = Math.min(n - 1, Math.floor(u / 0.84 * n)), loc = u / 0.84 * n - idx, c = (j) => { let t = 0; for (let k = 0; k < j; k++) t += ls[k]; return t + ls[j] / 2; };
          const cCur = c(idx), cPrev = idx ? c(idx - 1) : cCur, feed = u >= 0.84 ? c(n - 1) : cPrev + (cCur - cPrev) * smooth(0, 0.28, loc), total = ls.reduce((a, b) => a + b, 0), stub = 1.4, x0 = -feed;
          const prof = [[x0, hs[0]]]; let at = x0; ls.forEach((l, i) => { prof.push([at + 0.06, hs[i]], [at + l - 0.06, hs[i]]); at += l; }); prof.push([at + 0.12, T0], [at + stub, T0]);
          D('bar', [...prof.map(q => [q[0], -q[1] / 2]), ...prof.slice().reverse().map(q => [q[0], q[1] / 2])], COL.body, { d: 1.8 });
          D('tg', R(at + stub - 0.1, -0.26, at + stub + 2.2, 0.26), T.muted, { d: 0.5 }); D('tu', R(at + stub - 0.6, 0.9, at + stub + 0.4, 1.15), T.muted, { d: 0.5 }); D('td', R(at + stub - 0.6, -1.15, at + stub + 0.4, -0.9), T.muted, { d: 0.5 });
          const strike = u >= 0.84 ? 0 : smooth(0.3, 0.55, loc) - smooth(0.68, 0.96, loc), base = hs[idx] / 2, gap = T0 / 2 + 0.8, zH = gap + (base - gap) * strike;
          D('hu', R(-0.95, zH, 0.95, zH + 1.7), T.edge3d, { d: 2.6 }); D('hd', R(-0.95, -zH - 1.7, 0.95, -zH), tint(T.edge3d, T.stage, 0.16), { d: 2.6 });
          if (u < 0.84 && loc > 0.05 && loc < 0.55) push('f', 0, zH + 3.1, 0, zH + 1.85);
          void total;
        }
      },
      upset: {
        en: 'upset forging', zh: '鐓粗鍛造', src: 12,
        leg: [['--c-body', 'Hot bar', '高溫棒材'], ['--edge3d', 'Gripping die', '夾持模'], ['--muted', 'Heading tool', '鐓頭工具'], ['--hi', 'Tool force', '工具推力']],
        steps: [[0, 'Grip', '夾緊', 'The gripping dies close on the bar with its end sticking out.', '夾持模夾住棒材，端部露在外面。'], [0.14, 'First stage', '第一道', 'The heading tool shortens the free end, so it grows thicker.', '鐓頭工具把露出的端部壓短，端部隨之變粗。'], [0.38, 'Second stage', '第二道', 'Another strike moves more metal into the head.', '再打一次，更多金屬進到頭部。'], [0.6, 'Third stage', '第三道', 'The head reaches its final diameter, as for a bolt or nail head.', '頭部達到最終直徑，就像螺栓或釘子的頭。'], [0.84, 'Release', '鬆開', 'The dies open and the headed bar is removed.', '夾持模打開，取出帶頭的棒材。']],
        draw() {
          const R0 = 0.58, L0 = 3.4, Pv = [3.4, 2.5, 1.75, 1.1], hit = [ph(0.15, 0.28), ph(0.39, 0.5), ph(0.61, 0.74)], P = Pv[0] + (Pv[1] - Pv[0]) * hit[0] + (Pv[2] - Pv[1]) * hit[1] + (Pv[3] - Pv[2]) * hit[2], back = (ph(0.29, 0.36) * (1 - ph(0.36, 0.39))) + (ph(0.51, 0.56) * (1 - ph(0.56, 0.6))), rb = R0 * Math.sqrt(L0 / P), xF = -0.6, grip = 0.9 * (1 - ph(0.02, 0.12)) + 0.9 * ph(0.86, 0.96), rel = ph(0.9, 0.99);
          const top = []; for (let i = 0; i <= 40; i++) { const s = i / 40, b = Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.92 + 0.08)), 0.55); top.push([xF + s * P, R0 + (rb - R0) * b * (P < L0 ? 1 : 0)]); }
          const shape = [[-7, R0], ...top, ...top.slice().reverse().map(q => [q[0], -q[1]]), [-7, -R0]];
          D('bar', move(shape, -0.9 * rel), COL.body, { d: 1.5 });
          D('gu', R(-4.6, R0 + grip, xF, 2.5 + grip), T.edge3d, { d: 2.6 }); D('gd', R(-4.6, -2.5 - grip, xF, -R0 - grip), tint(T.edge3d, T.stage, 0.16), { d: 2.6 });
          const xT = xF + P + 1.3 * back + (u < 0.14 ? 1.3 * (1 - ph(0.05, 0.14)) : 0) + 2 * ph(0.76, 0.86);
          D('tool', R(xT, -1.9, xT + 1.6, 1.9), T.muted, { d: 2.4 }); D('tr', R(xT + 1.6, -0.3, 7.4, 0.3), T.muted, { d: 0.6 });
          if ((hit[0] > 0 && hit[0] < 1) || (hit[1] > 0 && hit[1] < 1) || (hit[2] > 0 && hit[2] < 1)) push('f', xT + 3, 1.2, xT + 1.75, 1.2);
        }
      }
    };
    const FAMS = {
      cast: [['die', 'Die', '壓鑄'], ['sand', 'Sand', '砂模'], ['inv', 'Investment', '脫蠟']],
      roll: [],
      ext: [['direct', 'Direct', '直接'], ['indirect', 'Indirect', '間接']],
      forge: [['closed', 'Closed die', '閉模'], ['open', 'Open die', '開模'], ['upset', 'Upset', '鐓粗']]
    };
    function scene() { return SCENES[pick[fam]]; }
    ready = true;

    function rollText() {
      const red = +rS.value / 100, k = 1 / (1 - red);
      return tx(`<dl class="stats"><dt>t / t<sub>0</sub></dt><dd>${(1 - red).toFixed(2)}</dd><dt>Length, same width</dt><dd>× ${k.toFixed(2)}</dd><dt>Grain length / thickness</dt><dd>${heat === 'cold' ? (k * k).toFixed(1) + ' : 1' : '≈ 1 : 1'}</dd></dl>`,
        `<dl class="stats"><dt>t / t<sub>0</sub></dt><dd>${(1 - red).toFixed(2)}</dd><dt>長度（寬度不變）</dt><dd>× ${k.toFixed(2)}</dd><dt>晶粒長 / 厚</dt><dd>${heat === 'cold' ? (k * k).toFixed(1) + ' : 1' : '≈ 1 : 1'}</dd></dl>`) + (heat === 'cold'
        ? tx(`<p>Below T<sub>recrystal</sub> each grain is squashed with the slab and stays that way. The dislocations made by this deformation remain, so the sheet comes out stronger and less ductile.</p>${red > 0.5 ? '<p class="note">A reduction this large in one go is near the limit for cold rolling. In practice the sheet is annealed between passes.</p>' : ''}`,
          `<p>低於 T<sub>再結晶</sub>，每顆晶粒跟著板子被壓扁，而且維持扁長。變形產生的差排留在金屬裡，所以板子更強、延性更差。</p>${red > 0.5 ? '<p class="note">一次減薄這麼多，已經接近冷軋的極限。實務上會在道次之間退火。</p>' : ''}`)
        : tx('<p>Above T<sub>recrystal</sub> the squashed grains are replaced by new, equiaxed ones just behind the rolls, so the metal stays soft and can take large reductions. The price is surface oxidation.</p>',
          '<p>高於 T<sub>再結晶</sub>，被壓扁的晶粒在滾輪後方被等軸的新晶粒取代，金屬保持軟，可以一次減薄很多。代價是表面氧化。</p>'));
    }
    function stepText(force) {
      const sc = scene(); let i = 0; sc.steps.forEach((s, j) => { if (u >= s[0]) i = j; });
      if (!force && i === shown) return; shown = i;
      if (sc.loop) { info.innerHTML = rollText(); return; }
      const s = sc.steps[i], thermal = sc.thermal ? (heat === 'hot'
        ? tx('<p class="note">Hot extrusion: T &gt; T<sub>recrystal</sub> (0.5–0.75 T<sub>m</sub>), P = 30–700 MPa.</p>', '<p class="note">熱擠製：T &gt; T<sub>再結晶</sub>（0.5–0.75 T<sub>m</sub>），P = 30–700 MPa。</p>')
        : tx('<p class="note">Cold extrusion: about room temperature, P = 3000 MPa.</p>', '<p class="note">冷擠製：約室溫，P = 3000 MPa。</p>')) : '';
      info.innerHTML = `<p><b>${tx('Step', '步驟')} ${i + 1} / ${sc.steps.length}・${tx(s[1], s[2])}</b></p><p>${tx(s[3], s[4])}</p>${thermal}`;
    }
    function legend() {
      $('#pf-legend').innerHTML = scene().leg.map(l => `<span><i class="sq" style="background:${l[0] ? `var(${l[0]})` : (heat === 'hot' ? 'var(--c-body)' : 'var(--c-corner)')}"></i>${tx(l[1], l[2])}</span>`).join('');
    }
    function paint() {
      used = new Set(); scene().draw();
      cache.forEach((e, k) => { if (!used.has(k)) e.m.visible = false; });
      if (grains) grains.visible = used.has('_g');
      tS.value = Math.round(u * 1000); v.dirty = true; stepText(false);
    }
    function controls() {
      const list = FAMS[fam], sc = scene();
      varEl.parentElement.style.display = list.length ? '' : 'none';
      varEl.innerHTML = list.map(o => `<button type="button" data-v="${o[0]}" aria-pressed="${o[0] === pick[fam]}">${tx(o[1], o[2])}</button>`).join('');
      heatEl.parentElement.style.display = fam === 'roll' || sc.thermal ? '' : 'none';
      rS.parentElement.style.display = fam === 'roll' ? '' : 'none';
      $('#pf-r-v').textContent = `${rS.value} %`;
      playB.textContent = playing ? tx('Pause', '暫停') : tx('Play', '播放'); playB.setAttribute('aria-pressed', String(playing));
      legend(); v.cv.setAttribute('aria-label', v.labelFn());
    }
    v.rebuild = () => { v.clear(); cache = new Map(); grains = null; paint(); };
    function restart() { u = REDUCED ? 0.6 : 0; shown = -1; v.rebuild(); controls(); stepText(true); }
    v.anim = t => {
      if (!playing) { last = t; return; }
      const dt = Math.min(0.1, (t - last) / 1000); last = t; const sc = scene();
      u += dt / (sc.dur || 11); if (u >= 1) u -= 1; paint();
    };
    seg(famEl, f => { fam = f; restart(); });
    seg(varEl, x => { pick[fam] = x; restart(); });
    seg(heatEl, h => { heat = h; v.rebuild(); controls(); stepText(true); });
    rS.addEventListener('input', () => { v.rebuild(); controls(); stepText(true); });
    tS.addEventListener('input', () => { playing = false; u = +tS.value / 1000; paint(); controls(); });
    playB.addEventListener('click', () => { playing = !playing; controls(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0.4), 6.9); });
    controls(); stepText(true); onLang(() => { v.rebuild(); controls(); stepText(true); });
  }

  /* =====================================================================
     02 Tension and shear of an elastic block (3D)
     ===================================================================== */
  const MATS = [
    { en: 'Aluminium alloys', zh: '鋁合金', E: 72.4, G: 27.5, nu: 0.31 },
    { en: 'Copper', zh: '銅', E: 110, G: 41.4, nu: 0.33 },
    { en: 'Plain carbon steel', zh: '碳鋼', E: 200, G: 75.8, nu: 0.33 },
    { en: 'Stainless steel (18-8)', zh: '不鏽鋼（18-8）', E: 193, G: 65.6, nu: 0.28 },
    { en: 'Titanium', zh: '鈦', E: 117, G: 44.8, nu: 0.31 },
    { en: 'Tungsten', zh: '鎢', E: 400, G: 157, nu: 0.27 }
  ];
  function secBar() {
    const v = new Viewer($('#v-bar'), { view: [0.4, -1, 0.5], label: () => tx('A block stretched or sheared elastically, drawn against its original outline', '一個被彈性拉伸或剪切的方塊，和原本的輪廓對照') });
    const sS = $('#el-s'), info = $('#el-info'); let mode = 'ten', mi = 2;
    const L = 4, W = 1.6, X = 100;
    const box = (sx, sy, sz, shear) => {
      const p = []; for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) p.push(V3(x * sx / 2 + (shear ? z * shear / 2 : 0), y * sy / 2, z * sz / 2));
      return p; // index = x + 2y + 4z with 0/1 bits
    };
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
    v.rebuild = () => {
      v.clear(); const g = v.root, m = MATS[mi], s = +sS.value;
      const o = box(L, W, W, 0);
      dashed(g, EDGES.map(([a, b]) => [o[a], o[b]]), T.edge3d, { dash: 0.12, gap: 0.08 });
      let p;
      if (mode === 'ten') { const e = s / (m.E * 1000) * X; p = box(L * (1 + e), W * (1 - m.nu * e), W * (1 - m.nu * e), 0); }
      else { const gm = s / (m.G * 1000) * X; p = box(L, W, W, W * gm); }
      FACES.forEach(f => poly(g, f.map(i => p[i]), COL.corner, 0.42, false));
      const mat = mStd(COL.corner); EDGES.forEach(([a, b]) => rod(g, p[a], p[b], 0.03, mat));
      const k = 0.4 + 1.2 * s / 400;
      if (s > 0) {
        if (mode === 'ten') {
          const xr = p[1].x; arrow(g, V3(xr + 0.15, 0, 0), V3(xr + 0.15 + k, 0, 0), 0.07, COL.body);
          arrow(g, V3(-xr - 0.15, 0, 0), V3(-xr - 0.15 - k, 0, 0), 0.07, COL.body);
        } else {
          const zt = W / 2 + 0.15, sh = p[4].x - o[4].x;
          arrow(g, V3(-k / 2 + sh, 0, zt), V3(k / 2 + sh, 0, zt), 0.07, COL.body);
          arrow(g, V3(k / 2 - sh, 0, -zt), V3(-k / 2 - sh, 0, -zt), 0.07, COL.body);
        }
      }
      label(g, tx('drawn ×100', '放大 100 倍'), V3(0, 0, -W / 2 - 0.6), { size: 0.28, color: T.muted });
    };
    function text() {
      const m = MATS[mi], s = +sS.value, nm = tx(m.en, m.zh), Gc = m.E / (2 * (1 + m.nu)), dev = (Gc - m.G) / m.G * 100;
      $('#el-s-v').textContent = `${s} MPa`;
      const rule = tx(`<p class="note">E / 2(1 + ν) = ${m.E} / ${(2 * (1 + m.nu)).toFixed(2)} = <b>${Gc.toFixed(1)} GPa</b>, against a measured G of ${m.G} GPa (${dev >= 0 ? '+' : '−'}${Math.abs(dev).toFixed(0)}%).${Math.abs(dev) > 5 ? ' The rule assumes an isotropic material; this table value was measured separately and does not follow it closely.' : ''}</p>`,
        `<p class="note">E / 2(1 + ν) = ${m.E} / ${(2 * (1 + m.nu)).toFixed(2)} = <b>${Gc.toFixed(1)} GPa</b>，實測 G 為 ${m.G} GPa（${dev >= 0 ? '+' : '−'}${Math.abs(dev).toFixed(0)}%）。${Math.abs(dev) > 5 ? '這條關係假設材料等向；表上這個值是另外量的，沒有很貼近它。' : ''}</p>`);
      if (mode === 'ten') {
        const e = s / (m.E * 1000);
        info.innerHTML = tx(`<h4>${nm} in tension</h4><div class="eq">ε = σ / E = ${s} MPa / ${m.E} GPa</div>
          <dl class="stats"><dt>Axial strain ε</dt><dd>${(e * 100).toFixed(3)} %</dd><dt>Lateral strain −νε</dt><dd>−${(m.nu * e * 100).toFixed(3)} %</dd><dt>Volume change ε(1 − 2ν)</dt><dd>+${(e * (1 - 2 * m.nu) * 100).toFixed(3)} %</dd><dt>A 100 mm bar grows by</dt><dd>${(e * 100).toFixed(3)} mm</dd></dl>`,
          `<h4>${nm}，拉伸</h4><div class="eq">ε = σ / E = ${s} MPa / ${m.E} GPa</div>
          <dl class="stats"><dt>軸向應變 ε</dt><dd>${(e * 100).toFixed(3)} %</dd><dt>橫向應變 −νε</dt><dd>−${(m.nu * e * 100).toFixed(3)} %</dd><dt>體積變化 ε(1 − 2ν)</dt><dd>+${(e * (1 - 2 * m.nu) * 100).toFixed(3)} %</dd><dt>100 mm 的棒子伸長</dt><dd>${(e * 100).toFixed(3)} mm</dd></dl>`) + rule;
      } else {
        const gm = s / (m.G * 1000);
        info.innerHTML = tx(`<h4>${nm} in shear</h4><div class="eq">γ = τ / G = ${s} MPa / ${m.G} GPa</div>
          <dl class="stats"><dt>Shear strain γ = tan θ</dt><dd>${(gm * 100).toFixed(3)} %</dd><dt>Angle θ</dt><dd>${(Math.atan(gm) / D2R).toFixed(3)}°</dd></dl>`,
          `<h4>${nm}，剪切</h4><div class="eq">γ = τ / G = ${s} MPa / ${m.G} GPa</div>
          <dl class="stats"><dt>剪應變 γ = tan θ</dt><dd>${(gm * 100).toFixed(3)} %</dd><dt>角度 θ</dt><dd>${(Math.atan(gm) / D2R).toFixed(3)}°</dd></dl>`) + rule;
      }
    }
    sS.addEventListener('input', () => { v.rebuild(); text(); });
    seg($('#el-m'), m => { mode = m; v.rebuild(); text(); });
    seg($('#el-mat'), m => { mi = +m; v.rebuild(); text(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 3.6); });
    text(); onLang(() => { text(); v.rebuild(); });
  }

  /* =====================================================================
     03 Stress–strain curves traced from the slides (2D)
     ===================================================================== */
  const SPEC = {
    alT: { en: 'Al 2024, tempered', zh: 'Al 2024，調質', E: 72.4, sp: 330, pts: [[0.008, 372], [0.015, 405], [0.03, 440], [0.06, 475], [0.1, 500], [0.15, 513], [0.175, 516], [0.2, 508], [0.212, 498]] },
    alA: { en: 'Al 2024, annealed', zh: 'Al 2024，退火', E: 72.4, sp: 85, pts: [[0.004, 112], [0.01, 133], [0.03, 165], [0.06, 192], [0.1, 208], [0.15, 218], [0.19, 221], [0.22, 215], [0.245, 203]] },
    stC: { en: '1018 steel, cold rolled', zh: '1018 鋼，冷軋', E: 200, sp: 680, pts: [[0.008, 790], [0.015, 835], [0.025, 852], [0.04, 846], [0.06, 800], [0.08, 735], [0.1, 665], [0.108, 625]] },
    stA: { en: '1018 steel, annealed', zh: '1018 鋼，退火', E: 200, sp: 420, pts: [[0.005, 412], [0.012, 410], [0.02, 428], [0.03, 500], [0.05, 590], [0.08, 655], [0.12, 690], [0.16, 700], [0.2, 698], [0.24, 680], [0.265, 645], [0.27, 630]] }
  };
  Object.values(SPEC).forEach(s => {
    const e0 = s.sp / (s.E * 1000), f = mono([[e0, s.sp], ...s.pts]);
    s.ef = s.pts[s.pts.length - 1][0];
    s.f = e => (e <= e0 ? s.E * 1000 * e : f(e));
    let lo = 0.002, hi = s.ef; for (let e = 0.0021; e < s.ef; e += 0.0002) if (s.f(e) < s.E * 1000 * (e - 0.002)) { hi = e; break; } else lo = e;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (s.f(m) > s.E * 1000 * (m - 0.002)) lo = m; else hi = m; }
    s.ey = lo; s.sy = s.f(lo);
    s.eu = 0; s.su = 0; for (let e = 0; e <= s.ef; e += s.ef / 2000) { const v = s.f(e); if (v > s.su) { s.su = v; s.eu = e; } }
  });
  function secSS() {
    const eS = $('#ss-e'), playB = $('#ss-play'), info = $('#ss-info');
    let key = 'alT', prog = +eS.value, playing = !REDUCED, hold = 0, vis = false, prev = 0;

    function drawSpecimen(x, bx, by, bw, bh, s, e, sig) {
      x.save();
      x.fillStyle = T.surface; x.globalAlpha = 0.35; x.fillRect(bx, by, bw, bh); x.globalAlpha = 1;
      x.strokeStyle = T.line; x.lineWidth = 1; x.strokeRect(bx, by, bw, bh);
      x.beginPath(); x.rect(bx + 1, by + 1, bw - 2, bh - 2); x.clip();

      const cy = by + bh * 0.56, gripW = Math.min(20, bw * 0.06), shW = Math.min(18, bw * 0.05);
      const L0 = Math.min(280, Math.max(52, (bw - 26 - 58 - 2 * (gripW + shW)) / 1.62));
      const L = L0 * (1 + e * 2.0);
      const rGrip = bh * 0.24, r0 = bh * 0.14, rU = r0 / Math.sqrt(1 + e);
      const nf = e > s.eu ? Math.min(1, (e - s.eu) / Math.max(1e-6, s.ef - s.eu)) : 0;
      const broken = e >= s.ef - 1e-9, gap = broken ? 9 : 0;
      const gx0 = bx + Math.max(18, (bw - L0 * 1.56 - 2 * (gripW + shW) - 56) / 2);
      const xL0 = gx0 + gripW, xG0 = xL0 + shW, xG1 = xG0 + L, xR1 = xG1 + shW, xGripR = xR1 + gripW;
      const neckAt = u => 1 - 0.52 * nf * Math.exp(-(((u - 0.5) / 0.11) ** 2));
      const rMid = rU * neckAt(0.5);

      const tracePiece = (u0, u1, side) => {
        x.beginPath();
        if (side <= 0) {
          x.moveTo(xL0 - gripW, cy - rGrip); x.lineTo(xL0, cy - rGrip);
          for (let i = 1; i <= 10; i++) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xL0 + t * shW, cy - (rGrip + (rU - rGrip) * k)); }
          for (let i = 1; i <= 36; i++) { const u = u0 + (u1 - u0) * i / 36; x.lineTo(xG0 + u * L + (side < 0 && i === 36 ? -2 : 0), cy - rU * neckAt(u)); }
        } else {
          x.moveTo(xG0 + u0 * L + gap - 2, cy - rMid);
          for (let i = 1; i <= 36; i++) { const u = u0 + (u1 - u0) * i / 36; x.lineTo(xG0 + u * L + gap, cy - rU * neckAt(u)); }
          for (let i = 1; i <= 10; i++) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xG1 + gap + t * shW, cy - (rU + (rGrip - rU) * k)); }
          x.lineTo(xGripR + gap, cy - rGrip); x.lineTo(xGripR + gap, cy + rGrip);
          for (let i = 10; i >= 0; i--) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xG1 + gap + t * shW, cy + (rU + (rGrip - rU) * k)); }
          for (let i = 36; i >= 0; i--) { const u = u0 + (u1 - u0) * i / 36; x.lineTo(xG0 + u * L + gap + (i === 0 ? 2 : 0), cy + rU * neckAt(u)); }
          x.closePath(); return;
        }
        if (side === 0) {
          for (let i = 1; i <= 10; i++) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xG1 + t * shW, cy - (rU + (rGrip - rU) * k)); }
          x.lineTo(xGripR, cy - rGrip); x.lineTo(xGripR, cy + rGrip);
          for (let i = 10; i >= 0; i--) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xG1 + t * shW, cy + (rU + (rGrip - rU) * k)); }
        } else {
          x.lineTo(xG0 + u1 * L + 2, cy + rMid);
        }
        for (let i = 36; i >= 0; i--) { const u = u0 + (u1 - u0) * i / 36; x.lineTo(xG0 + u * L, cy + rU * neckAt(u)); }
        for (let i = 10; i >= 0; i--) { const t = i / 10, k = smooth(0, 1, t); x.lineTo(xL0 + t * shW, cy + (rGrip + (rU - rGrip) * k)); }
        x.lineTo(xL0 - gripW, cy + rGrip); x.closePath();
      };

      const paintPiece = (u0, u1, side) => {
        tracePiece(u0, u1, side);
        x.fillStyle = COL.corner; x.globalAlpha = 0.82; x.fill(); x.globalAlpha = 1;
        if (nf > 0.04) {
          x.save(); tracePiece(u0, u1, side); x.clip();
          x.fillStyle = T.hi; x.globalAlpha = 0.45 * nf;
          x.fillRect(xG0 + 0.36 * L, cy - rU - 2, 0.28 * L + gap, 2 * rU + 4);
          x.restore();
        }
        tracePiece(u0, u1, side);
        x.strokeStyle = COL.corner; x.lineWidth = 1.5; x.stroke();
      };
      if (!broken) paintPiece(0, 1, 0);
      else {
        paintPiece(0, 0.5, -1); paintPiece(0.5, 1, 1);
        x.strokeStyle = T.hi; x.lineWidth = 1.8; x.beginPath();
        x.moveTo(xG0 + 0.5 * L - 2, cy - rMid); x.lineTo(xG0 + 0.5 * L + 2, cy + rMid);
        x.moveTo(xG0 + 0.5 * L + gap - 2, cy - rMid); x.lineTo(xG0 + 0.5 * L + gap + 2, cy + rMid);
        x.stroke();
      }

      const jaw = (xa, xb) => {
        x.fillStyle = T.edge3d; x.globalAlpha = 0.72;
        x.fillRect(xa, cy - rGrip - 6, xb - xa, 6); x.fillRect(xa, cy + rGrip, xb - xa, 6);
        x.globalAlpha = 1;
      };
      jaw(gx0, xL0); jaw(xR1 + gap, xGripR + gap);
      x.strokeStyle = T.muted; x.lineWidth = 2; x.beginPath(); x.moveTo(gx0, cy - rGrip - 8); x.lineTo(gx0, cy + rGrip + 8); x.stroke();

      x.setLineDash([3, 3]); x.strokeStyle = T.muted; x.lineWidth = 1; x.beginPath();
      x.moveTo(xG0, by + 18); x.lineTo(xG0, by + bh - 12);
      x.moveTo(xG0 + L0, cy + r0 + 2); x.lineTo(xG0 + L0, by + bh - 12);
      x.stroke(); x.setLineDash([]);
      const yL = by + 22, yL0 = by + bh - 12;
      x.strokeStyle = T.ink; x.lineWidth = 1.2; x.beginPath();
      x.moveTo(xG0, yL - 4); x.lineTo(xG0, yL + 4); x.moveTo(xG1 + gap, yL - 4); x.lineTo(xG1 + gap, yL + 4);
      x.moveTo(xG0, yL); x.lineTo(xG1 + gap, yL); x.stroke();
      x.font = FONT(600, 10); x.fillStyle = T.ink; x.textAlign = 'center';
      x.fillText(e > 0.002 ? 'ℓ' : 'ℓ = ℓ₀', (xG0 + xG1 + gap) / 2, yL - 5);
      x.strokeStyle = T.muted; x.lineWidth = 1; x.beginPath(); x.moveTo(xG0, yL0); x.lineTo(xG0 + L0, yL0); x.stroke();
      x.fillStyle = T.muted; x.font = FONT(500, 9); x.fillText('ℓ₀', xG0 + L0 / 2, yL0 - 3);

      if (!broken && sig > 5) {
        const ax0 = xGripR + 5, aLen = 12 + 34 * Math.min(1, sig / 1000);
        arrow2d(x, ax0, cy, ax0 + aLen, cy, COL.body, 2.4);
        x.font = FONT(700, 11); x.fillStyle = COL.body; x.textAlign = 'center';
        x.fillText('F', ax0 + aLen / 2, cy - 8);
      }

      const stg = e <= s.sp / (s.E * 1000) ? tx('elastic', '彈性') : e < s.eu ? tx('uniform plastic', '均勻塑性變形') : !broken ? tx('necking', '頸縮') : tx('fractured', '斷裂');
      x.font = FONT(600, 10); x.fillStyle = broken || nf > 0 ? T.hi : T.muted; x.textAlign = 'right';
      x.fillText(stg, bx + bw - 8, by + 16);
      x.restore();
    }

    function paint(x, W, H) {
      blank(x, W, H);
      const s = SPEC[key], EM = 0.29, SM = 1000, e = s.ef * (+eS.value) / 1000, sig = s.f(e);
      const topH = W < 460 ? 92 : 106, ml = 48, mr = 14, mt = topH + 20, mb = 36;
      drawSpecimen(x, ml, 6, W - ml - mr, topH, s, e, sig);

      const X = q => ml + q / EM * (W - ml - mr), Y = v => mt + (1 - v / SM) * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted;
      x.textAlign = 'right'; for (let v = 0; v <= SM; v += 200) { x.beginPath(); x.moveTo(ml, Y(v)); x.lineTo(W - mr, Y(v)); x.stroke(); x.fillText(v, ml - 6, Y(v) + 3); }
      x.textAlign = 'center'; for (let q = 0; q <= 0.2801; q += 0.05) { x.beginPath(); x.moveTo(X(q), mt); x.lineTo(X(q), H - mb); x.stroke(); x.fillText(q.toFixed(2), X(q), H - mb + 14); }
      axisLabel(x, tx('strain ε', '應變 ε'), (ml + W - mr) / 2, H - 6);
      axisLabel(x, tx('stress (MPa)', '應力（MPa）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
      x.save(); x.beginPath(); x.rect(ml, mt, W - ml - mr, H - mt - mb); x.clip();
      // other specimens, faint
      Object.entries(SPEC).forEach(([k, o]) => {
        if (k === key) return;
        x.strokeStyle = T.edge3d; x.globalAlpha = 0.45; x.lineWidth = 1; x.beginPath();
        for (let i = 0; i <= 300; i++) { const q = o.ef * i / 300; i ? x.lineTo(X(q), Y(o.f(q))) : x.moveTo(X(q), Y(o.f(q))); }
        x.stroke(); x.globalAlpha = 1;
      });
      // true curve up to necking
      x.strokeStyle = COL.plane; x.lineWidth = 1.8; x.setLineDash([5, 3]); x.beginPath();
      for (let i = 0; i <= 200; i++) { const q = s.eu * i / 200, st = s.f(q) * (1 + q), et = Math.log(1 + q); i ? x.lineTo(X(et), Y(st)) : x.moveTo(X(et), Y(st)); }
      x.stroke(); x.setLineDash([]);
      // engineering curve
      x.strokeStyle = COL.corner; x.lineWidth = 2.4; x.beginPath();
      for (let i = 0; i <= 600; i++) { const q = s.ef * i / 600; i ? x.lineTo(X(q), Y(s.f(q))) : x.moveTo(X(q), Y(s.f(q))); }
      x.lineTo(X(s.ef), Y(s.f(s.ef) * 0.55)); x.stroke();
      // 0.2% offset line and the yield point it gives
      x.strokeStyle = COL.body; x.lineWidth = 1.5; x.beginPath(); x.moveTo(X(0.002), Y(0)); x.lineTo(X(s.ey + 0.004), Y(s.E * 1000 * (s.ey + 0.002))); x.stroke();
      x.restore();
      x.fillStyle = COL.body; x.beginPath(); x.arc(X(s.ey), Y(s.sy), 4, 0, 7); x.fill();
      // UTS
      x.fillStyle = COL.corner; x.beginPath(); x.arc(X(s.eu), Y(s.su), 4, 0, 7); x.fill();
      x.font = FONT(600, 11); x.textAlign = 'center'; x.fillStyle = T.ink; x.fillText('UTS', X(s.eu), Y(s.su) - 9);
      // current point
      x.fillStyle = T.hi; x.beginPath(); x.arc(X(e), Y(sig), 6, 0, 7); x.fill();
      // inset: first 1.2 % with the 0.2 % offset construction
      const ix = X(0.216) + 2, iy = Y(620), iw = W - mr - 6 - ix, ih = Y(250) - iy, IE = 0.012;
      if (iw < 130) return;
      const IX = q => ix + 8 + q / IE * (iw - 20), IY = v => iy + 18 + (1 - v / SM) * (ih - 34);
      x.fillStyle = T.stage; x.strokeStyle = T.line; x.lineWidth = 1; x.fillRect(ix, iy, iw, ih); x.strokeRect(ix, iy, iw, ih);
      x.font = MFONT(400, 9); x.fillStyle = T.muted; x.textAlign = 'center';
      [0, 0.004, 0.008, 0.012].forEach(q => x.fillText((q * 100).toFixed(1) + '%', IX(q), iy + ih - 6));
      x.save(); x.beginPath(); x.rect(ix + 1, iy + 1, iw - 2, ih - 2); x.clip();
      x.strokeStyle = COL.body; x.lineWidth = 1.5; x.beginPath(); x.moveTo(IX(0.002), IY(0)); x.lineTo(IX(0.002 + SM / (s.E * 1000)), IY(SM)); x.stroke();
      x.strokeStyle = COL.corner; x.lineWidth = 2; x.beginPath();
      for (let i = 0; i <= 200; i++) { const q = IE * i / 200; i ? x.lineTo(IX(q), IY(s.f(q))) : x.moveTo(IX(q), IY(s.f(q))); }
      x.stroke(); x.restore();
      x.fillStyle = COL.body; x.beginPath(); x.arc(IX(s.ey), IY(s.sy), 4, 0, 7); x.fill();
      x.font = FONT(600, 10); x.fillStyle = T.ink; x.textAlign = 'left';
      x.fillText(tx('0.2% offset → σy', '0.2% 偏移 → σy'), ix + 6, iy + 13);
    }
    function text() {
      const s = SPEC[key], e = s.ef * +eS.value / 1000, sig = s.f(e);
      $('#ss-e-v').textContent = `${(e * 100).toFixed(1)} %`;
      const stage = e <= s.sp / (s.E * 1000) ? tx('elastic', '彈性') : e < s.ey ? tx('elastic → plastic', '彈性 → 塑性') : e < s.eu ? tx('uniform plastic deformation', '均勻塑性變形') : e < s.ef - 1e-9 ? tx('necking', '頸縮') : tx('fractured', '斷裂');
      const tru = e <= s.eu ? `${(sig * (1 + e)).toFixed(0)} MPa · ε<sub>t</sub> = ${Math.log(1 + e).toFixed(3)}` : tx('not valid after necking', '頸縮後不適用');
      info.innerHTML = tx(`<h4>${s.en}</h4><table class="mini"><tbody>
          <tr><td>E (slope)</td><td class="num">${s.E} GPa</td></tr><tr><td>0.2% offset yield σ<sub>y</sub></td><td class="num">${s.sy.toFixed(0)} MPa</td></tr>
          <tr><td>UTS</td><td class="num">${s.su.toFixed(0)} MPa</td></tr><tr><td>Elongation at fracture</td><td class="num">${(s.ef * 100).toFixed(0)} %</td></tr></tbody></table>
          <dl class="stats"><dt>Now</dt><dd>ε = ${(e * 100).toFixed(1)} %, σ = ${sig.toFixed(0)} MPa</dd><dt>Stage</dt><dd>${stage}</dd><dt>True stress</dt><dd>${tru}</dd></dl>`,
        `<h4>${s.zh}</h4><table class="mini"><tbody>
          <tr><td>E（斜率）</td><td class="num">${s.E} GPa</td></tr><tr><td>0.2% 偏移降伏強度 σ<sub>y</sub></td><td class="num">${s.sy.toFixed(0)} MPa</td></tr>
          <tr><td>UTS</td><td class="num">${s.su.toFixed(0)} MPa</td></tr><tr><td>斷裂伸長率</td><td class="num">${(s.ef * 100).toFixed(0)} %</td></tr></tbody></table>
          <dl class="stats"><dt>目前</dt><dd>ε = ${(e * 100).toFixed(1)} %，σ = ${sig.toFixed(0)} MPa</dd><dt>階段</dt><dd>${stage}</dd><dt>真應力</dt><dd>${tru}</dd></dl>`);
    }
    function syncBtn() {
      playB.textContent = playing ? tx('Pause', '暫停') : tx('Play', '播放');
      playB.setAttribute('aria-pressed', String(playing));
    }
    const cv = $('#ss-cv'), draw = canvas2d(cv, paint);
    eS.addEventListener('input', () => { prog = +eS.value; playing = false; hold = 0; syncBtn(); draw(); text(); });
    playB.addEventListener('click', () => { playing = !playing; if (playing && prog >= 999) { prog = 0; eS.value = 0; hold = 0; } syncBtn(); draw(); text(); });
    seg($('#ss-m'), k => { key = k; hold = 0; draw(); text(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { vis = es[0].isIntersecting; }).observe(cv); else vis = true;
    const step = now => {
      if (vis && playing && prev) {
        const dt = Math.min(0.1, (now - prev) / 1000);
        if (prog >= 1000) {
          hold += dt;
          if (hold >= 1.4) { hold = 0; prog = 0; eS.value = 0; draw(); text(); }
        } else {
          prog = Math.min(1000, prog + 1000 * dt / 6.0);
          eS.value = Math.round(prog); draw(); text();
        }
      }
      prev = now; requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    syncBtn(); text(); onLang(() => { syncBtn(); text(); });
    return () => draw();
  }

  /* =====================================================================
     04 Rockwell test in three steps (2D) and the Vickers chart
     ===================================================================== */
  const RW = { A: { ind: 'cone', F0: 10, F1: 50, E: 100 }, B: { ind: 'b16', F0: 10, F1: 90, E: 130 }, C: { ind: 'cone', F0: 10, F1: 140, E: 100 }, E: { ind: 'b8', F0: 10, F1: 90, E: 130 } };
  function secHD() {
    const dS = $('#hd-d'), info = $('#hd-info'); let sc = 'A';
    function paint(x, W, H) {
      blank(x, W, H);
      const r = RW[sc], e = +dS.value, pw = W / 3, PX = 380, kk = Math.min(1, pw / 190), BR = { b16: 34 * kk, b8: 50 * kk }, CW = 69 * kk; // PX: px per mm
      const d0 = 0.03, rec = 0.25 * e + 0.01, depths = [d0, d0 + e + rec, d0 + e];
      const steps = [tx('1 · minor load F₀', '1・初負載 F₀'), tx('2 · F₀ + major load F₁', '2・F₀ + 主負載 F₁'), tx('3 · F₁ removed', '3・卸除 F₁')];
      const loads = [r.F0, r.F0 + r.F1, r.F0];
      for (let i = 0; i < 3; i++) {
        const cx = pw * i + pw / 2, y0 = Math.round(H * 0.5) + 6, dep = depths[i] * PX, half = Math.min(pw * 0.42, 120);
        const surf = q => { // surface profile under the indenter after this step
          if (r.ind === 'cone') return y0 + Math.max(0, dep - Math.abs(q) * 0.58);
          const R = BR[r.ind], z = R * R - q * q; return y0 + (z > 0 ? Math.max(0, dep - (R - Math.sqrt(z))) : 0);
        };
        x.fillStyle = COL.corner; x.globalAlpha = 0.3; x.beginPath(); x.moveTo(cx - half, H - 30);
        for (let q = -half; q <= half; q += 1) x.lineTo(cx + q, surf(q));
        x.lineTo(cx + half, H - 30); x.closePath(); x.fill(); x.globalAlpha = 1;
        x.strokeStyle = COL.corner; x.lineWidth = 1.6; x.beginPath(); for (let q = -half; q <= half; q += 1) q === -half ? x.moveTo(cx + q, surf(q)) : x.lineTo(cx + q, surf(q)); x.stroke();
        // indenter: in contact at steps 1–2, lifted to the remaining dent at step 3
        const tip = y0 + dep;
        x.fillStyle = T.edge3d; x.globalAlpha = 0.85; x.beginPath();
        if (r.ind === 'cone') { x.moveTo(cx, tip); x.lineTo(cx - CW, tip - CW * 0.58); x.lineTo(cx + CW, tip - CW * 0.58); x.closePath(); }
        else x.arc(cx, tip - BR[r.ind], BR[r.ind], 0, 7);
        x.fill(); x.globalAlpha = 1;
        // load arrow
        const len = 10 + loads[i] * 0.28, topY = tip - (r.ind === 'cone' ? CW * 0.58 : 2 * BR[r.ind]) - 4; arrow2d(x, cx, topY - len, cx, topY, COL.body, 2.5);
        x.font = MFONT(500, 10); x.fillStyle = COL.body; x.textAlign = 'left'; x.fillText(`${loads[i]} kgf`, cx + 8, topY - len / 2);
        // zero reference set by the minor load
        x.setLineDash([3, 3]); x.strokeStyle = T.muted; x.lineWidth = 1; x.beginPath(); x.moveTo(cx - half, y0 + d0 * PX); x.lineTo(cx + half, y0 + d0 * PX); x.stroke(); x.setLineDash([]);
        if (i === 2 && e > 0) {
          x.strokeStyle = T.hi; x.lineWidth = 2; x.beginPath(); x.moveTo(cx + half * 0.55, y0 + d0 * PX); x.lineTo(cx + half * 0.55, y0 + (d0 + e) * PX); x.stroke();
          x.beginPath(); x.moveTo(cx + half * 0.55 - 5, y0 + d0 * PX); x.lineTo(cx + half * 0.55 + 5, y0 + d0 * PX); x.moveTo(cx + half * 0.55 - 5, y0 + (d0 + e) * PX); x.lineTo(cx + half * 0.55 + 5, y0 + (d0 + e) * PX); x.stroke();
          x.fillStyle = T.hi; x.font = FONT(600, 11); x.textAlign = 'left'; x.fillText('Δd', cx + half * 0.55 + 7, y0 + (d0 + e / 2) * PX + 4);
        }
        x.fillStyle = T.ink; x.font = FONT(600, 11); x.textAlign = 'center'; x.fillText(steps[i], cx, 16);
      }
      x.fillStyle = T.muted; x.font = FONT(500, 10); x.textAlign = 'left'; x.fillText(tx('dashed: zero set by F₀ · depths drawn ×380', '虛線：F₀ 定出的零點・深度放大 380 倍'), 8, H - 10);
    }
    function text() {
      const r = RW[sc], e = +dS.value, n = Math.round(e / 0.002), hr = r.E - n;
      const ind = { cone: tx('diamond cone', '鑽石圓錐'), b16: tx('1/16" steel ball', '1/16" 鋼球'), b8: tx('1/8" steel ball', '1/8" 鋼球') }[r.ind];
      $('#hd-d-v').textContent = `${e.toFixed(3)} mm`;
      info.innerHTML = tx(`<div class="eq">HR${sc} = E − Δd / 0.002 = ${r.E} − ${e.toFixed(3)} / 0.002 = <b>${hr}</b></div>
        <table class="mini"><tbody><tr><td>Indenter</td><td class="num">${ind}</td></tr><tr><td>F<sub>0</sub> + F<sub>1</sub> = F</td><td class="num">${r.F0} + ${r.F1} = ${r.F0 + r.F1} kgf</td></tr><tr><td>E</td><td class="num">${r.E}</td></tr></tbody></table>
        <p class="note">${hr < 0 ? 'Below zero: the dent is too deep for this scale. Use a softer scale, such as a ball instead of the cone.' : 'Try 0.076 mm on scale A (HRA 62) and 0.060 mm on scale B (HRB 100), the two examples on the slide.'}</p>`,
        `<div class="eq">HR${sc} = E − Δd / 0.002 = ${r.E} − ${e.toFixed(3)} / 0.002 = <b>${hr}</b></div>
        <table class="mini"><tbody><tr><td>壓頭</td><td class="num">${ind}</td></tr><tr><td>F<sub>0</sub> + F<sub>1</sub> = F</td><td class="num">${r.F0} + ${r.F1} = ${r.F0 + r.F1} kgf</td></tr><tr><td>E</td><td class="num">${r.E}</td></tr></tbody></table>
        <p class="note">${hr < 0 ? '低於零：對這個尺度來說壓痕太深了。改用較軟材料用的尺度，例如用鋼球代替圓錐。' : '試試 A 尺度 0.076 mm（HRA 62）和 B 尺度 0.060 mm（HRB 100），就是投影片上的兩個例子。'}</p>`);
    }
    const draw = canvas2d($('#hd-cv'), paint);
    dS.addEventListener('input', () => { draw(); text(); });
    seg($('#hd-s'), s => { sc = s; draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }
  const HV = [
    ['Sn', '錫', 5, 0], ['Polypropylene', '聚丙烯', 7, 2], ['Polycarbonate', '聚碳酸酯', 14, 2], ['PVC', 'PVC', 16, 2], ['Al', '鋁', 25, 0], ['Au', '金', 35, 0], ['Cu', '銅', 40, 0],
    ['Epoxy', '環氧樹脂', 45, 2], ['Fe', '鐵', 80, 0], ['Mild steel', '軟鋼', 140, 0], ['Limestone', '石灰岩', 250, 1], ['MgO', 'MgO', 500, 1], ['Window glass', '窗玻璃', 550, 1],
    ['Granite', '花崗岩', 850, 1], ['Hardened steel', '硬化鋼', 900, 0], ['Quartz', '石英', 1200, 1], ['Al₂O₃', 'Al₂O₃', 2500, 1], ['WC', 'WC', 2500, 1]
  ];
  function secHV() {
    function paint(x, W, H) {
      blank(x, W, H);
      const ml = W < 480 ? 98 : 118, mr = 40, mt = 10, mb = 32, rowH = (H - mt - mb) / HV.length, L0 = 0, L1 = Math.log10(4000);
      const X = v => ml + (Math.log10(v) - L0) / (L1 - L0) * (W - ml - mr), cols = [COL.corner, COL.face, COL.body];
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted; x.textAlign = 'center';
      [1, 10, 100, 1000].forEach(v => { x.beginPath(); x.moveTo(X(v), mt); x.lineTo(X(v), H - mb); x.stroke(); x.fillText(v, X(v), H - mb + 14); });
      axisLabel(x, tx('Vickers hardness (log scale)', 'Vickers 硬度（對數尺度）'), (ml + W - mr) / 2, H - 4);
      HV.forEach(([en, zh, v, c], i) => {
        const y = mt + i * rowH;
        x.fillStyle = cols[c]; x.fillRect(X(1), y + rowH * 0.18, X(v) - X(1), rowH * 0.64);
        x.fillStyle = T.ink; x.font = FONT(500, 11); x.textAlign = 'right'; x.fillText(tx(en, zh), ml - 6, y + rowH * 0.66);
        x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'left'; x.fillText(v, X(v) + 4, y + rowH * 0.66);
      });
    }
    const draw = canvas2d($('#hv-cv'), paint);
    return () => draw();
  }

  /* =====================================================================
     05 Slip systems in FCC, BCC and HCP (3D)
     ===================================================================== */
  function secSlip() {
    const v = new Viewer($('#v-slip'), { view: [1, -0.62, 0.5], label: () => tx('A unit cell with one slip plane, slip directions, and sliding atoms animated', '一個單位晶胞，標出滑移面、滑移方向，並展示原子滑移動畫') });
    const kS = $('#sl-k'), famCtl = $('#sl-fam-ctl'), playB = $('#sl-play'), info = $('#sl-info');
    let xt = 'fcc', fam = '110', playing = !REDUCED, u = REDUCED ? 0.5 : 0, last = 0, movers = [];
    const A = 2.4, C0 = V3(-A / 2, -A / 2, -A / 2), P = (a, b, c) => V3(a * A, b * A, c * A).add(C0);
    const FCC_N = [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1]];
    const genFam = (a, b, c) => {
      const seen = new Set(), out = [], perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
      for (const p of perms) for (const s0 of [1, -1]) for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
        if ((p[0] === 0 && s0 < 0) || (p[1] === 0 && s1 < 0) || (p[2] === 0 && s2 < 0)) continue;
        let v = [p[0] * s0, p[1] * s1, p[2] * s2];
        const nz = v.find(x => x !== 0); if (nz < 0) v = v.map(x => -x);
        const key = v.join(','); if (!seen.has(key)) { seen.add(key); out.push(v); }
      }
      return out;
    };
    const BCC_FAM = {
      110: [[1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1]],
      211: genFam(2, 1, 1),
      321: genFam(3, 2, 1)
    };
    const DIAGS = [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1]];
    const HCP_P = [['(0001)', 'basal', '底面'], ['(10-10)', 'prism', '柱面'], ['(10-11)', 'pyramidal', '錐面']];
    const MAXK = { fcc: 3, hcp: 2 };
    function dirArrow(g, a, b) { const m = a.clone().lerp(b, 0.5), d = b.clone().sub(a).multiplyScalar(0.62); arrow(g, m, m.clone().add(d), 0.045, T.hi); arrow(g, m, m.clone().sub(d), 0.045, T.hi); }
    v.rebuild = () => {
      v.clear(); movers = [];
      const g = v.root, k = +kS.value, edge = mStd(T.edge3d, { opacity: 0.7 });
      const kAnim = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
      if (xt !== 'hcp') {
        cellEdges(g, C0, V3(A, 0, 0), V3(0, A, 0), V3(0, 0, A), 0.02, edge);
        const sites = []; for (const c of CUBE_V) sites.push([c.x, c.y, c.z]);
        if (xt === 'fcc') [[.5, .5, 0], [.5, .5, 1], [.5, 0, .5], [.5, 1, .5], [0, .5, .5], [1, .5, .5]].forEach(s => sites.push(s)); else sites.push([.5, .5, .5]);
        let signed, poly4, dirs;
        if (xt === 'fcc') {
          const n = FCC_N[k], c = n.map(s => (1 - s) / 2), nb = [0, 1, 2].map(i => { const q = c.slice(); q[i] = 1 - q[i]; return q; });
          const val = n[0] * nb[0][0] + n[1] * nb[0][1] + n[2] * nb[0][2];
          signed = s => n[0] * s[0] + n[1] * s[1] + n[2] * s[2] - val;
          poly4 = nb.map(q => P(...q)); dirs = [[0, 1], [1, 2], [2, 0]].map(([i, j]) => [poly4[i], poly4[j]]);
        } else {
          const n = BCC_FAM[fam][k], val = (n[0] + n[1] + n[2]) / 2;
          signed = s => n[0] * s[0] + n[1] * s[1] + n[2] * s[2] - val;
          const sl = slice(CUBE_V, CUBE_E, V3(...n), val);
          poly4 = sl.map(q => P(q.x, q.y, q.z));
          dirs = DIAGS.filter(d => n[0] * d[0] + n[1] * d[1] + n[2] * d[2] === 0)
            .map(d => [P((1 - d[0]) / 2, (1 - d[1]) / 2, (1 - d[2]) / 2), P((1 + d[0]) / 2, (1 + d[1]) / 2, (1 + d[2]) / 2)]);
        }
        const stepLen = xt === 'fcc' ? A * S2 / 2 : A * S3 / 2;
        const shiftVec = dirs[0][1].clone().sub(dirs[0][0]).normalize().multiplyScalar(0.45 * stepLen);
        const onList = [], posList = [], negList = [];
        sites.forEach(s => { const d = signed(s); if (Math.abs(d) < 1e-5) onList.push(s); else if (d > 0) posList.push(s); else negList.push(s); });
        const moveList = posList.length ? posList : negList, ghostList = posList.length ? negList : [];
        onList.forEach(s => atom(g, P(...s), 0.25, COL.corner));
        ghostList.forEach(s => atom(g, P(...s), 0.14, T.ghost3d, { opacity: 0.48 }));
        const tracks = [];
        moveList.forEach(s => {
          const base = P(...s), m = atom(g, base.clone().addScaledVector(shiftVec, kAnim), 0.22, COL.body);
          movers.push({ m, base, dir: shiftVec });
          tracks.push([base, base.clone().add(shiftVec)]);
        });
        if (tracks.length) dashed(g, tracks, COL.body, { dash: 0.06, gap: 0.04, opacity: 0.7 });
        poly(g, poly4, COL.plane, 0.3, true);
        dirs.forEach(([a, b]) => dirArrow(g, a, b));
      } else {
        const a = 1.5, c = 1.633 * a, hv = i => V3(a * Math.cos(i * Math.PI / 3), a * Math.sin(i * Math.PI / 3), 0), z0 = -c / 2;
        const top = [], bot = []; for (let i = 0; i < 6; i++) { bot.push(hv(i).setZ(z0)); top.push(hv(i).setZ(z0 + c)); }
        for (let i = 0; i < 6; i++) { rod(g, bot[i], bot[(i + 1) % 6], 0.02, edge); rod(g, top[i], top[(i + 1) % 6], 0.02, edge); rod(g, bot[i], top[i], 0.02, edge); }
        const mid = [0, 2, 4].map(i => V3(a / Math.sqrt(3) * Math.cos(i * Math.PI / 3 + Math.PI / 6), a / Math.sqrt(3) * Math.sin(i * Math.PI / 3 + Math.PI / 6), z0 + c / 2));
        const all = [...bot, ...top, V3(0, 0, z0), V3(0, 0, z0 + c), ...mid]; let pl, dirs;
        if (k === 0) { pl = top; dirs = [[top[0], top[3]], [top[1], top[4]], [top[2], top[5]]]; }
        else if (k === 1) { pl = [bot[0], bot[1], top[1], top[0]]; const m0 = bot[0].clone().lerp(top[0], 0.5), m1 = bot[1].clone().lerp(top[1], 0.5); dirs = [[m0, m1]]; }
        else { pl = [bot[0], bot[1], top[2], top[5]]; const m0 = bot[0].clone().lerp(top[5], 0.5), m1 = bot[1].clone().lerp(top[2], 0.5); dirs = [[m0, m1]]; }
        const hn = pl[1].clone().sub(pl[0]).cross(pl[2].clone().sub(pl[0])).normalize();
        if (k === 2 && hn.z < 0) hn.negate();
        const shiftVec = dirs[0][1].clone().sub(dirs[0][0]).normalize().multiplyScalar(0.45 * a);
        const onPts = [], posPts = [], negPts = [];
        all.forEach(p => { const d = p.clone().sub(pl[0]).dot(hn); if (Math.abs(d) < 1e-4) onPts.push(p); else if (d > 0) posPts.push(p); else negPts.push(p); });
        const movePts = posPts.length ? posPts : negPts, ghostPts = posPts.length ? negPts : [];
        onPts.forEach(p => atom(g, p, 0.24, COL.corner));
        ghostPts.forEach(p => atom(g, p, 0.13, T.ghost3d, { opacity: 0.48 }));
        const tracks = [];
        movePts.forEach(p => {
          const base = p.clone(), m = atom(g, base.clone().addScaledVector(shiftVec, kAnim), 0.2, COL.body);
          movers.push({ m, base, dir: shiftVec });
          tracks.push([base, base.clone().add(shiftVec)]);
        });
        if (tracks.length) dashed(g, tracks, COL.body, { dash: 0.06, gap: 0.04, opacity: 0.7 });
        poly(g, pl, COL.plane, 0.3, true);
        dirs.forEach(([p, q]) => dirArrow(g, p, q));
      }
    };
    function text() {
      const k = +kS.value;
      let name, rows, cur;
      if (xt === 'fcc') { name = idxHTML(FCC_N[k]); cur = 0; rows = [['{111}', '⟨1̄10⟩', '4 × 3 = 12']]; }
      else if (xt === 'bcc') { name = idxHTML(BCC_FAM[fam][k]); cur = ['110', '211', '321'].indexOf(fam); rows = [['{110}', '⟨1̄11⟩', '6 × 2 = 12'], ['{211}', '⟨1̄11⟩', '12 × 1 = 12'], ['{321}', '⟨1̄11⟩', '24 × 1 = 24']]; }
      else { name = tx(HCP_P[k][1], HCP_P[k][2]) + ' ' + HCP_P[k][0].replace('-1', '<span class="bar">1</span>'); cur = k; rows = [['{0001}', '⟨112̄0⟩', '1 × 3 = 3'], ['{101̄0}', '⟨112̄0⟩', '3 × 1 = 3'], ['{101̄1}', '⟨112̄0⟩', '6 × 1 = 6']]; }
      $('#sl-k-v').innerHTML = name;
      const tbl = `<table class="mini"><thead><tr><th>${tx('Plane', '滑移面')}</th><th>${tx('Direction', '方向')}</th><th>${tx('Systems', '系統數')}</th></tr></thead><tbody>` +
        rows.map((r, i) => `<tr${i === cur ? ' style="color:var(--hi);font-weight:600"' : ''}><td>${r[0]}</td><td>${r[1]}</td><td class="num">${r[2]}</td></tr>`).join('') + '</tbody></table>';
      const body = {
        fcc: tx('<p>Six atoms lie on this {111} plane, packed as tightly as possible: a close-packed plane. Its three edges are the ⟨1̄10⟩ close-packed directions. Step through the four planes: each carries three directions.</p>', '<p>這個 {111} 面上有六個原子，排得不能再密：這是最密堆積面。三條邊就是 ⟨1̄10⟩ 最密堆積方向。依序看四個面：每個面都有三個方向。</p>'),
        bcc: {
          110: tx('<p>The {110} plane holds four corner atoms and the body-center atom. It is the densest plane in BCC but not close-packed. Its two diagonals are the ⟨1̄11⟩ directions, along which the atoms touch. Six such planes × 2 = 12.</p>', '<p>{110} 面上有四個角落原子和體心原子。它是 BCC 最密的面，但不是密排面。兩條對角線是 ⟨1̄11⟩ 方向，原子沿著它彼此接觸。六個這樣的面 × 2 = 12。</p>'),
          211: tx('<p>A secondary {211} plane passes through the body center and one pair of opposite corners, carrying a single ⟨1̄11⟩ close-packed direction: 12 planes × 1 = 12 systems (active in αFe, Mo, W and Na).</p>', '<p>{211} 是 BCC 常見的次要滑移面：每個面通過體心與一對對角線原子，只含一條 ⟨1̄11⟩ 最密堆積滑移方向。12 個這樣的面 × 1 = 12 個系統（常見於 αFe、Mo、W、Na）。</p>'),
          321: tx('<p>The {321} family has 24 planes, each sharing one ⟨1̄11⟩ direction: 24 × 1 = 24 systems (active in αFe and K). Together BCC reaches 12 + 12 + 24 = 48 slip systems, all along ⟨1̄11⟩.</p>', '<p>{321} 也是 BCC 的次要滑移面，共有 24 個等效面，每個面各帶一條 ⟨1̄11⟩ 方向（24 × 1 = 24 個系統，見於 αFe 與 K）。BCC 合計 12 + 12 + 24 = 48 個滑移系統，全都沿 ⟨1̄11⟩。</p>')
        }[fam],
        hcp: [tx('<p>The basal plane is close-packed, with three ⟨112̄0⟩ directions. But there is only one such plane, so only 3 slip systems: Zn, Cd and Mg crack before they deform much.</p>', '<p>底面是最密堆積面，有三個 ⟨112̄0⟩ 方向。但這樣的面只有一個，只有 3 個滑移系統：Zn、Cd、Mg 變形不多就裂開。</p>'),
          tx('<p>A prism plane, one of the three side faces of the prism family, slipping along the ⟨112̄0⟩ edge direction: 3 × 1 = 3 more systems. Active in Ti, whose c/a is low.</p>', '<p>柱面：柱面家族三個側面之一，沿 ⟨112̄0⟩ 邊的方向滑移：再多 3 × 1 = 3 個系統。在 c/a 比低的 Ti 中會啟動。</p>'),
          tx('<p>A pyramidal plane runs from one bottom edge up through the middle of the top. With the same ⟨112̄0⟩ direction it adds 6 × 1 = 6 systems, which is why Ti and Mg can be more ductile than Zn.</p>', '<p>錐面從底面的一條邊往上穿過頂面中央。配上同樣的 ⟨112̄0⟩ 方向，再多 6 × 1 = 6 個系統，所以 Ti、Mg 的延性可以比 Zn 好。</p>')][k]
      }[xt];
      info.innerHTML = tbl + body;
    }
    function syncPlay() {
      playB.textContent = playing ? tx('Pause', '暫停') : tx('Play', '播放');
      playB.setAttribute('aria-pressed', String(playing));
    }
    v.anim = t => {
      if (!playing || !movers.length) { last = t; return; }
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t;
      u += dt / 3.6; if (u >= 1) u -= 1;
      const kAnim = 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
      for (const mv of movers) mv.m.position.copy(mv.base).addScaledVector(mv.dir, kAnim);
      v.dirty = true;
    };
    kS.addEventListener('input', () => { v.rebuild(); text(); });
    seg($('#sl-x'), x => {
      xt = x; famCtl.hidden = x !== 'bcc';
      kS.max = x === 'bcc' ? BCC_FAM[fam].length - 1 : MAXK[x];
      if (+kS.value > +kS.max) kS.value = 0;
      v.rebuild(); text();
    });
    seg($('#sl-fam'), f => {
      fam = f; kS.max = BCC_FAM[fam].length - 1;
      if (+kS.value > +kS.max) kS.value = 0;
      v.rebuild(); text();
    });
    playB.addEventListener('click', () => { playing = !playing; syncPlay(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 2.85); });
    syncPlay(); text(); onLang(() => { syncPlay(); text(); });
  }

  /* =====================================================================
     05-1 Edge vs screw dislocation slip animation (3D)
     ===================================================================== */
  function secDSlip() {
    const v = new Viewer($('#v-dslip'), { view: [0.55, -1, 0.45], label: () => tx('3D animation of an edge or screw dislocation gliding across a crystal under shear stress', '剪應力下刃差排或螺旋差排滑過晶體的 3D 動畫') });
    const modeEl = $('#ds-m'), playB = $('#ds-play'), uS = $('#ds-u'), info = $('#ds-info');
    const NX = 9, NY = 5, NZ = 6, TOT = NX * NY * NZ, MAX_BONDS = 720, DUR = 7.5;
    let mode = 'edge', u = REDUCED ? 0.5 : 0, playing = !REDUCED, last = 0, shown = -1;
    let hostM = null, coreM = null, bondAttr = null, bondGeo = null, slippedMesh = null, disRod = null;
    const xs = new Float32Array(TOT), bArr = new Float32Array(MAX_BONDS * 6), M4 = GL ? new THREE.Matrix4() : null;

    function update() {
      if (!hostM) return;
      const p = u < 0.1 ? 0 : u > 0.84 ? 1 : (u - 0.1) / 0.74;
      const fadeIn = smooth(0, 0.08, p), fadeOut = smooth(0.92, 1, p);
      const xd = -5.6 + 11.2 * p, yd = -3.4 + 6.8 * p;
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) {
        const x0 = i - 4, y0 = j - 2, z0 = k - 2.5, id = (i * NY + j) * NZ + k;
        let uxRaw;
        if (mode === 'edge') {
          const dx = x0 - xd, dz = z0, r2 = dx * dx + dz * dz, th = Math.atan2(dz, dx);
          uxRaw = (th + dx * dz / (2 * 0.7 * r2)) / (2 * Math.PI);
        } else {
          const dy = y0 - yd, dz = z0, th = Math.atan2(dz, dy);
          uxRaw = th / (2 * Math.PI);
        }
        xs[id] = x0 + uxRaw * fadeIn * (1 - fadeOut) + (z0 > 0 ? 0.5 : -0.5) * fadeOut;
      }
      let halfI = -1;
      if (mode === 'edge' && xd > -4.5 && xd < 4.5) {
        let best = 0.72;
        for (let i = 0; i < NX; i++) { const d = Math.abs(xs[(i * NY + 2) * NZ + 3] - xd); if (d < best) { best = d; halfI = i; } }
      }
      let hc = 0, cc = 0;
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) {
        const y0 = j - 2, z0 = k - 2.5, id = (i * NY + j) * NZ + k;
        const isCore = mode === 'edge' ? (halfI >= 0 && i === halfI && k >= 3) : (yd > -2.5 && yd < 2.5 && Math.abs(y0 - yd) < 0.75 && (k === 2 || k === 3));
        M4.makeScale(0.26, 0.26, 0.26); M4.setPosition(xs[id], y0, z0);
        if (isCore) coreM.setMatrixAt(cc++, M4); else hostM.setMatrixAt(hc++, M4);
      }
      hostM.count = hc; hostM.instanceMatrix.needsUpdate = true;
      coreM.count = cc; coreM.instanceMatrix.needsUpdate = true;

      let bi = 0;
      const pushBond = (i0, j0, k0, i1, j1, k1) => {
        const a = (i0 * NY + j0) * NZ + k0, b = (i1 * NY + j1) * NZ + k1;
        bArr[bi++] = xs[a]; bArr[bi++] = j0 - 2; bArr[bi++] = k0 - 2.5;
        bArr[bi++] = xs[b]; bArr[bi++] = j1 - 2; bArr[bi++] = k1 - 2.5;
      };
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) {
        if (i < NX - 1) pushBond(i, j, k, i + 1, j, k);
        if (j < NY - 1) pushBond(i, j, k, i, j + 1, k);
        if (k === 0 || k === 1 || k === 3 || k === 4) pushBond(i, j, k, i, j, k + 1);
      }
      for (let j = 0; j < NY; j++) for (let i2 = 0; i2 < NX; i2++) {
        const x2 = xs[(i2 * NY + j) * NZ + 2]; let bestI = -1, bestD = 0.68;
        for (let i3 = 0; i3 < NX; i3++) { const d = Math.abs(xs[(i3 * NY + j) * NZ + 3] - x2); if (d < bestD) { bestD = d; bestI = i3; } }
        if (bestI >= 0) pushBond(i2, j, 2, bestI, j, 3);
      }
      bondGeo.setDrawRange(0, bi / 3);
      bondAttr.needsUpdate = true;

      if (mode === 'edge') {
        const s = Math.min(4.5, Math.max(-4.5, xd)), w = s + 4.5;
        slippedMesh.visible = w > 0.01;
        if (slippedMesh.visible) { slippedMesh.scale.set(w, 5, 1); slippedMesh.position.set((-4.5 + s) / 2, 0, 0.002); }
        disRod.visible = xd >= -4.6 && xd <= 4.6;
        disRod.position.set(xd, 0, 0);
      } else {
        const s = Math.min(2.5, Math.max(-2.5, yd)), h = s + 2.5;
        slippedMesh.visible = h > 0.01;
        if (slippedMesh.visible) { slippedMesh.scale.set(9, h, 1); slippedMesh.position.set(0, (-2.5 + s) / 2, 0.002); }
        disRod.visible = yd >= -2.6 && yd <= 2.6;
        disRod.position.set(0, yd, 0);
      }
      uS.value = Math.round(u * 1000);
      v.dirty = true;
      stepText(false);
    }

    v.rebuild = () => {
      v.clear(); const g = v.root;
      hostM = new THREE.InstancedMesh(GEO.sphere, mStd(COL.corner), TOT); hostM.frustumCulled = false; g.add(hostM);
      coreM = new THREE.InstancedMesh(GEO.sphere, mStd(COL.body), TOT); coreM.frustumCulled = false; g.add(coreM);
      bondGeo = new THREE.BufferGeometry();
      bondAttr = new THREE.BufferAttribute(bArr, 3);
      bondGeo.setAttribute('position', bondAttr);
      const bondLines = new THREE.LineSegments(bondGeo, new THREE.LineBasicMaterial({ color: T.edge3d, transparent: true, opacity: 0.45 }));
      bondLines.frustumCulled = false; g.add(bondLines);
      poly(g, [V3(-4.5, -2.5, 0), V3(4.5, -2.5, 0), V3(4.5, 2.5, 0), V3(-4.5, 2.5, 0)], COL.plane, 0.12, true);
      slippedMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mBasic(COL.plane, { opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
      slippedMesh.renderOrder = 3; g.add(slippedMesh);
      disRod = new THREE.Mesh(GEO.cyl, mStd(T.hi));
      if (mode === 'edge') disRod.scale.set(0.075, 6, 0.075);
      else { disRod.scale.set(0.075, 10, 0.075); disRod.rotation.z = Math.PI / 2; }
      g.add(disRod);
      arrow(g, V3(-1.6, 0, 3.35), V3(1.6, 0, 3.35), 0.075, COL.body);
      label(g, 'τ', V3(1.9, 0, 3.35), { size: 0.34, color: COL.body });
      arrow(g, V3(1.6, 0, -3.35), V3(-1.6, 0, -3.35), 0.075, COL.body);
      if (mode === 'edge') {
        arrow(g, V3(-1.2, -3.35, 0), V3(1.2, -3.35, 0), 0.07, T.hi);
        label(g, tx('glide ∥ τ, b', '滑移 ∥ τ、b'), V3(0, -3.9, 0), { size: 0.28, color: T.hi });
      } else {
        arrow(g, V3(-5.35, -1.2, 0), V3(-5.35, 1.2, 0), 0.07, T.hi);
        label(g, tx('glide ⊥ τ, b', '滑移 ⊥ τ、b'), V3(-5.85, 0, 0.35), { size: 0.28, color: T.hi });
      }
      update();
    };

    function legend() {
      $('#ds-legend').innerHTML = mode === 'edge'
        ? tx('<span><i style="background:var(--c-corner)"></i>Crystal lattice</span><span><i style="background:var(--c-body)"></i>Extra half-plane &amp; τ</span><span><i class="sq" style="background:var(--c-plane)"></i>Slipped area</span><span><i class="sq" style="background:var(--hi)"></i>Dislocation line &amp; glide</span>',
          '<span><i style="background:var(--c-corner)"></i>晶格原子</span><span><i style="background:var(--c-body)"></i>多餘半原子面與剪應力 τ</span><span><i class="sq" style="background:var(--c-plane)"></i>已滑移區</span><span><i class="sq" style="background:var(--hi)"></i>差排線與滑移方向</span>')
        : tx('<span><i style="background:var(--c-corner)"></i>Crystal lattice</span><span><i style="background:var(--c-body)"></i>Screw core &amp; τ</span><span><i class="sq" style="background:var(--c-plane)"></i>Slipped area</span><span><i class="sq" style="background:var(--hi)"></i>Dislocation line &amp; glide</span>',
          '<span><i style="background:var(--c-corner)"></i>晶格原子</span><span><i style="background:var(--c-body)"></i>螺旋核心與剪應力 τ</span><span><i class="sq" style="background:var(--c-plane)"></i>已滑移區</span><span><i class="sq" style="background:var(--hi)"></i>差排線與滑移方向</span>');
    }

    function stepText(force) {
      const st = u < 0.1 ? 0 : u < 0.84 ? 1 : 2;
      if (!force && st === shown) return; shown = st;
      const stages = mode === 'edge' ? [
        [tx('Before slip', '滑移前'), tx('Shear stress τ pushes the top half right. The crystal has not slipped yet.', '剪應力 τ 推著上半部往右，但整排鍵結還沒錯開。')],
        [tx('Edge dislocation gliding', '刃差排滑移中'), tx('The extra half-plane shifts one bond row at a time from left to right, parallel to τ and b.', '多出的半原子面由左往右一次移一排，滑移方向平行於 τ 和 b。')],
        [tx('Slip step formed', '形成滑移台階'), tx('The dislocation has exited on the right, shifting the top half by 1 atomic spacing (b).', '差排從右端走出晶體，上半部相對下半部移了 1 個原子間距（b）。')]
      ] : [
        [tx('Before slip', '滑移前'), tx('The same shear stress τ acts toward the right, waiting to nucleate slip from the front edge.', '同樣向右的剪應力 τ 作用在晶體上，準備從前緣開始錯開。')],
        [tx('Screw dislocation gliding', '螺旋差排滑移中'), tx('The screw line sweeps from front to back, perpendicular to τ and b, shearing the lattice row by row.', '螺旋差排線由前往後掃過晶體，移動方向垂直於 τ 和 b，把晶格逐排剪開。')],
        [tx('Slip step formed', '形成滑移台階'), tx('The screw line has exited the back face, leaving the exact same 1-spacing step as the edge dislocation.', '螺旋差排線從背面走出晶體，留下和刃差排完全相同的 1 格滑移台階。')]
      ];
      const stats = mode === 'edge'
        ? tx('<dl class="stats"><dt>Line vs b</dt><dd>⊥ (90°)</dd><dt>Glide vs τ, b</dt><dd>∥ (left → right)</dd><dt>Net step</dt><dd>1 atomic spacing (b)</dd></dl>',
          '<dl class="stats"><dt>差排線 vs b</dt><dd>⊥（垂直，90°）</dd><dt>移動方向 vs τ、b</dt><dd>∥（由左往右）</dd><dt>最終滑移台階</dt><dd>1 個原子間距（b）</dd></dl>')
        : tx('<dl class="stats"><dt>Line vs b</dt><dd>∥ (0°)</dd><dt>Glide vs τ, b</dt><dd>⊥ (front → back)</dd><dt>Net step</dt><dd>1 atomic spacing (b)</dd></dl>',
          '<dl class="stats"><dt>差排線 vs b</dt><dd>∥（平行，0°）</dd><dt>移動方向 vs τ、b</dt><dd>⊥（由前往後）</dd><dt>最終滑移台階</dt><dd>1 個原子間距（b）</dd></dl>');
      info.innerHTML = `<p><b>${stages[st][0]}</b></p><p>${stages[st][1]}</p>${stats}`;
    }

    function controls() {
      playB.textContent = playing ? tx('Pause', '暫停') : tx('Play', '播放');
      playB.setAttribute('aria-pressed', String(playing));
      legend();
    }

    v.anim = t => {
      if (!playing) { last = t; return; }
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t;
      u += dt / DUR; if (u >= 1) u -= 1;
      update();
    };
    seg(modeEl, m => { mode = m; u = REDUCED ? 0.5 : 0; shown = -1; v.rebuild(); controls(); stepText(true); });
    uS.addEventListener('input', () => { playing = false; u = +uS.value / 1000; controls(); update(); });
    playB.addEventListener('click', () => { playing = !playing; controls(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 5.8); });
    controls(); stepText(true);
    onLang(() => { v.rebuild(); controls(); stepText(true); });
  }

  /* =====================================================================
     06 Schmid's law on a single-crystal rod (3D)
     ===================================================================== */
  const CRSS = [['Zn', 'HCP', '99.999', 0.18], ['Mg', 'HCP', '99.996', 0.77], ['Ag', 'FCC', '99.99', 0.48], ['Cu', 'FCC', '99.98', 0.94], ['Ti', 'HCP', '99.99', 13.7], ['Ti', 'HCP', '99.9', 90.1]];
  function secSchmid() {
    const v = new Viewer($('#v-schmid'), { view: [0.35, -1, 0.3], label: () => tx('A single-crystal rod pulled along its axis, with a tilted slip plane and a slip direction', '沿軸向拉伸的單晶棒，裡面有一個傾斜的滑移面和滑移方向') });
    const pS = $('#sc-p'), aS = $('#sc-a'), info = $('#sc-info'); let mi = 3;
    const R = 1, HH = 3.2;
    const geom = () => {
      const ph = Math.min(+pS.value, 89.9) * D2R, al = +aS.value * D2R;
      const n = V3(Math.sin(ph), 0, Math.cos(ph)), u = V3(Math.cos(ph), 0, -Math.sin(ph)), w = V3(0, 1, 0);
      let d = u.clone().multiplyScalar(Math.cos(al)).addScaledVector(w, Math.sin(al)); if (d.z < 0) d.negate();
      return { ph, n, d, cf: Math.cos(+pS.value * D2R), cl: d.z };
    };
    v.rebuild = () => {
      v.clear(); const g = v.root, { ph, n, d } = geom();
      // rod: open cylinder plus rims
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 2 * HH, 48, 1, true), mBasic(COL.corner, { opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      cyl.rotation.x = Math.PI / 2; g.add(cyl);
      [-HH, HH].forEach(z => { const pts = []; for (let i = 0; i <= 64; i++) { const t = i / 64 * 2 * Math.PI; pts.push(V3(R * Math.cos(t), R * Math.sin(t), z)); } path(g, pts, 0.02, mStd(COL.corner)); });
      // slip plane through the center, clipped to the rod
      const tn = Math.tan(ph), pts = [];
      const zAt = t => -tn * Math.cos(t);
      const at = (zc, tm) => { const xc = -zc / tn; return V3(xc, Math.sqrt(Math.max(0, R * R - xc * xc)) * (Math.sin(tm) >= 0 ? 1 : -1), zc); };
      for (let i = 0; i < 240; i++) {
        const t0 = i / 240 * 2 * Math.PI, t1 = (i + 1) / 240 * 2 * Math.PI, z0 = zAt(t0), z1 = zAt(t1), tm = (t0 + t1) / 2;
        if (Math.abs(z0) <= HH) pts.push(V3(R * Math.cos(t0), R * Math.sin(t0), z0));
        // where the segment enters or leaves the slab |z| <= HH (it may cross both caps when the plane is steep)
        [-HH, HH].map(zc => ({ zc, u: (zc - z0) / (z1 - z0) })).filter(c => c.u > 0 && c.u < 1).sort((a, b) => a.u - b.u).forEach(c => pts.push(at(c.zc, tm)));
      }
      poly(g, pts, COL.plane, 0.42, true);
      // normal, slip direction, axis, load
      arrow(g, V3(0, 0, 0), n.clone().multiplyScalar(2.1), 0.045, COL.plane);
      arrow(g, V3(0, 0, 0), d.clone().multiplyScalar(2.1), 0.055, T.hi); arrow(g, V3(0, 0, 0), d.clone().multiplyScalar(-1.2), 0.04, T.hi, { opacity: 0.6 });
      dashed(g, [[V3(0, 0, -HH - 0.3), V3(0, 0, HH + 0.3)]], T.edge3d);
      arrow(g, V3(0, 0, HH + 0.2), V3(0, 0, HH + 1.5), 0.08, COL.body); arrow(g, V3(0, 0, -HH - 0.2), V3(0, 0, -HH - 1.5), 0.08, COL.body);
      arc(g, V3(0, 0, 1), n, 1.5, COL.plane); arc(g, V3(0, 0, 1), d, 1.8, T.hi);
      label(g, 'Φ', V3(0, 0, 1).add(n).normalize().multiplyScalar(1.75), { size: 0.34, color: COL.plane });
      label(g, 'λ', V3(0, 0, 1).add(d).normalize().multiplyScalar(2.05), { size: 0.34, color: T.hi });
      label(g, 'F', V3(0.35, 0, HH + 1.3), { size: 0.36, color: COL.body });
    };
    function text() {
      const { cf, cl } = geom(), ph = +pS.value, lam = Math.acos(Math.min(1, cl)) / D2R, f = Math.abs(cf * cl), m = CRSS[mi];
      $('#sc-p-v').textContent = `${ph}°`; $('#sc-a-v').textContent = `λ = ${lam.toFixed(0)}°`;
      const sy = f > 1e-3 ? m[3] / f : Infinity, ys = isFinite(sy) ? `${sy < 10 ? sy.toFixed(2) : sy.toFixed(1)} MPa` : '∞';
      info.innerHTML = tx(`<div class="eq">cos λ cos Φ = ${Math.abs(cl).toFixed(3)} × ${cf.toFixed(3)} = <b>${f.toFixed(3)}</b></div>
        <dl class="stats"><dt>τ<sub>r</sub> for σ = 1 MPa</dt><dd>${f.toFixed(3)} MPa</dd><dt>CRSS of ${m[0]} (${m[1]}, ${m[2]}% pure)</dt><dd>${m[3]} MPa</dd><dt>Tensile stress to start slip, σ = CRSS / (cos λ cos Φ)</dt><dd>${ys}</dd></dl>
        <p class="note">${f < 1e-3 ? 'The factor is zero: no shear reaches this slip system, so the crystal cannot slip on it. It must use another system or break.' : f > 0.495 ? 'This is the maximum, 0.5, at Φ = λ = 45°: the easiest orientation.' : 'The slip direction lies in the plane, so λ can never be less than 90° − Φ. Find the orientation with the largest factor.'}</p>`,
        `<div class="eq">cos λ cos Φ = ${Math.abs(cl).toFixed(3)} × ${cf.toFixed(3)} = <b>${f.toFixed(3)}</b></div>
        <dl class="stats"><dt>σ = 1 MPa 時的 τ<sub>r</sub></dt><dd>${f.toFixed(3)} MPa</dd><dt>${m[0]}（${m[1]}，純度 ${m[2]}%）的 CRSS</dt><dd>${m[3]} MPa</dd><dt>開始滑移所需拉應力 σ = CRSS / (cos λ cos Φ)</dt><dd>${ys}</dd></dl>
        <p class="note">${f < 1e-3 ? '因子是零：沒有剪應力傳到這個滑移系統，晶體無法在上面滑移，只能改用別的系統，或直接斷裂。' : f > 0.495 ? '這就是最大值 0.5，發生在 Φ = λ = 45°：最容易滑移的方位。' : '滑移方向躺在面上，所以 λ 不可能小於 90° − Φ。找找看因子最大的方位。'}</p>`);
    }
    [pS, aS].forEach(s => s.addEventListener('input', () => { v.rebuild(); text(); }));
    seg($('#sc-m'), m => { mi = +m; text(); });
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 4.2); });
    text(); onLang(text);
  }

  /* =====================================================================
     07 Hall–Petch for Mg and Mg–Zn, and cold work (2D)
     ===================================================================== */
  // lines read off the slide's figure (Caceres et al. 2011): σ0 in MPa, k in MPa·m^½, data range in m^−½
  const HP = [
    { en: 'Mg', zh: 'Mg', s0: 12.7, k: 0.214, x0: 20, x1: 230, c: () => COL.corner },
    { en: 'Mg–0.4Zn', zh: 'Mg–0.4Zn', s0: 2.7, k: 0.368, x0: 58, x1: 185, c: () => COL.face },
    { en: 'Mg–0.8Zn', zh: 'Mg–0.8Zn', s0: 8.3, k: 0.417, x0: 52, x1: 160, c: () => COL.body },
    { en: 'Mg–2.3Zn', zh: 'Mg–2.3Zn', s0: 4.9, k: 0.67, x0: 45, x1: 145, c: () => COL.plane }
  ];
  const CW = { ts: mono([[0, 320], [12, 385], [38, 495], [60, 560]]), ys: mono([[0, 100], [12, 300], [38, 450], [60, 515]]), el: mono([[0, 52], [12, 24], [22, 12], [38, 4], [50, 2], [60, 1.5]]) };
  function secSH() {
    const dS = $('#sh-d'), cS = $('#sh-c'), info = $('#sh-info'); let mode = 'hp';
    const dOf = () => 2500 * Math.pow(17 / 2500, +dS.value / 100); // µm
    function paint(x, W, H) {
      blank(x, W, H);
      const ml = 46, mr = mode === 'cw' ? 40 : 14, mt = mode === 'hp' ? 34 : 14, mb = 36;
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted;
      if (mode === 'hp') {
        const XM = 250, YM = 120, X = q => ml + q / XM * (W - ml - mr), Y = s => mt + (1 - s / YM) * (H - mt - mb);
        x.textAlign = 'right'; for (let s = 0; s <= YM; s += 20) { x.beginPath(); x.moveTo(ml, Y(s)); x.lineTo(W - mr, Y(s)); x.stroke(); x.fillText(s, ml - 6, Y(s) + 3); }
        x.textAlign = 'center'; for (let q = 0; q <= XM; q += 50) { x.beginPath(); x.moveTo(X(q), mt); x.lineTo(X(q), H - mb); x.stroke(); x.fillText(q, X(q), H - mb + 14); }
        [2500, 625, 156, 69, 39, 25, 17].forEach(d => { const q = 1 / Math.sqrt(d * 1e-6); x.fillText(d, X(q), mt - 18); });
        x.fillText(tx('d (µm)', 'd（µm）'), X(XM) - 18, mt - 4);
        axisLabel(x, 'd⁻¹ᐟ² (m⁻¹ᐟ²)', (ml + W - mr) / 2, H - 6);
        axisLabel(x, tx('0.2% yield strength (MPa)', '0.2% 降伏強度（MPa）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
        const q = 1 / Math.sqrt(dOf() * 1e-6);
        HP.forEach(h => {
          x.strokeStyle = h.c(); x.lineWidth = 2.2; x.beginPath(); x.moveTo(X(h.x0), Y(h.s0 + h.k * h.x0)); x.lineTo(X(h.x1), Y(h.s0 + h.k * h.x1)); x.stroke();
          x.setLineDash([3, 4]); x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(0), Y(h.s0)); x.lineTo(X(h.x0), Y(h.s0 + h.k * h.x0)); x.moveTo(X(h.x1), Y(h.s0 + h.k * h.x1)); x.lineTo(X(XM), Y(h.s0 + h.k * XM)); x.stroke(); x.setLineDash([]);
          const s = h.s0 + h.k * q; if (s <= YM) { x.fillStyle = h.c(); x.beginPath(); x.arc(X(q), Y(s), 5, 0, 7); x.fill(); }
        });
        x.strokeStyle = T.hi; x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(q), mt); x.lineTo(X(q), H - mb); x.stroke();
      } else {
        const XM = 60, X = c => ml + c / XM * (W - ml - mr), Y = s => mt + (1 - s / 600) * (H - mt - mb), Y2 = e => mt + (1 - e / 60) * (H - mt - mb);
        x.textAlign = 'right'; for (let s = 0; s <= 600; s += 100) { x.beginPath(); x.moveTo(ml, Y(s)); x.lineTo(W - mr, Y(s)); x.stroke(); x.fillText(s, ml - 6, Y(s) + 3); }
        x.textAlign = 'left'; for (let e = 0; e <= 60; e += 20) x.fillText(e + '%', W - mr + 4, Y2(e) + 3);
        x.textAlign = 'center'; for (let c = 0; c <= XM; c += 10) { x.beginPath(); x.moveTo(X(c), mt); x.lineTo(X(c), H - mb); x.stroke(); x.fillText(c, X(c), H - mb + 14); }
        axisLabel(x, tx('percent cold work', '冷加工量（%）'), (ml + W - mr) / 2, H - 6);
        axisLabel(x, tx('strength (MPa)', '強度（MPa）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
        axisLabel(x, tx('elongation', '伸長率'), W - 8, (mt + H - mb) / 2, Math.PI / 2, COL.body);
        const line = (f, Yf, col, w) => { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); for (let c = 0; c <= XM; c += 0.5) c ? x.lineTo(X(c), Yf(f(c))) : x.moveTo(X(c), Yf(f(c))); x.stroke(); };
        line(CW.ts, Y, COL.corner, 2.4); line(CW.ys, Y, COL.plane, 2.4); line(CW.el, Y2, COL.body, 2.4);
        const c = +cS.value; x.strokeStyle = T.hi; x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(c), mt); x.lineTo(X(c), H - mb); x.stroke();
        [[CW.ts(c), Y, COL.corner], [CW.ys(c), Y, COL.plane], [CW.el(c), Y2, COL.body]].forEach(([v, Yf, col]) => { x.fillStyle = col; x.beginPath(); x.arc(X(c), Yf(v), 5, 0, 7); x.fill(); });
      }
    }
    function legend() {
      $('#sh-legend').innerHTML = mode === 'hp'
        ? HP.map(h => `<span><i class="sq" style="background:${h.c()}"></i>${h.en}</span>`).join('') + tx('<span><i class="sq" style="background:var(--hi)"></i>Chosen grain size</span>', '<span><i class="sq" style="background:var(--hi)"></i>所選晶粒尺寸</span>')
        : tx('<span><i class="sq" style="background:var(--c-corner)"></i>Tensile strength</span><span><i class="sq" style="background:var(--c-plane)"></i>Yield strength</span><span><i class="sq" style="background:var(--c-body)"></i>Elongation (right axis)</span>', '<span><i class="sq" style="background:var(--c-corner)"></i>抗拉強度</span><span><i class="sq" style="background:var(--c-plane)"></i>降伏強度</span><span><i class="sq" style="background:var(--c-body)"></i>伸長率（右軸）</span>');
    }
    function text() {
      if (mode === 'hp') {
        const d = dOf(), q = 1 / Math.sqrt(d * 1e-6);
        $('#sh-d-v').textContent = `${d < 100 ? d.toFixed(0) : Math.round(d / 10) * 10} µm`;
        info.innerHTML = `<div class="eq">d<sup>−1/2</sup> = ${q.toFixed(0)} m<sup>−1/2</sup></div><table class="mini"><thead><tr><th>${tx('Alloy', '合金')}</th><th>σ<sub>0</sub></th><th>k</th><th>σ<sub>y</sub></th></tr></thead><tbody>` +
          HP.map(h => `<tr><td>${h.en}</td><td class="num">${h.s0}</td><td class="num">${h.k}</td><td class="num">${(h.s0 + h.k * q).toFixed(0)}${q < h.x0 || q > h.x1 ? '*' : ''}</td></tr>`).join('') + '</tbody></table>' +
          tx('<p class="note">σ in MPa, k in MPa·m<sup>1/2</sup>, read off the slide’s figure. * outside the measured range (dashed). Divide d by 4 and the k/√d term doubles.</p>', '<p class="note">σ 單位 MPa，k 單位 MPa·m<sup>1/2</sup>，從投影片的圖讀出。* 表示超出量測範圍（虛線）。d 除以 4，k/√d 這一項就加倍。</p>');
      } else {
        const c = +cS.value, ts = CW.ts(c), ys = CW.ys(c), el = CW.el(c);
        $('#sh-c-v').textContent = `${c} %`;
        info.innerHTML = tx(`<dl class="stats"><dt>Yield strength</dt><dd>${ys.toFixed(0)} MPa</dd><dt>Tensile strength</dt><dd>${ts.toFixed(0)} MPa</dd><dt>σ<sub>y</sub> / UTS</dt><dd>${(ys / ts).toFixed(2)}</dd><dt>Elongation</dt><dd>${el.toFixed(0)} %</dd></dl>
          <p class="note">Curves traced from the cold-work chart on the slide. Yield strength climbs fastest and closes in on the tensile strength, so a heavily cold-worked metal has almost no hardening left before it necks.</p>`,
          `<dl class="stats"><dt>降伏強度</dt><dd>${ys.toFixed(0)} MPa</dd><dt>抗拉強度</dt><dd>${ts.toFixed(0)} MPa</dd><dt>σ<sub>y</sub> / UTS</dt><dd>${(ys / ts).toFixed(2)}</dd><dt>伸長率</dt><dd>${el.toFixed(0)} %</dd></dl>
          <p class="note">曲線描自投影片上的冷加工圖。降伏強度上升得最快，逐漸逼近抗拉強度；所以大量冷加工的金屬在頸縮前幾乎沒有加工硬化的餘地。</p>`);
      }
    }
    const draw = canvas2d($('#sh-cv'), paint);
    [dS, cS].forEach(s => s.addEventListener('input', () => { draw(); text(); }));
    seg($('#sh-m'), m => { mode = m; $('#sh-dc').hidden = m !== 'hp'; $('#sh-cc').hidden = m !== 'cw'; draw(); legend(); text(); });
    legend(); text(); onLang(() => { legend(); text(); });
    return () => { legend(); draw(); };
  }

  /* =====================================================================
     07-1 Dislocation–solute stress field interaction (2D, animated)
     ===================================================================== */
  function secSol() {
    const posEl = $('#sol-pos'), szEl = $('#sol-sz'), playB = $('#sol-play'), uS = $('#sol-u'), info = $('#sol-info');
    let pos = 'above', sz = 'big', u = REDUCED ? 0.5 : 0, playing = !REDUCED, vis = false, prev = 0;
    const isRepel = () => (sz === 'big') === (pos === 'above');
    const xdAt = uu => {
      const xPin = pos === 'above' ? -1.75 : -2.25, xStart = 2.8;
      if (isRepel()) {
        const xStop = xPin + 1.85, xBack = xPin + 3.25;
        if (uu < 0.44) return xStart + (xStop - xStart) * smooth(0, 0.44, uu);
        if (uu < 0.84) return xStop + (xBack - xStop) * smooth(0.44, 0.84, uu);
        return xBack;
      }
      return uu < 0.54 ? xStart + (xPin - xStart) * smooth(0, 0.54, uu) : xPin;
    };

    function paint(x, W, H) {
      blank(x, W, H);
      const repel = isRepel(), xPin = pos === 'above' ? -1.75 : -2.25, xd = xdAt(u);
      const ml = 34, mr = 14, mt = 14, latBot = H - 84, latH = latBot - mt, latW = W - ml - mr;
      const XMIN = -5.2, XMAX = 5.2, YMIN = -3.8, YMAX = 3.8;
      const sc = Math.min(latW / (XMAX - XMIN), latH / (YMAX - YMIN));
      const cx0 = ml + latW / 2, cy0 = mt + latH / 2;
      const PX = xx => cx0 + xx * sc, PY = yy => cy0 - yy * sc;

      const cComp = rgbOf(COL.face), cTens = rgbOf(COL.body);
      const glow = (gx, gy, rad, rgb, a) => {
        const gr = x.createRadialGradient(gx, gy, 0, gx, gy, rad);
        gr.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
        gr.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a * 0.55})`);
        gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        x.fillStyle = gr; x.beginPath(); x.arc(gx, gy, rad, 0, 7); x.fill();
      };

      // lattice deformation: edge dislocation at (xd, 0) + radial solute strain
      const NX = 13, NY = 8, nu = 0.3, iSol = 4, jSol = pos === 'above' ? 5 : 2;
      const disPt = (i, j) => {
        const x0 = i - 6, y0 = j - 3.5, dx = x0 - xd, r2 = dx * dx + y0 * y0, th = Math.atan2(y0, dx);
        return { x: x0 + (th + dx * y0 / (2 * (1 - nu) * r2)) / (2 * Math.PI), y: y0 };
      };
      const sol = disPt(iSol, jSol), amp = sz === 'big' ? 0.34 : -0.26;
      const pts = Array.from({ length: NX }, (_, i) => Array.from({ length: NY }, (_, j) => {
        const p = disPt(i, j);
        if (i === iSol && j === jSol) return p;
        const dx = p.x - sol.x, dy = p.y - sol.y, r2 = dx * dx + dy * dy + 0.15;
        const f = amp * Math.exp(-r2 / 2.2) / Math.sqrt(r2);
        return { x: p.x + dx * f, y: p.y + dy * f };
      }));

      x.save(); x.beginPath(); x.rect(ml, mt, latW, latH); x.clip();
      const pinned = !repel && Math.abs(xd - xPin) < 0.45;
      const relieve = pinned ? 0.65 : 1;
      // stress-field lobes: green = compression, orange/yellow = tension
      glow(PX(xd), PY(1.55), 1.75 * sc, cComp, 0.36 * relieve);
      glow(PX(xd), PY(-1.55), 1.75 * sc, cTens, 0.34 * relieve);
      glow(PX(sol.x), PY(sol.y), 1.45 * sc, sz === 'big' ? cComp : cTens, 0.36 * relieve);

      // slip plane
      x.setLineDash([4, 4]); x.strokeStyle = COL.plane; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(ml, PY(0)); x.lineTo(W - mr, PY(0)); x.stroke(); x.setLineDash([]);

      // lattice bonds
      x.strokeStyle = T.edge3d; x.lineWidth = 1.1; x.beginPath();
      for (let j = 0; j < NY; j++) for (let i = 0; i < NX - 1; i++) {
        x.moveTo(PX(pts[i][j].x), PY(pts[i][j].y)); x.lineTo(PX(pts[i + 1][j].x), PY(pts[i + 1][j].y));
      }
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY - 1; j++) {
        if (j === 3) continue;
        x.moveTo(PX(pts[i][j].x), PY(pts[i][j].y)); x.lineTo(PX(pts[i][j + 1].x), PY(pts[i][j + 1].y));
      }
      for (let i = 0; i < NX; i++) {
        const x3 = pts[i][3].x; let best = -1, bestD = 0.72;
        for (let k = 0; k < NX; k++) { const d = Math.abs(pts[k][4].x - x3); if (d < bestD) { bestD = d; best = k; } }
        if (best >= 0) { x.moveTo(PX(pts[i][3].x), PY(pts[i][3].y)); x.lineTo(PX(pts[best][4].x), PY(pts[best][4].y)); }
      }
      x.stroke();

      // atoms
      const rA = Math.min(7.5, sc * 0.24);
      x.fillStyle = T.stage; x.strokeStyle = T.ink; x.lineWidth = 1.2;
      for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
        if (i === iSol && j === jSol) continue;
        const p = pts[i][j]; x.beginPath(); x.arc(PX(p.x), PY(p.y), rA, 0, 7); x.fill(); x.stroke();
      }
      // solute atom
      const rS = rA * (sz === 'big' ? 1.42 : 0.68);
      x.fillStyle = sz === 'big' ? COL.face : COL.body; x.globalAlpha = 0.35;
      x.beginPath(); x.arc(PX(sol.x), PY(sol.y), rS, 0, 7); x.fill(); x.globalAlpha = 1;
      x.strokeStyle = T.ink; x.lineWidth = 2.6; x.beginPath(); x.arc(PX(sol.x), PY(sol.y), rS, 0, 7); x.stroke();

      // edge dislocation symbol ⊥
      const dxPx = PX(xd), dyPx = PY(0);
      x.strokeStyle = T.hi; x.lineWidth = 2.5; x.beginPath();
      x.moveTo(dxPx - 8, dyPx + 4); x.lineTo(dxPx + 8, dyPx + 4);
      x.moveTo(dxPx, dyPx + 4); x.lineTo(dxPx, dyPx - 10); x.stroke();

      // interaction force arrows
      const dist = Math.abs(xd - xPin);
      if (pinned) {
        x.font = FONT(600, 11); x.fillStyle = T.hi; x.textAlign = 'center';
        x.fillText(tx('pinned!', '已釘住！'), PX(sol.x), PY(pos === 'above' ? 2.45 : -2.65));
      } else if (dist < 3.6) {
        const ay = PY(pos === 'above' ? 0.78 : -0.78), len = Math.max(12, Math.min(26, sc * 0.65));
        const sX = PX(sol.x), dX = PX(xd), al = smooth(3.6, 2.2, dist);
        x.save(); x.globalAlpha = al;
        if (repel) {
          arrow2d(x, sX, ay, sX - len, ay, COL.corner, 2.4);
          arrow2d(x, dX, ay, dX + len, ay, COL.corner, 2.4);
        } else {
          arrow2d(x, sX, ay, sX + len, ay, COL.corner, 2.4);
          arrow2d(x, dX, ay, dX - len, ay, COL.corner, 2.4);
        }
        x.restore();
      }
      x.restore();
      x.strokeStyle = T.line; x.lineWidth = 1; x.strokeRect(ml, mt, latW, latH);

      // bottom interaction energy E(x)
      const ey0 = latBot + 14, ey1 = H - 22, E = xx => (repel ? 1 : -1) * Math.exp(-(((xx - xPin) / 1.15) ** 2));
      const EY = e => ey0 + (1.2 - e) / 2.4 * (ey1 - ey0);
      x.setLineDash([3, 3]); x.strokeStyle = T.grid; x.lineWidth = 1;
      x.beginPath(); x.moveTo(ml, EY(0)); x.lineTo(W - mr, EY(0)); x.stroke(); x.setLineDash([]);
      x.strokeStyle = repel ? COL.face : COL.body; x.lineWidth = 2.2; x.beginPath();
      for (let i = 0; i <= 140; i++) {
        const xx = XMIN + (XMAX - XMIN) * i / 140, px = PX(xx), py = EY(E(xx));
        if (px < ml || px > W - mr) continue;
        i === 0 ? x.moveTo(px, py) : x.lineTo(px, py);
      }
      x.stroke();
      x.fillStyle = T.hi; x.beginPath(); x.arc(PX(xd), EY(E(xd)), 5, 0, 7); x.fill();
      axisLabel(x, 'E', 16, (ey0 + ey1) / 2);
      x.font = FONT(500, 10); x.fillStyle = T.muted; x.textAlign = 'center';
      x.fillText(repel ? tx('energy barrier', '排斥能障') : tx('energy well (pinning)', '吸引位能井（釘住）'), PX(xPin), repel ? EY(1) - 5 : EY(-1) + 12);
      axisLabel(x, tx('dislocation position x', '差排位置 x'), (ml + W - mr) / 2, H - 5);
    }

    function legend() {
      $('#sol-legend').innerHTML = tx(
        '<span><i class="sq" style="background:var(--c-face)"></i>Compressive stress</span><span><i class="sq" style="background:var(--c-body)"></i>Tensile stress</span><span><i style="background:var(--c-corner)"></i>Force</span><span><i class="sq" style="background:var(--hi)"></i>Dislocation ⊥</span>',
        '<span><i class="sq" style="background:var(--c-face)"></i>壓縮應力區（綠）</span><span><i class="sq" style="background:var(--c-body)"></i>拉伸應力區（黃）</span><span><i style="background:var(--c-corner)"></i>交互作用力</span><span><i class="sq" style="background:var(--hi)"></i>刃差排 ⊥</span>'
      );
    }

    function text() {
      const repel = isRepel();
      const sField = sz === 'big' ? tx('compressive (green)', '壓縮應力場（綠）') : tx('tensile (yellow)', '拉伸應力場（黃）');
      const dField = pos === 'above' ? tx('compressive (green)', '壓縮應力區（綠）') : tx('tensile (yellow)', '拉伸應力區（黃）');
      const act = repel
        ? tx('Same-sign stress fields overlap and <b>repel</b> (arrows apart). The dislocation hits an energy barrier and is pushed back.', '同號應力場相遇而<b>互相排斥</b>（箭頭相背）。差排遇到能障被往回推。')
        : tx('Opposite stress fields cancel distortion and <b>attract</b> (arrows together). The solute sits in the gap and <b>pins</b> the dislocation.', '異號應力場抵消晶格畸變而<b>互相吸引</b>（箭頭相向）。溶質塞進空隙把差排<b>釘住</b>。');
      info.innerHTML = tx(`<h4>${pos === 'above' ? '(a) Solute above slip plane' : '(b) Solute below slip plane'}</h4>
        <dl class="stats"><dt>Dislocation side</dt><dd>${dField}</dd><dt>Solute (${sz === 'big' ? 'larger' : 'smaller'})</dt><dd>${sField}</dd><dt>Interaction</dt><dd>${repel ? 'Repulsion (←  →)' : 'Attraction / pinning (→  ←)'}</dd></dl>
        <p>${act}</p>
        <p class="note">Whether repelled by a barrier or trapped in a well, extra shear stress is needed to move the dislocation past the solute: solid solution hardening.</p>`,
        `<h4>${pos === 'above' ? '(a) 溶質在差排上方' : '(b) 溶質在差排下方'}</h4>
        <dl class="stats"><dt>差排所在側</dt><dd>${dField}</dd><dt>溶質（${sz === 'big' ? '較大' : '較小'}）</dt><dd>${sField}</dd><dt>交互作用</dt><dd>${repel ? '互相排斥（←  →）' : '互相吸引、釘住（→  ←）'}</dd></dl>
        <p>${act}</p>
        <p class="note">不論遇到排斥能障還是掉進吸引位能井，都要施加更大的剪應力才能讓差排通過：這就是固溶強化。</p>`);
    }

    function syncBtn() {
      playB.textContent = playing ? tx('Pause', '暫停') : tx('Play', '播放');
      playB.setAttribute('aria-pressed', String(playing));
    }
    const cv = $('#sol-cv'), draw = canvas2d(cv, paint);
    posEl && seg(posEl, p => { pos = p; u = REDUCED ? 0.5 : 0; uS.value = Math.round(u * 1000); draw(); text(); });
    szEl && seg(szEl, s => { sz = s; u = REDUCED ? 0.5 : 0; uS.value = Math.round(u * 1000); draw(); text(); });
    uS.addEventListener('input', () => { u = +uS.value / 1000; playing = false; syncBtn(); draw(); });
    playB.addEventListener('click', () => { playing = !playing; syncBtn(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { vis = es[0].isIntersecting; }).observe(cv); else vis = true;
    const step = now => {
      if (vis && playing && prev) {
        const dt = Math.min(0.1, (now - prev) / 1000);
        u += dt / 5.6; if (u >= 1) u -= 1;
        uS.value = Math.round(u * 1000); draw();
      }
      prev = now; requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    syncBtn(); legend(); text();
    onLang(() => { syncBtn(); legend(); text(); });
    return () => { legend(); draw(); };
  }

  /* =====================================================================
     08 Annealing cold-worked 85Cu–15Zn: structure and properties (2D)
     ===================================================================== */
  const AN = {
    ts: mono([[200, 520], [250, 502], [300, 458], [350, 390], [400, 322], [450, 290], [500, 278], [550, 275], [600, 272], [650, 268], [700, 263], [750, 259], [800, 254], [850, 247]]),
    el: mono([[200, 1], [250, 3], [300, 10], [350, 24], [400, 36], [450, 42], [500, 45.5], [550, 47], [600, 48], [700, 47.5], [800, 45.5], [850, 43.5]])
  };
  function secAN() {
    const tS = $('#an-T'), info = $('#an-info');
    // fixed random microstructure (unit square, x stretched by the box aspect when drawn)
    const rnd = rng(606), OLD = [], NEW = [], DIS = [];
    for (let i = 0; i < 16; i++) OLD.push([rnd(), rnd()]);
    for (let i = 0; i < 170; i++) NEW.push({ x: rnd(), y: rnd(), t: rnd() * 0.75, rank: rnd() });
    for (let i = 0; i < 520; i++) DIS.push([rnd(), rnd(), rnd()]);
    const off = document.createElement('canvas');
    function micro(x, ox, oy, w, h, T_) {
      const rec = smooth(200, 300, T_), X = smooth(300, 450, T_), gg = T_ > 450 ? 1 / (1 + (T_ - 450) / 110) ** 2 : 1;
      const bw = Math.max(40, Math.round(w / 2)), bh = Math.max(20, Math.round(h / 2)), asp = w / h;
      off.width = bw; off.height = bh; const c = off.getContext('2d'), img = c.createImageData(bw, bh), own = new Int32Array(bw * bh);
      const cO = rgbOf(COL.corner), cS = rgbOf(T.stage), cB = rgbOf(COL.plane);
      const live = T_ > 450 ? NEW.filter(n => n.rank < Math.max(0.08, gg)) : NEW;
      const G = 0.11; // growth radius per unit of X, in box heights
      for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
        const px = i / bw * asp, py = j / bh; let o = -1;
        if (T_ > 450) { let best = 1e9; live.forEach((n, k) => { const d = (px - n.x * asp) ** 2 + (py - n.y) ** 2; if (d < best) { best = d; o = 1000 + k; } }); }
        else if (X > 0) { let best = X >= 1 ? 1e9 : 0; NEW.forEach((n, k) => { if (n.t >= X) return; const s = Math.sqrt((px - n.x * asp) ** 2 + (py - n.y) ** 2) - G * (X - n.t) / 0.75 * 3; if (s < best) { best = s; o = 1000 + k; } }); }
        if (o < 0) { let best = 1e9; OLD.forEach((p, k) => { const d = ((px - p[0] * asp) / 3.2) ** 2 + (py - p[1]) ** 2; if (d < best) { best = d; o = k; } }); }
        own[j * bw + i] = o;
      }
      for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
        const k = j * bw + i, o = own[k], edge = (i < bw - 1 && own[k + 1] !== o) || (j < bh - 1 && own[k + bw] !== o);
        const col = edge ? cB : o >= 1000 ? mix(cS, cO, 0.12 + 0.1 * ((o * 7) % 5) / 5) : mix(cS, cO, 0.32 + 0.18 * ((o * 3) % 4) / 4);
        img.data.set([...col, 255], k * 4);
      }
      c.putImageData(img, 0, 0);
      x.save(); x.imageSmoothingEnabled = false; x.drawImage(off, ox, oy, w, h); x.restore();
      // dislocations: tangled at first, gathered into vertical walls by recovery, swept away by new grains
      x.fillStyle = T.hi; x.strokeStyle = T.hi;
      DIS.forEach(([u, v2, s]) => {
        const cxp = u * asp, k = Math.floor(v2 * bh) * bw + Math.floor(u * bw); if (own[k] >= 1000 || X >= 1) return;
        if (s > 1 - rec * 0.7) return; // recovery annihilates part of them
        const wall = Math.round(cxp / 0.22) * 0.22, px = cxp + (wall - cxp) * rec * 0.9;
        x.fillRect(ox + px / asp * w - 1, oy + v2 * h - 1, 2.2, 2.2);
      });
    }
    function paint(x, W, H) {
      blank(x, W, H);
      const T_ = +tS.value, ml = 46, mr = 40, mh = Math.round(H * 0.42);
      micro(x, ml, 8, W - ml - mr, mh, T_);
      x.strokeStyle = T.line; x.strokeRect(ml, 8, W - ml - mr, mh);
      const stage = T_ < 300 ? tx('cold-worked, recovering', '冷加工，回復中') : T_ < 450 ? tx('recrystallizing', '再結晶中') : tx('grain growth', '晶粒成長');
      x.font = FONT(600, 11); const tw = x.measureText(stage).width; x.fillStyle = T.stage; x.fillRect(ml + 4, 12, tw + 10, 18); x.fillStyle = T.ink; x.textAlign = 'left'; x.fillText(stage, ml + 9, 25);
      // property curves
      const pt = mh + 34, pb = H - 34, X = t => ml + (t - 200) / 650 * (W - ml - mr), Y = s => pt + (1 - (s - 200) / 400) * (pb - pt), Y2 = e => pt + (1 - e / 60) * (pb - pt);
      [[200, 300, 0.1], [300, 450, 0.18]].forEach(([a, b, o]) => { x.fillStyle = COL.plane; x.globalAlpha = o; x.fillRect(X(a), pt, X(b) - X(a), pb - pt); x.globalAlpha = 1; });
      x.font = FONT(500, 10); x.fillStyle = T.muted; x.textAlign = 'center';
      x.fillText(tx('recovery', '回復'), X(250), pt + 12); x.fillText(tx('recrystallization', '再結晶'), X(375), pt + 12); x.fillText(tx('grain growth', '晶粒成長'), X(650), pt + 12);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10);
      x.textAlign = 'right'; for (let s = 200; s <= 600; s += 100) { x.beginPath(); x.moveTo(ml, Y(s)); x.lineTo(W - mr, Y(s)); x.stroke(); x.fillStyle = COL.corner; x.fillText(s, ml - 6, Y(s) + 3); }
      x.textAlign = 'left'; x.fillStyle = COL.body; for (let e = 0; e <= 60; e += 20) x.fillText(e + '%', W - mr + 4, Y2(e) + 3);
      x.textAlign = 'center'; x.fillStyle = T.muted; for (let t = 200; t <= 800; t += 100) x.fillText(t, X(t), pb + 14);
      axisLabel(x, tx('annealing temperature (°C)', '退火溫度（°C）'), (ml + W - mr) / 2, H - 6);
      axisLabel(x, tx('UTS (MPa)', 'UTS（MPa）'), 12, (pt + pb) / 2, -Math.PI / 2, COL.corner);
      const line = (f, Yf, col) => { x.strokeStyle = col; x.lineWidth = 2.4; x.beginPath(); for (let t = 200; t <= 850; t += 5) t === 200 ? x.moveTo(X(t), Yf(f(t))) : x.lineTo(X(t), Yf(f(t))); x.stroke(); };
      line(AN.ts, Y, COL.corner); line(AN.el, Y2, COL.body);
      x.strokeStyle = T.hi; x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(T_), pt); x.lineTo(X(T_), pb); x.stroke();
      [[AN.ts(T_), Y, COL.corner], [AN.el(T_), Y2, COL.body]].forEach(([v, Yf, col]) => { x.fillStyle = col; x.beginPath(); x.arc(X(T_), Yf(v), 5, 0, 7); x.fill(); });
    }
    function text() {
      const T_ = +tS.value; $('#an-T-v').textContent = `${T_} °C`;
      const st = T_ < 300 ? 0 : T_ < 450 ? 1 : 2;
      const msg = [
        tx('<p><b>Recovery.</b> The grains are still the long, flat ones left by rolling. Dislocations start to cancel and line up into walls (polygonization), relieving the residual stress, but strength and elongation hardly change yet.</p>', '<p><b>回復。</b>晶粒還是軋延留下的扁長形。差排開始互相抵消、排成牆（多邊形化），消除殘留應力，但強度和伸長率還幾乎沒變。</p>'),
        tx('<p><b>Recrystallization.</b> New strain-free grains nucleate and eat into the deformed ones. Each new grain sweeps away the dislocations it passes, so strength falls steeply and elongation climbs.</p>', '<p><b>再結晶。</b>沒有應變的新晶粒成核，一路吃掉變形晶粒。新晶粒經過之處，差排都被清掉，所以強度急降、伸長率上升。</p>'),
        tx('<p><b>Grain growth.</b> All grains are new. Larger ones grow at the expense of smaller ones to cut boundary area; strength drifts slowly down (fewer boundaries, Hall–Petch) and elongation levels off.</p>', '<p><b>晶粒成長。</b>晶粒全都是新的。大晶粒吃掉小晶粒來減少晶界面積；強度緩慢下降（晶界變少，Hall–Petch），伸長率趨於平緩。</p>')][st];
      info.innerHTML = tx(`<dl class="stats"><dt>Tensile strength</dt><dd>${AN.ts(T_).toFixed(0)} MPa</dd><dt>Elongation</dt><dd>${AN.el(T_).toFixed(0)} %</dd></dl>`, `<dl class="stats"><dt>抗拉強度</dt><dd>${AN.ts(T_).toFixed(0)} MPa</dd><dt>伸長率</dt><dd>${AN.el(T_).toFixed(0)} %</dd></dl>`) + msg;
    }
    const draw = canvas2d($('#an-cv'), paint);
    tS.addEventListener('input', () => { draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     09 Superplasticity: three conditions at once (2D)
     ===================================================================== */
  function secSP() {
    const sS = $('#sp-s'), info = $('#sp-info'), st = { g: 1, t: 1, r: 1 };
    const ok = () => st.g && st.t && st.r;
    function bar(x, x0, cy, L, w, neck, broken) {
      const grip = 12, gh = Math.max(w * 1.4 + 6, 18);
      x.fillStyle = COL.corner; x.globalAlpha = 0.85;
      x.fillRect(x0 - grip, cy - gh / 2, grip, gh); x.fillRect(x0 + L, cy - gh / 2, grip, gh);
      x.beginPath(); x.moveTo(x0, cy - w / 2);
      for (let i = 0; i <= 80; i++) { const u = i / 80, k = 1 - neck * Math.exp(-(((u - 0.55) / 0.06) ** 2)); x.lineTo(x0 + u * L, cy - w / 2 * k); }
      for (let i = 80; i >= 0; i--) { const u = i / 80, k = 1 - neck * Math.exp(-(((u - 0.55) / 0.06) ** 2)); x.lineTo(x0 + u * L, cy + w / 2 * k); }
      x.closePath(); x.fill(); x.globalAlpha = 1;
      if (neck > 0.05) { x.fillStyle = T.hi; x.globalAlpha = 0.5; x.fillRect(x0 + 0.5 * L, cy - w / 2, 0.1 * L, w); x.globalAlpha = 1; }
      if (broken) { x.fillStyle = T.stage; x.fillRect(x0 + 0.548 * L, cy - w, 4, 2 * w); x.strokeStyle = T.hi; x.lineWidth = 2; x.beginPath(); x.moveTo(x0 + 0.546 * L, cy - w / 2); x.lineTo(x0 + 0.556 * L, cy + w / 2); x.stroke(); }
    }
    function grains(x, cx, cy, R, sx, sy, jit) {
      x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip();
      x.fillStyle = T.stage; x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      const s = 13, r = rng(9), hex = (px, py) => { const pts = []; for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; pts.push([px + s * 0.98 * Math.cos(a), py + s * 0.98 * Math.sin(a)]); } return pts; };
      for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
        const px0 = (i + (j & 1) * 0.5) * s * Math.sqrt(3), py0 = j * s * 1.5, rot = (r() - 0.5) * jit * 1.6, dx = (r() - 0.5) * jit * 14, dy = (r() - 0.5) * jit * 9;
        const pts = hex(0, 0).map(([a, b]) => [a * Math.cos(rot) - b * Math.sin(rot), a * Math.sin(rot) + b * Math.cos(rot)]);
        x.beginPath(); pts.forEach(([a, b], k) => { const X = cx + (px0 + a + dx) * sx, Y = cy + (py0 + b + dy) * sy; k ? x.lineTo(X, Y) : x.moveTo(X, Y); }); x.closePath();
        x.fillStyle = COL.corner; x.globalAlpha = 0.18 + 0.2 * r(); x.fill(); x.globalAlpha = 1; x.strokeStyle = COL.plane; x.lineWidth = 1.3; x.stroke();
      }
      x.restore(); x.strokeStyle = T.line; x.lineWidth = 1; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke();
    }
    function paint(x, W, H) {
      blank(x, W, H);
      const sp = ok(), ef = sp ? 11.7 : 0.12, p = +sS.value / 100, e = ef * p, avail = W - 80, L0 = avail / (1 + ef), w0 = 26;
      x.font = FONT(600, 11); x.fillStyle = T.ink; x.textAlign = 'left';
      x.fillText(tx('before', '拉伸前'), 28, 14); x.fillText(tx(`now: +${(e * 100).toFixed(0)} %`, `目前：+${(e * 100).toFixed(0)} %`), 28, 84);
      bar(x, 40, 46, L0, w0, 0, false);
      const neck = sp ? 0 : Math.max(0, (p - 0.7) / 0.3) * 0.6, broken = !sp && p >= 1;
      bar(x, 40, 114, L0 * (1 + e), w0 / Math.sqrt(1 + e), neck, broken);
      // magnified grains, before and now
      const R = Math.min(62, (H - 176) / 2 - 4), cy = H - R - 22, c1 = W * 0.27, c2 = W * 0.73;
      grains(x, c1, cy, R, 1, 1, 0);
      if (sp) grains(x, c2, cy, R, 1, 1, Math.min(1, e / 3) * 0.9); else grains(x, c2, cy, R, 1 + e, 1 / Math.sqrt(1 + e), 0);
      x.font = FONT(500, 10); x.fillStyle = T.muted; x.textAlign = 'center';
      x.fillText(tx('grains before', '拉伸前的晶粒'), c1, H - 6); x.fillText(sp ? tx('grains now: slid and rotated', '目前的晶粒：滑動、轉動過') : tx('grains now: stretched', '目前的晶粒：被拉長'), c2, H - 6);
      x.fillText(tx('both specimens drawn to the same scale', '上方兩根試片比例相同'), W / 2, 150);
    }
    function text() {
      const sp = ok(), p = +sS.value; $('#sp-s-v').textContent = `${p} %`;
      const miss = [!st.g && tx('grains too coarse', '晶粒太粗'), !st.t && tx('too cold', '溫度太低'), !st.r && tx('too fast', '速率太快')].filter(Boolean).join(tx(', ', '、'));
      info.innerHTML = sp
        ? tx('<dl class="stats"><dt>Mechanism</dt><dd>grain boundary sliding, rotation, boundary diffusion</dd><dt>Elongation (Ti alloy, 870 °C)</dt><dd>1170 %</dd></dl><p>All three conditions hold. The grains stay about the same size and shape; they shuffle past each other, and the bar thins evenly without a neck.</p>',
          '<dl class="stats"><dt>機制</dt><dd>晶界滑移、轉動、晶界擴散</dd><dt>伸長率（鈦合金，870 °C）</dt><dd>1170 %</dd></dl><p>三個條件都成立。晶粒大小和形狀幾乎不變，只是彼此錯動；整根棒子均勻變細，沒有頸縮。</p>')
        : tx(`<dl class="stats"><dt>Missing</dt><dd>${miss}</dd><dt>Mechanism</dt><dd>dislocation slip</dd><dt>Elongation</dt><dd>small, like 12 % for the Ti alloy at room temperature</dd></dl><p>Deformation goes by slip inside the grains, which stretch with the bar. The flow localizes into a neck and the bar breaks. The slide gives a number only for room temperature; the other combinations are drawn the same way.</p>`,
          `<dl class="stats"><dt>缺少</dt><dd>${miss}</dd><dt>機制</dt><dd>差排滑移</dd><dt>伸長率</dt><dd>很小，例如鈦合金室溫下 12 %</dd></dl><p>變形靠晶粒內部的滑移，晶粒跟著棒子被拉長。變形集中成頸縮，棒子就斷了。投影片只給了室溫的數字；其他組合也照這個情形畫。</p>`);
    }
    const draw = canvas2d($('#sp-cv'), paint);
    [['#sp-g', 'g'], ['#sp-t', 't'], ['#sp-r', 'r']].forEach(([id, k]) => seg($(id), v => { st[k] = +v; draw(); text(); }));
    sS.addEventListener('input', () => { draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     10 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('A 10 mm slab is cold rolled to 6 mm. What is the percent cold work?', '10 mm 的板胚冷軋到 6 mm，冷加工量是多少？'), o: [tx('40%, from (10 − 6) / 10', '40%，由 (10 − 6) / 10'), tx('60%, from 6 / 10', '60%，由 6 / 10'), tx('67%, from (10 − 6) / 6', '67%，由 (10 − 6) / 6'), tx('167%, from 10 / 6', '167%，由 10 / 6')], a: 0, e: tx('Percent reduction is measured against the starting thickness: (t<sub>0</sub> − t)/t<sub>0</sub> = 4/10 = 40%.', '減薄率以起始厚度為準：(t<sub>0</sub> − t)/t<sub>0</sub> = 4/10 = 40%。') },
    { q: tx('An isotropic metal has E = 200 GPa and ν = 0.30. Estimate its shear modulus G.', '某等向性金屬 E = 200 GPa、ν = 0.30，估計它的剪力模數 G。'), o: [tx('About 77 GPa, from E / 2(1 + ν)', '約 77 GPa，由 E / 2(1 + ν)'), tx('About 154 GPa, from E / (1 + ν)', '約 154 GPa，由 E / (1 + ν)'), tx('About 60 GPa, from ν × E', '約 60 GPa，由 ν × E'), tx('About 260 GPa, from E × (1 + ν)', '約 260 GPa，由 E × (1 + ν)')], a: 0, e: tx('G = E / 2(1 + ν) = 200 / 2.6 ≈ 77 GPa.', 'G = E / 2(1 + ν) = 200 / 2.6 ≈ 77 GPa。') },
    { q: tx('A bar is stretched elastically. For its volume to stay constant, what must Poisson’s ratio be?', '把一根棒子彈性拉長。要讓體積維持不變，Poisson’s ratio 必須是多少？'), o: [tx('0.5, since ΔV/V = ε(1 − 2ν) must vanish', '0.5，因為 ΔV/V = ε(1 − 2ν) 必須為零'), tx('0.33, since three axes share the strain', '0.33，因為三個軸平均分攤應變'), tx('1.0, since lateral strain must equal axial', '1.0，因為橫向應變要等於軸向'), tx('0, since the sides must not shrink at all', '0，因為側面完全不能收縮')], a: 0, e: tx('To first order ΔV/V = ε<sub>x</sub> + ε<sub>y</sub> + ε<sub>z</sub> = ε(1 − 2ν), which is zero only for ν = 0.5. Metals sit near 0.3, so their volume grows slightly in tension.', '只取一階項，ΔV/V = ε<sub>x</sub> + ε<sub>y</sub> + ε<sub>z</sub> = ε(1 − 2ν)，只有 ν = 0.5 時為零。金屬的 ν 約 0.3，所以拉伸時體積會稍微變大。') },
    { q: tx('Past the UTS the engineering stress falls. Why?', '過了 UTS，工程應力開始下降，為什麼？'), o: [tx('A neck forms and the load-bearing area shrinks', '出現頸縮，承受負載的面積變小'), tx('The metal softens as dislocations disappear', '差排消失，金屬變軟'), tx('The elastic strain is released all at once', '彈性應變一下子全部釋放'), tx('The grains recrystallize during the test', '試驗中晶粒發生再結晶')], a: 0, e: tx('Engineering stress divides by the original area. In the neck the real area drops fast, so the load falls even though the true stress keeps rising.', '工程應力除的是原始面積。頸縮處的實際面積迅速變小，所以負載下降，真應力其實還在上升。') },
    { q: tx('How is the 0.2% offset yield strength found?', '0.2% 偏移降伏強度怎麼求？'), o: [tx('A line parallel to the elastic part, from 0.2% strain, cut with the curve', '從 0.2% 應變畫平行彈性段的線，看它和曲線的交點'), tx('The stress on the curve at exactly 0.2% total strain', '曲線上總應變恰好 0.2% 時的應力'), tx('0.2% of the ultimate tensile strength', 'UTS 的 0.2%'), tx('The stress where the curve slope drops by 0.2%', '曲線斜率下降 0.2% 處的應力')], a: 0, e: tx('Shift the elastic line right by 0.002 and read where it meets the curve: there, 0.2% of the strain is plastic.', '把彈性直線往右平移 0.002，讀它和曲線的交點：在那裡，有 0.2% 的應變是塑性的。') },
    { q: tx('A Rockwell B test leaves a permanent depth Δd = 0.080 mm. What is the reading?', 'Rockwell B 試驗留下永久深度 Δd = 0.080 mm，讀數是多少？'), o: [tx('HRB 90, from 130 − 0.080/0.002', 'HRB 90，由 130 − 0.080/0.002'), tx('HRB 60, from 100 − 0.080/0.002', 'HRB 60，由 100 − 0.080/0.002'), tx('HRB 40, from 0.080/0.002', 'HRB 40，由 0.080/0.002'), tx('HRB 170, from 130 + 0.080/0.002', 'HRB 170，由 130 + 0.080/0.002')], a: 0, e: tx('Scale B uses a steel ball, so E = 130. e = Δd/0.002 = 0.080/0.002 = 40, and HRB = 130 − 40 = 90.', 'B 尺度用鋼球，E = 130。e = Δd/0.002 = 0.080/0.002 = 40，HRB = 130 − 40 = 90。') },
    { q: tx('Why is HCP zinc much less ductile than FCC copper?', '為什麼 HCP 的鋅比 FCC 的銅難延展得多？'), o: [tx('Zinc slips only on its basal plane: 3 systems against 12', '鋅只能在底面滑移：3 個系統對上 12 個'), tx('Zinc atoms are bonded ionically, copper atoms metallically', '鋅原子是離子鍵，銅原子是金屬鍵'), tx('Zinc has no close-packed planes at all', '鋅完全沒有最密堆積面'), tx('Zinc has a much higher melting point than copper', '鋅的熔點比銅高很多')], a: 0, e: tx('With a high c/a ratio, Zn slips only on {0001}⟨112̄0⟩, 1 × 3 = 3 systems. FCC has 4 × 3 = 12 on close-packed {111} planes.', 'c/a 比高的 Zn 只能在 {0001}⟨112̄0⟩ 滑移，1 × 3 = 3 個系統。FCC 在最密堆積的 {111} 面上有 4 × 3 = 12 個。') },
    { q: tx('A crystal is pulled at 10 MPa with Φ = 60° and λ = 30°. What is the resolved shear stress?', '以 10 MPa 拉一顆晶體，Φ = 60°、λ = 30°，分解剪應力是多少？'), o: [tx('4.3 MPa, from 10 × cos 30° × cos 60°', '4.3 MPa，由 10 × cos 30° × cos 60°'), tx('5.0 MPa, from 10 × cos 60°', '5.0 MPa，由 10 × cos 60°'), tx('8.7 MPa, from 10 × cos 30°', '8.7 MPa，由 10 × cos 30°'), tx('2.5 MPa, from 10 × cos² 60°', '2.5 MPa，由 10 × cos² 60°')], a: 0, e: tx('τ<sub>r</sub> = σ cos λ cos Φ = 10 × 0.866 × 0.5 = 4.33 MPa.', 'τ<sub>r</sub> = σ cos λ cos Φ = 10 × 0.866 × 0.5 = 4.33 MPa。') },
    { q: tx('By Hall–Petch, how must the grain size change to double the k/√d term?', '依照 Hall–Petch，要讓 k/√d 這一項加倍，晶粒尺寸要怎麼變？'), o: [tx('Shrink to one quarter of its size', '縮小成四分之一'), tx('Shrink to one half of its size', '縮小成二分之一'), tx('Grow to twice its size', '變成兩倍大'), tx('Shrink to 1/√2 of its size', '縮小成 1/√2')], a: 0, e: tx('k/√d doubles when √d halves, that is when d becomes d/4.', '√d 減半，k/√d 就加倍，也就是 d 變成 d/4。') },
    { q: tx('During annealing of cold-worked brass, which stage causes the steep drop in strength?', '冷加工黃銅退火時，強度驟降發生在哪個階段？'), o: [tx('Recrystallization, as new strain-free grains form', '再結晶，形成沒有應變的新晶粒時'), tx('Recovery, as dislocations line up into walls', '回復，差排排成牆的時候'), tx('Grain growth, as large grains eat small ones', '晶粒成長，大晶粒吃掉小晶粒的時候'), tx('Cooling, as the metal returns to room temperature', '冷卻，金屬回到室溫的時候')], a: 0, e: tx('Recovery mainly relieves residual stress. Recrystallization sweeps away the dislocations, so strength falls and ductility returns; grain growth only lowers strength slowly.', '回復主要是消除殘留應力。再結晶把差排清掉，所以強度下降、延性恢復；晶粒成長只讓強度緩慢下降。') },
    { q: tx('What lets a superplastic alloy stretch over 1000%?', '超塑性合金能拉長超過 1000%，靠的是什麼？'), o: [tx('Grain boundary sliding and rotation in fine grains', '細晶粒的晶界滑移與轉動'), tx('Dislocation slip on many more slip systems', '在更多滑移系統上的差排滑移'), tx('Very fast loading that outruns the necking', '負載非常快，搶在頸縮之前'), tx('Coarse grains that leave few boundaries to crack', '粗大晶粒，可以裂開的晶界很少')], a: 0, e: tx('Superplasticity needs grains of 5–10 µm, T &gt; 0.5 T<sub>m</sub> and a slow strain rate. Dislocations do little; grains slide, rotate and are reshaped by boundary diffusion.', '超塑性需要 5–10 µm 的晶粒、T &gt; 0.5 T<sub>m</sub> 和慢的應變速率。差排幾乎不動；晶粒靠滑移、轉動和晶界擴散調整形狀。') }
  ]; });
  const QUIZ_N = 11;
  const QPERM = (() => { const r = rng(20261119); return Array.from({ length: QUIZ_N }, () => { const p = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; }); })();
  dataset(() => { QUIZ.forEach((q, i) => { const p = QPERM[i], o = q.o.slice(); q.o = p.map(k => o[k]); q.a = p.indexOf(q.a); }); });

  function boot() {
    if (GL) {
      [heroScene, secForm, secBar, secSlip, secDSlip, secSchmid].forEach(f => { try { f(); } catch (e) { console.error(e); } });
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    [secSS, secHD, secHV, secSH, secSol, secAN, secSP].forEach(f => { try { redraw2D.push(f()); } catch (e) { console.error(e); } });
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
    document.title = tx("Mechanical Properties of Metals 3D Classroom", "金屬的機械性質 3D 教室");
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
