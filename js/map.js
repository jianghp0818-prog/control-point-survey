// Map on a canvas: the OneMap base map, the project drawing (simplified DXF linework and text from the office) and
// the control points. World coordinates are metres relative to the project origin (x east, y north); the app
// converts SVY21 Easting/Northing to and from these.
// Adapted from the map of Tree Field Survey.

export const TYPE_COLORS = { RD: "#c92a2a", T: "#1864ab", P: "#2b8a3e" };
const DEAD_COLOR = "#868e96";
const TAP_RADIUS = 26;      // px: how close a tap must be to a point
const MIN_TEXT_PX = 7;      // drawing text smaller than this on screen is not drawn

// OneMap (Singapore Land Authority) base map: 256 px Web Mercator tiles, zoom 11 to 19 (land lots to 20).
// Tiles come straight from OneMap while online; they are not stored by the app (OneMap terms of use).
const ONEMAP_TILE = "https://www.onemap.gov.sg/maps/tiles/{style}/{z}/{x}/{y}.png";
const ONEMAP_MIN_ZOOM = 11;
const ONEMAP_MAX_ZOOM = { LandLot: 20 };
const EARTH_CIRCUMFERENCE = 40075016.686;
const MAX_TILES_KEPT = 400;
const TILE_RETRY_MS = 30000;

function tileLonLat(z, x, y) {
  const n = 2 ** z;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
}

export class PointMap {
  constructor(canvas, { onTap, onMove, onTileError } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onTap = onTap || (() => {});
    this.onMove = onMove || (() => {});
    this.onTileError = onTileError || (() => {});
    this.geo = null;          // {toLonLat(x, y), fromLonLat(lon, lat)} for the base map
    this.base = null;         // {on, style, opacity, contrast, drawing}
    this.tiles = new Map();   // "style/z/x/y" -> {img, ok, failed}
    this.scale = 1;           // px per metre
    this.cx = 0;              // world point at the centre of the screen
    this.cy = 0;
    this.items = [];          // [{key, label, x, y, type, approx, dead}]
    this.selected = null;
    this.location = null;     // {x, y, acc}
    this.target = null;       // {x, y} of the point being navigated to
    this.pin = null;          // {x, y}: position being placed by tapping
    this.layers = [];
    this.texts = [];
    this.points = [];
    this.pointers = new Map();
    this.frame = 0;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setBackground(bg) {
    this.layers = (bg?.layers || []).map((layer) => {
      const path = new Path2D();
      for (const line of layer.lines) {
        path.moveTo(line[0], line[1]);
        for (let i = 2; i < line.length; i += 2) path.lineTo(line[i], line[i + 1]);
      }
      return { name: layer.name, color: layer.color, path };
    });
    this.texts = bg?.texts || [];
    this.points = bg?.points || [];
    this.pointColors = (bg?.layers || []).map((l) => l.color);
    this.draw();
  }

  get hasDrawing() {
    return this.layers.length > 0 || this.texts.length > 0;
  }

  setItems(items) {
    this.items = items;
    this.draw();
  }

  setGeo(geo) {
    this.geo = geo;
    this.draw();
  }

  setBasemap(base) {
    this.base = { ...base };
    this.draw();
  }

  // ---- OneMap base map
  tile(style, z, x, y) {
    const key = `${style}/${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    const url = ONEMAP_TILE.replace("{style}", style).replace("{z}", z).replace("{x}", x).replace("{y}", y);
    if (!t) {
      t = { img: new Image(), ok: false, failed: 0 };
      t.img.onload = () => {
        t.ok = true;
        this.draw();
      };
      t.img.onerror = () => {
        t.failed = Date.now();
        this.onTileError();
      };
      t.img.src = url;
      this.tiles.set(key, t);
      if (this.tiles.size > MAX_TILES_KEPT) this.tiles.delete(this.tiles.keys().next().value);
    } else if (t.failed && Date.now() - t.failed > TILE_RETRY_MS) {
      t.failed = 0;
      t.img.src = `${url}?retry=${Date.now()}`;
    }
    return t;
  }

  drawBasemap(w, h) {
    const { ctx, base, geo } = this;
    const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([sx, sy]) => geo.toLonLat(...this.toWorld(sx, sy)));
    const lons = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const maxZoom = ONEMAP_MAX_ZOOM[base.style] || 19;
    const ideal = Math.log2(EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) * this.scale / 256);
    const z = Math.max(ONEMAP_MIN_ZOOM, Math.min(maxZoom, Math.round(ideal + 0.3)));
    const n = 2 ** z;
    const tx = (lon) => Math.floor((lon + 180) / 360 * n);
    const ty = (la) => {
      const r = la * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    };
    const x0 = tx(Math.min(...lons)), x1 = tx(Math.max(...lons));
    const y0 = ty(Math.max(...lats)), y1 = ty(Math.min(...lats));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return;      // zoomed out beyond OneMap's range
    ctx.save();
    ctx.globalAlpha = base.opacity;
    ctx.filter = `contrast(${base.contrast}) brightness(${base.brightness ?? 1})`;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        // tile corners from Web Mercator to SVY21; near Singapore the tile stays a rectangle to within millimetres
        const [ax, ay] = this.toScreen(...geo.fromLonLat(...tileLonLat(z, x, y)));
        const [bx, by] = this.toScreen(...geo.fromLonLat(...tileLonLat(z, x + 1, y + 1)));
        const t = this.tile(base.style, z, x, y);
        if (t.ok) {
          ctx.drawImage(t.img, ax, ay, bx - ax, by - ay);
          continue;
        }
        for (let d = 1; d <= 3 && z - d >= ONEMAP_MIN_ZOOM; d++) {     // a coarser tile until this one arrives
          const p = this.tiles.get(`${base.style}/${z - d}/${x >> d}/${y >> d}`);
          if (p?.ok) {
            const k = 2 ** d, s = p.img.naturalWidth / k;
            ctx.drawImage(p.img, (x % k) * s, (y % k) * s, s, s, ax, ay, bx - ax, by - ay);
            break;
          }
        }
      }
    }
    ctx.restore();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    if (!this.fitted && this.pendingFit) this.fit(this.pendingFit);
    this.draw();
  }

  fit([x0, y0, x1, y1], maxScale = 8) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) {
      this.pendingFit = [x0, y0, x1, y1];
      return;
    }
    this.fitted = true;
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = Math.min(maxScale, w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1));
    this.draw();
  }

  centerOn(x, y, minScale = 0) {
    this.scale = Math.max(this.scale, minScale);
    this.cx = x;
    this.cy = y;
    this.draw();
  }

  zoomBy(factor, sx, sy) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (sx === undefined) { sx = w / 2; sy = h / 2; }
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(Math.max(this.scale * factor, 0.004), 400);
    this.cx = wx - (sx - w / 2) / this.scale;
    this.cy = wy + (sy - h / 2) / this.scale;
    this.draw();
  }

  toScreen(x, y) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    return [(x - this.cx) * this.scale + w / 2, (this.cy - y) * this.scale + h / 2];
  }

  toWorld(sx, sy) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    return [(sx - w / 2) / this.scale + this.cx, this.cy - (sy - h / 2) / this.scale];
  }

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.snap) this.renderMoving();
      else this.render();
    });
  }

  // While a finger or the mouse wheel moves the map, the last full drawing is moved and scaled as a picture,
  // which is fast on slow phones; the full drawing follows when the gesture ends.
  startGesture() {
    if (this.snap) return;
    if (!this.fresh) this.render();
    this.snapshot = this.snapshot || document.createElement("canvas");
    this.snapshot.width = this.canvas.width;
    this.snapshot.height = this.canvas.height;
    this.snapshot.getContext("2d").drawImage(this.canvas, 0, 0);
    this.snap = { scale: this.scale, cx: this.cx, cy: this.cy };
  }

  endGesture() {
    this.snap = null;
    this.draw();
  }

  renderMoving() {
    const { ctx, canvas, dpr = 1, snap } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const k = this.scale / snap.scale;
    const ox = w / 2 - (w / 2) * k + (snap.cx - this.cx) * this.scale;
    const oy = h / 2 - (h / 2) * k + (this.cy - snap.cy) * this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fbfcfd";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.snapshot, ox, oy, w * k, h * k);
    this.fresh = false;
  }

  render() {
    this.fresh = true;
    const { ctx, canvas, dpr = 1 } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fbfcfd";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.base?.on && this.geo) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawBasemap(w, h);
    }
    if (this.base?.drawing !== false) this.renderDrawing(w, h, dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderPoints(w, h);
    this.renderOverlays();
    this.drawScaleBar();
  }

  renderDrawing(w, h, dpr) {
    const { ctx } = this;
    const s = this.scale * dpr;
    const [vx0, vy1] = this.toWorld(0, 0);
    const [vx1, vy0] = this.toWorld(w, h);
    ctx.setTransform(s, 0, 0, -s, (w / 2 - this.cx * this.scale) * dpr, (h / 2 + this.cy * this.scale) * dpr);
    ctx.lineWidth = 1 / this.scale;
    ctx.lineJoin = ctx.lineCap = "round";
    for (const layer of this.layers) {
      ctx.strokeStyle = layer.color;
      ctx.stroke(layer.path);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.scale > 1.5) {
      for (const [x, y, li] of this.points) {
        if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
        const [px, py] = this.toScreen(x, y);
        ctx.fillStyle = this.pointColors[li] || "#555";
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }
    ctx.textBaseline = "alphabetic";
    for (const [x, y, ht, rot, text, li] of this.texts) {
      const px = ht * this.scale;
      if (px < MIN_TEXT_PX || x < vx0 - 50 || x > vx1 + 50 || y < vy0 - 50 || y > vy1 + 50) continue;
      const [sx, sy] = this.toScreen(x, y);
      ctx.save();
      ctx.translate(sx, sy);
      if (rot) ctx.rotate((-rot * Math.PI) / 180);
      ctx.font = `${Math.min(px, 60)}px system-ui, sans-serif`;
      ctx.fillStyle = this.pointColors[li] || "#444";
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  symbol(type, sx, sy, r, { fill, stroke, dashed, lineWidth }) {
    const { ctx } = this;
    ctx.beginPath();
    if (type === "RD") {                                       // triangle
      const k = r * 1.25;
      ctx.moveTo(sx, sy - k);
      ctx.lineTo(sx + k * 0.95, sy + k * 0.65);
      ctx.lineTo(sx - k * 0.95, sy + k * 0.65);
      ctx.closePath();
    } else if (type === "P") {                                 // square
      ctx.rect(sx - r * 0.85, sy - r * 0.85, r * 1.7, r * 1.7);
    } else {                                                   // circle
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Points: filled when surveyed, hollow and dashed when only an approximate position is known; grey with a cross
  // when destroyed or void. A label that would overlap one already drawn is left out until zoomed in.
  renderPoints(w, h) {
    const { ctx } = this;
    const r = Math.max(6, Math.min(11, 0.9 * this.scale));
    const visible = [];
    for (const p of this.items) {
      const [sx, sy] = this.toScreen(p.x, p.y);
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;
      const isSel = this.selected === p.key;
      visible.push({ p, sx, sy, isSel });
    }
    visible.sort((a, b) => a.isSel - b.isSel);
    for (const { p, sx, sy, isSel } of visible) {
      const color = p.dead ? DEAD_COLOR : TYPE_COLORS[p.type] || TYPE_COLORS.T;
      const rr = isSel ? r + 3 : r;
      if (isSel) this.symbol(p.type, sx, sy, rr + 4, { stroke: "#ffd43b", lineWidth: 5 });
      if (p.approx) {
        this.symbol(p.type, sx, sy, rr, { fill: "rgba(255,255,255,0.85)", stroke: color, dashed: true, lineWidth: 2.5 });
      } else {
        this.symbol(p.type, sx, sy, rr, { fill: color, stroke: "#fff", lineWidth: 1.5 });
      }
      if (p.dead) {
        ctx.strokeStyle = "#343a40";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx - rr, sy - rr); ctx.lineTo(sx + rr, sy + rr);
        ctx.moveTo(sx + rr, sy - rr); ctx.lineTo(sx - rr, sy + rr);
        ctx.stroke();
      }
    }
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const placed = [];
    for (const { p, sx, sy, isSel } of [...visible].reverse()) {
      const lx = sx + r + 6, tw = ctx.measureText(p.label).width;
      const box = [lx - 2, sy - 9, lx + tw + 2, sy + 9];
      if (!isSel && placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(box[0], box[1], box[2] - box[0], 18);
      ctx.fillStyle = isSel ? "#0b3d91" : "#1b1f1d";
      ctx.fillText(p.label, lx, sy);
    }
  }

  renderOverlays() {
    const { ctx } = this;
    if (this.target) {
      const [tx, ty] = this.toScreen(this.target.x, this.target.y);
      if (this.location) {
        const [lx, ly] = this.toScreen(this.location.x, this.location.y);
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(11,61,145,0.8)";
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(tx, ty, 20, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#0b3d91";
      ctx.stroke();
    }
    if (this.location) {
      const [sx, sy] = this.toScreen(this.location.x, this.location.y);
      const acc = this.location.acc * this.scale;
      if (acc > 8) {
        ctx.beginPath();
        ctx.arc(sx, sy, acc, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(25,113,194,0.12)";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#1971c2";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
    if (this.pin) {                                    // position being placed: cross-hair with a ring
      const [sx, sy] = this.toScreen(this.pin.x, this.pin.y);
      ctx.strokeStyle = "#e8590c";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 14, 0, Math.PI * 2);
      ctx.moveTo(sx - 24, sy); ctx.lineTo(sx - 5, sy);
      ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 24, sy);
      ctx.moveTo(sx, sy - 24); ctx.lineTo(sx, sy - 5);
      ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 24);
      ctx.stroke();
    }
  }

  drawScaleBar() {
    const { ctx } = this;
    const target = 100 / this.scale;
    const pow = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
    const px = len * this.scale;
    const x = 14, y = 16;
    const label = len >= 1000 ? `${len / 1000} km` : `${len >= 1 ? len : len.toFixed(1)} m`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x - 6, y - 10, px + 64, 22);
    ctx.strokeStyle = "#1b1f1d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.lineTo(x + px, y + 4); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = "#1b1f1d";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + px + 6, y + 1);
  }

  itemAt(sx, sy) {
    let best = null, bestD = TAP_RADIUS;
    for (const p of this.items) {
      const [tx, ty] = this.toScreen(p.x, p.y);
      const d = Math.hypot(tx - sx, ty - sy);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  bindEvents() {
    const c = this.canvas;
    let start = null, pinch = null, moved = false;
    const pos = (e) => {
      const rect = c.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    c.addEventListener("pointerdown", (e) => {
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // capture is a convenience (keeps a drag going outside the map); taps work without it
      }
      this.pointers.set(e.pointerId, pos(e));
      if (this.pointers.size === 1) {
        start = { p: pos(e), cx: this.cx, cy: this.cy };
        moved = false;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.scale, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        pinch.world = this.toWorld(...pinch.mid);
        moved = true;
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = pos(e);
      this.onMove(this.toWorld(...p));
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2 && pinch) {
        this.startGesture();
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.scale = Math.min(Math.max(pinch.scale * (d / pinch.d), 0.004), 400);
        const { clientWidth: w, clientHeight: h } = c;
        this.cx = pinch.world[0] - (mid[0] - w / 2) / this.scale;
        this.cy = pinch.world[1] + (mid[1] - h / 2) / this.scale;
        this.draw();
      } else if (this.pointers.size === 1 && start) {
        const dx = p[0] - start.p[0], dy = p[1] - start.p[1];
        if (Math.hypot(dx, dy) > 6) moved = true;
        if (moved) {
          this.startGesture();
          this.cx = start.cx - dx / this.scale;
          this.cy = start.cy + dy / this.scale;
          this.draw();
        }
      }
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        if (!moved && e.type === "pointerup") this.onTap({ item: this.itemAt(...p), world: this.toWorld(...p) });
        start = null;
        pinch = null;
        if (this.snap) this.endGesture();
      } else if (this.pointers.size === 1) {
        const [q] = [...this.pointers.values()];
        start = { p: q, cx: this.cx, cy: this.cy };
        pinch = null;
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.startGesture();
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => this.endGesture(), 200);
      const [sx, sy] = pos(e);
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), sx, sy);
    }, { passive: false });
  }
}
