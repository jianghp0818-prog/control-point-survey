// Control Point Survey (phone): number control points on site without using a number twice, record where they are
// (GPS or a tap on the map), take photos, and send everything to the office as a zip. The office sends back project
// packs (drawing, surveyed coordinates, numbers already used) and the master register (all points, view only).

import { db } from "./db.js";
import { PointMap } from "./map.js";
import { compressPhoto } from "./photos.js";
import { STATUS_LABELS, buildFieldZip, exportCandidates, shareOrDownload } from "./export.js";
import { TYPE_LABELS, checkNumber, checkPrefix, checkProjectCode, naturalCompare, nextNumber, normalize,
  normalizeProject, typeOf } from "./numbers.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const APP_VERSION = "0.1.1";     // change with CACHE in sw.js
const SVY21 = "+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 +k=1 +x_0=28001.642 +y_0=38744.572 " +
  "+ellps=WGS84 +units=m +no_defs";
const DEFAULT_ORIGIN = [28000, 38000];                           // SVY21, near the false origin
const SINGAPORE_VIEW = [2000 - 28000, 15500 - 38000, 56000 - 28000, 51000 - 38000];
const BASEMAP_DEFAULT = { on: true, style: "Default", opacity: 0.9, contrast: 1, brightness: 1, drawing: true };
const PHOTO_SLOTS = [["close", "Close-up", "the marker"], ["wide", "Wide view", "with landmarks"]];
const MAX_EXTRA_PHOTOS = 4;
const MASTER = "__master__";

const state = {
  view: null,           // "project" or "master"
  readonly: false,      // a pack opened only to look at (office map view) or the master register
  project: null,        // {code, name, origin, background, officeUsed, ...}
  points: new Map(),    // key -> point (key is the number; "<project>|<number>" in the master view)
  current: null,        // point shown in the panel
  surveyor: "",
  prefix: "",
  officeRd: new Set(),  // RD numbers the office has (from packs)
  retired: {},          // numbers of projects removed from this phone: {code: [numbers]}
  master: null,         // master register pack
  allKeys: [],          // [[project, no]] of every point on this phone
  basemap: { ...BASEMAP_DEFAULT },
  newType: "T",
  mode: null,           // null or "place" (tap the map to set the position of placeFor)
  placeFor: null,
  pin: null,
  watchId: null,
  lastFix: null,        // {e, n, acc, time}
  target: null,         // point key to navigate to
  listFilter: "all",
  projectFilter: "",
  thumbUrls: [],
  pendingPhoto: null,   // {kind, replaceId}
};
let map;

// ---------------------------------------------------------------- helpers
function toast(text, ms = 3000) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function fmt(n, digits = 3) {
  return Number(n).toLocaleString("en-SG", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function today() {
  return new Date().toLocaleDateString("en-CA");      // YYYY-MM-DD, local date
}

function confirmBox(text, yes = "OK") {
  const dlg = $("#confirm-dialog");
  $("#confirm-text").textContent = text;
  $("#confirm-yes").textContent = yes;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true }));
}

function origin() {
  return state.project?.origin || DEFAULT_ORIGIN;
}

function toWorld(e, n) {
  const [e0, n0] = origin();
  return [e - e0, n - n0];
}

function toEN(x, y) {
  const [e0, n0] = origin();
  return { e: e0 + x, n: n0 + y };
}

// Where a point is drawn: its surveyed coordinates, else its approximate position.
function positionOf(p) {
  if (p.survey && Number.isFinite(p.survey.e) && Number.isFinite(p.survey.n)) return { e: p.survey.e, n: p.survey.n, approx: false };
  if (p.approx && Number.isFinite(p.approx.e)) return { e: p.approx.e, n: p.approx.n, approx: true };
  return null;
}

function keyOf(p) {
  return state.view === "master" ? `${p.project}|${p.no}` : p.no;
}

function isDead(p) {
  return p.status === "destroyed" || p.status === "void";
}

// ---------------------------------------------------------------- numbers already used
function usedRd() {
  const used = new Set(state.officeRd);
  for (const list of Object.values(state.retired)) for (const n of list) if (typeOf(n) === "RD") used.add(n);
  for (const [, no] of state.allKeys) if (typeOf(no) === "RD") used.add(no);
  for (const n of state.master?.used_rd || []) used.add(n);
  return used;
}

function usedInProject(code) {
  const used = new Set(state.project?.code === code ? state.project.officeUsed || [] : []);
  for (const n of state.retired[code] || []) used.add(n);
  for (const [project, no] of state.allKeys) if (project === code) used.add(no);
  for (const p of state.master?.control || []) if (p.project === code) used.add(normalize(p.no));
  return used;
}

async function refreshKeys() {
  state.allKeys = await db.allPointKeys();
}

// ---------------------------------------------------------------- home
async function renderHome() {
  const projects = (await db.listProjects()).sort((a, b) => naturalCompare(a.code, b.code));
  const list = $("#project-list");
  list.innerHTML = "";
  $("#no-projects").hidden = projects.length > 0;
  const notExported = [];
  for (const pr of projects) {
    const points = await db.getPoints(pr.code);
    const pending = points.filter((p) => p.updated !== p.exported).length;
    if (pending) notExported.push(`${pr.code}: ${pending}`);
    const li = document.createElement("li");
    const counts = ["RD", "T", "P"].map((t) => `${points.filter((p) => p.type === t).length} ${t === "P" ? "personal" : t}`);
    li.innerHTML = `<div class="project-main"><div class="project-name">${esc(pr.code)}${pr.name ? " – " + esc(pr.name) : ""}</div>
      <div class="muted small">${counts.join(" · ")}${pr.packCreated ? ` · pack ${esc(pr.packCreated.slice(0, 10))}` : " · no pack yet"}
      ${pending ? ` · <b class="warn-text">${pending} not exported</b>` : ""}</div></div>
      <button class="btn small ghost" data-remove="${esc(pr.code)}">Remove</button>`;
    li.querySelector(".project-main").onclick = () => openProject(pr.code);
    li.querySelector("[data-remove]").onclick = () => removeProject(pr.code, pending);
    list.appendChild(li);
  }
  const note = $("#backup-note");
  note.hidden = notExported.length === 0;
  note.textContent = `Not exported yet (${notExported.join(", ")}). Export at the end of each day: until then this ` +
    "phone has the only copy.";
  $("#setup-note").hidden = Boolean(state.surveyor && !checkPrefix(state.prefix));
  $("#master-card").hidden = !state.master;
  if (state.master) {
    $("#master-info").textContent = `${state.master.control.length} control points in ${state.master.projects.length} ` +
      `projects, made ${state.master.created.slice(0, 10)}.`;
  }
  if (navigator.storage?.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    $("#storage-info").textContent = `Storage used: ${(usage / 1e6).toFixed(1)} MB of ${(quota / 1e6).toFixed(0)} MB`;
  }
}

async function removeProject(code, pending) {
  const text = pending
    ? `${code} has ${pending} point(s) not exported. Removing it deletes them from this phone for good. Remove ${code}?`
    : `Remove ${code} and its photos from this phone? Its numbers stay used.`;
  if (!(await confirmBox(text, "Remove"))) return;
  const points = await db.getPoints(code);
  const project = await db.getProject(code);
  state.retired[code] = [...new Set([...(state.retired[code] || []), ...points.map((p) => p.no),
    ...(project?.officeUsed || [])])];
  await db.setSetting("retired", state.retired);
  await db.deleteProject(code);
  await refreshKeys();
  renderHome();
}

async function newProject() {
  const code = normalizeProject($("#new-code").value);
  const error = checkProjectCode(code);
  $("#new-code-msg").textContent = error;
  if (error) return;
  if (!(await db.getProject(code))) {
    await db.putProject({ code, name: $("#new-name").value.trim(), created: new Date().toISOString(), officeUsed: [] });
  }
  $("#new-code").value = $("#new-name").value = "";
  openProject(code);
}

// ---------------------------------------------------------------- packs from the office
async function openPackFile(file) {
  try {
    const pack = JSON.parse(await file.text());
    await loadPack(pack, { save: true });
  } catch (err) {
    alert(`Could not open ${file.name}: ${err.message}`);
  }
}

function photoBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.match(/data:([^;]+)/)?.[1] || "image/jpeg" });
}

function officePoint(op, code) {
  const no = normalize(op.no);
  return {
    project: code, no, type: op.type || typeOf(no), surveyor: op.surveyor || "", date: op.date || "",
    created: op.created || op.updated || "", updated: op.updated || "", status: op.status || "ok",
    marker: op.marker || "", description: op.description || "", remarks: op.remarks || "",
    approx: op.approx || null, survey: op.survey || null, previous: op.previous || null, check: op.check || "",
    photos: [], origin: op.origin || "office", exported: op.updated || "",
  };
}

async function addOfficePhotos(rec, op, pack) {
  for (const ph of op.photos || []) {
    const data = ph.thumb && pack.photos?.[ph.thumb];
    if (!data) continue;
    const id = `${rec.project}|${rec.no}|office|${ph.thumb}`;
    await db.putPhoto({ id, project: rec.project, no: rec.no, kind: ph.kind, blob: photoBlob(data), taken: ph.taken,
      office: true });
    rec.photos.push({ id, kind: ph.kind, taken: ph.taken, office: true });
  }
}

const FIELD_FIELDS = ["surveyor", "date", "status", "marker", "description", "remarks", "approx"];

async function loadPack(pack, { save }) {
  if (pack.format === "cpsurvey-master-pack") {
    pack.control = pack.control.map((p) => ({ ...p, no: normalize(p.no), project: normalizeProject(p.project) }));
    if (save) {
      state.master = pack;
      await db.setSetting("master", pack);
      await rememberOfficeRd(pack.used_rd);
      toast(`Master register: ${pack.control.length} control points.`);
      renderHome();
    }
    openMaster(save ? null : pack);
    return;
  }
  if (pack.format !== "cpsurvey-project-pack") throw new Error("not a Control Point Survey pack");
  const code = normalizeProject(pack.project.code);
  const project = {
    ...(save ? (await db.getProject(code)) || {} : {}),
    code, name: pack.project.name || "", client: pack.project.client || "", location: pack.project.location || "",
    origin: pack.origin, view: pack.view, drawing: pack.drawing || null,
    background: pack.layers?.length || pack.texts?.length ? { layers: pack.layers, texts: pack.texts, points: pack.points } : null,
    officeUsed: (pack.used || []).map(normalize), packId: pack.pack_id, packCreated: pack.created,
    loadedAt: new Date().toISOString(),
  };
  if (!save) {                                              // look only (office map view): nothing is stored
    state.readonly = true;
    const points = new Map(pack.control.map((op) => [normalize(op.no), officePoint(op, code)]));
    showProject(project, points);
    return;
  }
  project.created = project.created || new Date().toISOString();
  await db.putProject(project);
  await rememberOfficeRd(pack.used_rd);
  const local = new Map((await db.getPoints(code)).map((p) => [p.no, p]));
  let added = 0, updated = 0;
  for (const op of pack.control) {
    const no = normalize(op.no);
    const lp = local.get(no);
    if (!lp) {
      const rec = officePoint(op, code);
      await addOfficePhotos(rec, op, pack);
      await db.putPoint(rec);
      added += 1;
      continue;
    }
    lp.survey = op.survey || null;          // surveyed coordinates always come from the office
    lp.previous = op.previous || null;
    lp.check = op.check || "";
    if ((op.updated || "") > (lp.updated || "")) {          // changed in the office after the last change here
      for (const f of FIELD_FIELDS) if (op[f] !== undefined) lp[f] = op[f];
      lp.updated = lp.exported = op.updated;
    }
    if (!lp.photos.some((ph) => !ph.office)) {             // office thumbnails only where this phone has no photo
      for (const ph of lp.photos) await db.deletePhoto(ph.id);
      lp.photos = [];
      await addOfficePhotos(lp, op, pack);
    }
    await db.putPoint(lp);
    updated += 1;
  }
  await refreshKeys();
  toast(`${code}: ${added} points added, ${updated} updated from the office.`, 5000);
  openProject(code);
}

async function rememberOfficeRd(list = []) {
  for (const n of list) state.officeRd.add(normalize(n));
  await db.setSetting("officeRd", [...state.officeRd]);
}

// ---------------------------------------------------------------- opening a project / the master register
async function openProject(code) {
  const project = await db.getProject(code);
  if (!project) return;
  state.readonly = false;
  const points = new Map((await db.getPoints(code)).map((p) => [p.no, p]));
  showProject(project, points);
  history.replaceState(null, "", `#project=${encodeURIComponent(code)}`);
}

function showProject(project, points) {
  state.view = "project";
  state.project = project;
  state.points = points;
  state.current = null;
  $("#home").hidden = true;
  $("#survey").hidden = false;
  $("#project-title").textContent = `${project.code}${project.name ? " – " + project.name : ""}`;
  $("#btn-add").hidden = state.readonly;
  $("#btn-export").hidden = state.readonly;
  fillProjectPicker();
  layoutVars();
  $("#drawing-row").hidden = !project.background;
  map.setBackground(project.background);
  map.setGeo(makeGeo(origin()));
  if (!project.background && !state.basemap.on) applyBasemap({ on: true });
  else applyBasemap();
  closePanels();
  refreshPoints();
  fitAll();
}

async function openMaster(pack = null) {
  const master = pack || state.master;
  if (!master) return;
  state.view = "master";
  state.readonly = true;
  state.project = { code: MASTER, name: "Master register", origin: masterOrigin(master) };
  const points = new Map();
  for (const p of master.control) points.set(`${p.project}|${p.no}`, officePoint(p, p.project));
  if (!pack) {                       // points recorded on this phone since the master was made are shown too
    for (const pr of await db.listProjects()) {
      for (const p of await db.getPoints(pr.code)) {
        const key = `${p.project}|${p.no}`;
        const office = points.get(key);
        points.set(key, office && (office.updated || "") > (p.updated || "") ? office : { ...p, survey: p.survey || office?.survey });
      }
    }
  }
  state.points = points;
  state.current = null;
  $("#home").hidden = true;
  $("#survey").hidden = false;
  $("#project-title").textContent = "Master register";
  $("#btn-add").hidden = true;
  $("#btn-export").hidden = true;
  $("#drawing-row").hidden = true;
  const sel = $("#project-filter");
  const codes = [...new Set([...points.values()].map((p) => p.project))].sort(naturalCompare);
  sel.innerHTML = `<option value="">All projects</option>` +
    codes.map((c) => `<option value="${esc(c)}">${esc(c)}${esc(master.projects.find((p) => p.code === c)?.name ? " – " + master.projects.find((p) => p.code === c).name : "")}</option>`).join("");
  sel.value = state.projectFilter = "";
  $("#project-filter-row").hidden = false;
  layoutVars();
  map.setBackground(null);
  map.setGeo(makeGeo(origin()));
  applyBasemap({ on: true });
  closePanels();
  refreshPoints();
  fitAll();
  if (!pack) history.replaceState(null, "", "#master");
}

// In a project: the projects on this phone, to switch without going back to the home screen. In the master
// register: a filter (filled by openMaster).
async function fillProjectPicker() {
  const sel = $("#project-filter");
  if (state.view !== "project" || state.readonly) {
    $("#project-filter-row").hidden = state.view !== "master";
    return;
  }
  const projects = (await db.listProjects()).sort((a, b) => naturalCompare(a.code, b.code));
  sel.innerHTML = projects.map((p) => `<option value="${esc(p.code)}">${esc(p.code)}${p.name ? " – " + esc(p.name) : ""}</option>`).join("");
  sel.value = state.project.code;
  $("#project-filter-row").hidden = false;
}

// The panels sit between the top bar and the bottom bar, whose heights depend on the phone (notch, home bar).
function layoutVars() {
  const head = $("#survey > header"), nav = $("#bottom-nav");
  const root = document.documentElement.style;
  if (head?.offsetHeight) root.setProperty("--bar-h", `${head.offsetHeight}px`);
  if (nav?.offsetHeight) root.setProperty("--nav-h", `${nav.offsetHeight}px`);
}

function masterOrigin(master) {
  const pos = master.control.map(positionOf).filter(Boolean);
  if (!pos.length) return DEFAULT_ORIGIN;
  return [Math.floor(Math.min(...pos.map((p) => p.e)) / 100) * 100, Math.floor(Math.min(...pos.map((p) => p.n)) / 100) * 100];
}

function goHome() {
  stopLocate();
  closePanels();
  setMode(null);
  state.view = null;
  state.readonly = false;
  $("#survey").hidden = true;
  $("#home").hidden = false;
  document.documentElement.style.setProperty("--nav-h", "0px");
  history.replaceState(null, "", "#");
  renderHome();
}

function visiblePoints() {
  return [...state.points.values()].filter((p) => !state.projectFilter || p.project === state.projectFilter);
}

function refreshPoints() {
  const items = [];
  for (const p of visiblePoints()) {
    const pos = positionOf(p);
    if (!pos) continue;
    const [x, y] = toWorld(pos.e, pos.n);
    items.push({ key: keyOf(p), label: p.no, x, y, type: p.type, approx: pos.approx, dead: isDead(p) });
  }
  map.setItems(items);
  const all = visiblePoints();
  const placed = all.filter(positionOf).length;
  const counts = ["RD", "T", "P"].map((t) => `${all.filter((p) => p.type === t).length} ${t === "P" ? "pers." : t}`);
  $("#progress").textContent = `${all.length} points (${counts.join(", ")}) · ${all.length - placed} without position`;
  if (!$("#list-panel").hidden) renderList();
}

function fitAll() {
  if (state.project?.view && state.view === "project") {
    map.fit(state.project.view);
    return;
  }
  const items = map.items;
  if (!items.length) {
    map.fit(SINGAPORE_VIEW.map((v, i) => v + (i % 2 === 0 ? DEFAULT_ORIGIN[0] - origin()[0] : DEFAULT_ORIGIN[1] - origin()[1])));
    return;
  }
  const xs = items.map((p) => p.x), ys = items.map((p) => p.y);
  const pad = 40;
  map.fit([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]);
}

// ---------------------------------------------------------------- list
function renderList() {
  const q = normalize($("#point-search").value);
  const list = $("#point-list");
  const rows = visiblePoints()
    .filter((p) => state.listFilter === "all" || (state.listFilter === "nopos" ? !positionOf(p) : p.type === state.listFilter))
    .filter((p) => !q || p.no.includes(q))
    .sort((a, b) => naturalCompare(a.project, b.project) || naturalCompare(a.no, b.no));
  list.innerHTML = "";
  for (const p of rows.slice(0, 500)) {
    const li = document.createElement("li");
    const pos = positionOf(p);
    const where = pos ? (pos.approx ? "approx." : "surveyed") : "no position";
    li.innerHTML = `<span class="pno"><i class="sym ${p.type.toLowerCase()}${pos?.approx ? " hollow" : ""}"></i>${esc(p.no)}</span>
      <span class="pinfo">${state.view === "master" ? esc(p.project) + " · " : ""}${esc(p.date || "")} · ${where}</span>
      ${p.status !== "ok" ? `<span class="status-chip ${p.status}">${STATUS_LABELS[p.status]}</span>` : ""}`;
    li.onclick = () => {
      if (window.innerWidth <= 720) $("#list-panel").hidden = true;
      selectPoint(keyOf(p), true);
    };
    list.appendChild(li);
  }
  if (rows.length > 500) list.insertAdjacentHTML("beforeend", `<li class="muted small">${rows.length - 500} more: search by number</li>`);
  if (!rows.length) list.innerHTML = `<li class="muted small">No points.</li>`;
}

// ---------------------------------------------------------------- one point
function selectPoint(key, center = false) {
  const p = state.points.get(key);
  if (!p) return;
  state.current = p;
  map.selected = key;
  const pos = positionOf(p);
  if (center && pos) map.centerOn(...toWorld(pos.e, pos.n), 2);
  map.draw();
  showPanel();
}

function closePanels() {
  $("#point-panel").hidden = true;
  $("#list-panel").hidden = true;
  $("#layers-panel").hidden = true;
  state.current = null;
  map.selected = null;
  map.draw();
}

function kv(rows) {
  return rows.filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
}

function showPanel() {
  const p = state.current;
  if (!p) return;
  const ro = state.readonly;
  $("#point-panel").hidden = false;
  $("#pt-title").textContent = p.no;
  $("#pt-sub").textContent = `${TYPE_LABELS[p.type]} · ${state.view === "master" ? p.project + " · " : ""}set ${p.date || "?"}` +
    `${p.surveyor ? " by " + p.surveyor : ""}`;
  const st = $("#pt-status-text");                          // shown only when not OK; changed under Status below
  st.hidden = p.status === "ok";
  st.textContent = STATUS_LABELS[p.status] || p.status;
  st.className = `status-text ${p.status}`;
  $("#pt-next").hidden = ro || state.view !== "project";
  $("#pt-done").textContent = ro ? "Close" : "Done";
  $("#pt-readonly").hidden = !(ro && state.view === "master");
  const pos = positionOf(p);
  $("#pt-gps").hidden = $("#pt-tap").hidden = ro;
  $("#pt-nav").hidden = !pos;
  $("#pt-pos-btns").hidden = ro && !pos;

  const s = p.survey;
  $("#pt-survey").innerHTML = s ? kv([
    ["Northing", fmt(s.n)], ["Easting", fmt(s.e)],
    ["RL", s.rl != null ? fmt(s.rl) + (s.rl_from ? ` (levelled ${s.rl_from})` : "") : "–"], ["Code", s.code],
    ["Surveyed", s.date], ["File", s.source],
    ["Re-survey", p.previous ? `ΔN ${signed(s.n - p.previous.n)}  ΔE ${signed(s.e - p.previous.e)}` +
      (s.rl != null && !s.rl_from && p.previous.rl != null ? `  ΔH ${signed(s.rl - p.previous.rl)}` : "") : ""],
  ]) + (p.check ? `<p class="warn small">${esc(p.check)}</p>` : "")
    : `<p class="muted small">Not surveyed yet. The office imports the survey data and sends it back in the project pack.</p>`;
  const a = p.approx;
  $("#pt-approx").innerHTML = a ? kv([["Northing", fmt(a.n, 1)], ["Easting", fmt(a.e, 1)],
    ["From", a.source === "gps" ? `phone GPS ±${Math.round(a.acc || 0)} m` : "tap on the map"]])
    : `<p class="muted small">None yet: use GPS standing at the point, or tap its place on the map.</p>`;
  $("#pt-marker").value = p.marker || "";
  $("#pt-description").value = p.description || "";
  $("#pt-remarks").value = p.remarks || "";
  for (const el of [$("#pt-marker"), $("#pt-description"), $("#pt-remarks")]) el.disabled = ro;
  $$("#pt-status button").forEach((b) => {
    b.classList.toggle("on", b.dataset.status === p.status);
    b.disabled = ro;
  });
  $("#pt-gps-msg").textContent = "";
  renderPhotos();
}

function signed(v) {
  return `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
}

async function savePoint(rec, changes) {
  if (state.readonly) return;
  Object.assign(rec, changes);
  rec.updated = new Date().toISOString();
  await db.putPoint(rec);
  refreshPoints();
  if (rec === state.current) showPanel();
}

// ---------------------------------------------------------------- new point
function openNewDialog() {
  if (!state.surveyor) {
    alert("Enter your name on the home screen first (Surveyor).");
    return;
  }
  setNewType(state.newType);
  $("#new-dialog").showModal();
  setTimeout(() => $("#new-no").select(), 50);
}

function setNewType(kind) {
  state.newType = kind;
  db.setSetting("newType", kind);
  $$("#new-type button").forEach((b) => b.classList.toggle("on", b.dataset.type === kind));
  const code = state.project.code;
  $("#new-no").value = nextNumber(kind, { usedInProject: usedInProject(code), usedRd: usedRd(), prefix: state.prefix });
  const prefixError = kind === "P" ? checkPrefix(state.prefix) : "";
  $("#new-info").textContent = (prefixError ? `Personal prefix: ${prefixError} (home screen). ` : "") +
    `Date ${today()} · ${state.surveyor} · project ${code}`;
  checkNewNumber();
}

function checkNewNumber() {
  const r = checkNumber($("#new-no").value, state.newType,
    { usedInProject: usedInProject(state.project.code), usedRd: usedRd() });
  const msg = $("#new-msg");
  msg.textContent = r.error || r.warning || (r.no ? `${r.no} is free.` : "");
  msg.className = `small ${r.error ? "error-text" : r.warning ? "warn-text" : "ok-text"}`;
  $("#new-ok").disabled = Boolean(r.error);
  return r;
}

async function createPoint() {
  const r = checkNewNumber();
  if (r.error) return;
  const now = new Date().toISOString();
  const rec = {
    project: state.project.code, no: r.no, type: r.type, surveyor: state.surveyor, date: today(),
    created: now, updated: now, status: "ok", marker: "", description: "", remarks: "",
    approx: null, survey: null, previous: null, check: "", photos: [], origin: "field", exported: null,
  };
  await db.putPoint(rec);
  state.points.set(rec.no, rec);
  await refreshKeys();
  refreshPoints();
  selectPoint(rec.no);
  toast(`${rec.no} saved. Now set its position and take photos.`, 4000);
}

// ---------------------------------------------------------------- position: GPS or a tap on the map
function fixFrom(pos) {
  const [e, n] = window.proj4("EPSG:4326", SVY21, [pos.coords.longitude, pos.coords.latitude]);
  return { e, n, acc: pos.coords.accuracy, time: pos.timestamp };
}

function useGps() {
  const rec = state.current;
  if (!rec || !navigator.geolocation) {
    toast("This device has no GPS.");
    return;
  }
  const msg = $("#pt-gps-msg");
  msg.textContent = "Getting GPS position…";
  const keep = (fix) => {
    savePoint(rec, { approx: { e: round(fix.e, 3), n: round(fix.n, 3), source: "gps", acc: Math.round(fix.acc),
      time: new Date(fix.time).toISOString() } });
    if (fix.acc > 20) toast(`GPS accuracy only ±${Math.round(fix.acc)} m: tap on the map if you know better.`, 5000);
  };
  if (state.lastFix && Date.now() - state.lastFix.time < 5000 && state.lastFix.acc < 15) {
    keep(state.lastFix);
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => keep(fixFrom(pos)), (err) => {
    msg.textContent = `No GPS position (${err.message}). Allow location for this app, or tap on the map.`;
  }, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
}

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function setMode(mode, forKey = null) {
  state.mode = mode;
  state.placeFor = forKey;
  state.pin = null;
  map.pin = null;
  $("#place-bar").hidden = mode !== "place";
  $("#place-done").disabled = true;
  $("#place-text").textContent = "Tap the map where the point is";
  map.draw();
}

function startPlacing() {
  const rec = state.current;
  if (!rec) return;
  const key = keyOf(rec);
  $("#point-panel").hidden = true;
  setMode("place", key);
  const pos = positionOf(rec);
  if (pos) {
    state.pin = toWorld(pos.e, pos.n);
    map.pin = { x: state.pin[0], y: state.pin[1] };
    map.centerOn(...state.pin);
  }
}

async function finishPlacing(use) {
  const key = state.placeFor;
  const pin = state.pin;
  setMode(null);
  const rec = state.points.get(key);
  if (!rec) return;
  state.current = rec;
  if (use && pin) {
    const { e, n } = toEN(...pin);
    await savePoint(rec, { approx: { e: round(e, 3), n: round(n, 3), source: "map", acc: null, time: new Date().toISOString() } });
  }
  selectPoint(key);
}

function onMapTap({ item, world }) {
  if (state.mode === "place") {
    state.pin = world;
    map.pin = { x: world[0], y: world[1] };
    const { e, n } = toEN(...world);
    $("#place-text").textContent = `N ${fmt(n, 1)}  E ${fmt(e, 1)} · tap again to adjust`;
    $("#place-done").disabled = false;
    map.draw();
    return;
  }
  $("#layers-panel").hidden = true;
  if (item) selectPoint(item.key);
  else if (!$("#point-panel").hidden && window.innerWidth > 720) closePanels();
}

// ---------------------------------------------------------------- locate and navigate
function startLocate() {
  if (!navigator.geolocation) {
    toast("This device has no GPS.");
    return;
  }
  if (state.watchId !== null) return;
  let first = true;
  state.watchId = navigator.geolocation.watchPosition((pos) => {
    state.lastFix = fixFrom(pos);
    const [x, y] = toWorld(state.lastFix.e, state.lastFix.n);
    map.location = { x, y, acc: state.lastFix.acc };
    if (first && !state.target) map.centerOn(x, y, 1);
    first = false;
    updateNav();
    map.draw();
  }, (err) => {
    toast(`No GPS position: ${err.message}`, 5000);
    stopLocate();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  $("#btn-locate").classList.add("on");
}

function stopLocate() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.lastFix = null;
  map.location = null;
  state.target = null;
  map.target = null;
  $("#nav-bar").hidden = true;
  $("#btn-locate").classList.remove("on");
  map.draw();
}

function navigateTo(key) {
  const p = state.points.get(key);
  const pos = p && positionOf(p);
  if (!pos) return;
  state.target = key;
  const [x, y] = toWorld(pos.e, pos.n);
  map.target = { x, y };
  startLocate();
  if (window.innerWidth <= 720) $("#point-panel").hidden = true;
  updateNav();
  map.draw();
}

function updateNav() {
  const p = state.target && state.points.get(state.target);
  const pos = p && positionOf(p);
  if (!pos) {
    $("#nav-bar").hidden = true;
    return;
  }
  $("#nav-bar").hidden = false;
  if (!state.lastFix) {
    $("#nav-text").textContent = `${p.no}: waiting for GPS…`;
    return;
  }
  const de = pos.e - state.lastFix.e, dn = pos.n - state.lastFix.n;
  const dist = Math.hypot(de, dn);
  const bearing = (Math.atan2(de, dn) * 180 / Math.PI + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  $("#nav-arrow").style.transform = `rotate(${bearing}deg)`;
  $("#nav-text").textContent = `${p.no}: ${dist < 1000 ? dist.toFixed(0) + " m" : (dist / 1000).toFixed(2) + " km"} ` +
    `${dirs[Math.round(bearing / 45) % 8]} (GPS ±${Math.round(state.lastFix.acc)} m)`;
}

// ---------------------------------------------------------------- photos
// The panel is redrawn after every save, and two redraws can overlap (e.g. a new position saved while the panel
// opens again). The photos are read first and only the latest redraw puts them on the screen, so a photo is never
// shown twice.
async function renderPhotos() {
  const gen = (state.photoGen = (state.photoGen || 0) + 1);
  const rec = state.current;
  if (!rec) return;
  const extras = rec.photos.filter((ph) => ph.kind === "extra");
  const slots = [...PHOTO_SLOTS.map(([kind, label, hint]) => ({ kind, label, hint, photo: rec.photos.find((ph) => ph.kind === kind) })),
    ...extras.map((ph, i) => ({ kind: "extra", label: `Photo ${i + 3}`, hint: "", photo: ph }))];
  if (!state.readonly && extras.length < MAX_EXTRA_PHOTOS) slots.push({ kind: "extra", label: "+ Photo", hint: "more", photo: null });
  const blobs = await Promise.all(slots.map((s) => (s.photo ? db.getPhoto(s.photo.id) : null)));
  if (gen !== state.photoGen) return;                      // a newer redraw has started
  for (const url of state.thumbUrls) URL.revokeObjectURL(url);
  state.thumbUrls = [];
  const box = $("#pt-photos");
  box.innerHTML = "";
  slots.forEach((slot, i) => {
    if (state.readonly && !slot.photo) return;
    const div = document.createElement("div");
    div.className = "photo-slot";
    div.innerHTML = `<div class="thumb${slot.photo ? " has" : ""}"><img alt=""><span class="thumb-label">${esc(slot.label)}
      ${slot.hint ? `<small>${esc(slot.hint)}</small>` : ""}${slot.photo?.office ? "<small>(office copy)</small>" : ""}</span></div>
      ${!slot.photo && !state.readonly ? `<button class="btn small" type="button">Gallery</button>` : ""}`;
    const thumb = div.querySelector(".thumb");
    if (slot.photo && blobs[i]) {
      const url = URL.createObjectURL(blobs[i].blob);
      state.thumbUrls.push(url);
      div.querySelector("img").src = url;
      thumb.onclick = () => viewPhoto(slot.photo, url, slot.label);
    } else if (!slot.photo && !state.readonly) {
      thumb.onclick = () => pickPhoto(slot.kind, "camera");
      div.querySelector("button").onclick = () => pickPhoto(slot.kind, "gallery");
    }
    box.appendChild(div);
  });
  if (!box.children.length) box.innerHTML = `<p class="muted small">No photos on this device.</p>`;
}

function pickPhoto(kind, source) {
  state.pendingPhoto = { kind, key: keyOf(state.current) };
  const input = source === "camera" ? $("#photo-camera") : $("#photo-gallery");
  input.value = "";
  input.click();
}

async function photoChosen(file) {
  const pending = state.pendingPhoto;
  state.pendingPhoto = null;
  const rec = pending && state.points.get(pending.key);
  if (!file || !rec) return;
  try {
    const { blob, width, height } = await compressPhoto(file);
    const taken = new Date().toISOString();
    const id = `${rec.project}|${rec.no}|${pending.kind}|${Date.now()}`;
    await db.putPhoto({ id, project: rec.project, no: rec.no, kind: pending.kind, blob, taken, width, height });
    let photos = rec.photos;
    if (pending.kind !== "extra") {                           // close-up and wide view: one each, replaced
      for (const old of photos.filter((ph) => ph.kind === pending.kind)) await db.deletePhoto(old.id);
      photos = photos.filter((ph) => ph.kind !== pending.kind);
    }
    if (photos.length && photos.every((ph) => ph.office)) {   // the first own photo replaces the office copies
      for (const old of photos) await db.deletePhoto(old.id);
      photos = [];
    }
    await savePoint(rec, { photos: [...photos, { id, kind: pending.kind, taken }] });
  } catch (err) {
    alert(`The photo could not be saved: ${err.message}`);
  }
}

function viewPhoto(ph, url, label) {
  const dlg = $("#photo-dialog");
  $("#photo-big").src = url;
  $("#photo-cap").textContent = `${state.current.no} · ${label}${ph.taken ? " · " + ph.taken.slice(0, 16).replace("T", " ") : ""}`;
  $("#photo-remove").hidden = state.readonly;
  $("#photo-remove").onclick = async () => {
    if (!(await confirmBox("Remove this photo?", "Remove"))) return;
    dlg.close();
    const rec = state.current;
    await db.deletePhoto(ph.id);
    await savePoint(rec, { photos: rec.photos.filter((x) => x.id !== ph.id) });
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- export
function openExport() {
  const changed = exportCandidates(state.points, "changed").length;
  const all = exportCandidates(state.points, "all").length;
  $("#exp-changed").textContent = `Points changed since the last export (${changed})`;
  $("#exp-all").textContent = `All points recorded or changed on this phone (${all})`;
  $("input[name=exp-mode][value=changed]").checked = changed > 0;
  $("input[name=exp-mode][value=all]").checked = changed === 0;
  $("#exp-status").textContent = state.project.lastExport ? `Last export: ${state.project.lastExport.slice(0, 16).replace("T", " ")}` : "Not exported yet.";
  $("#exp-go").disabled = false;
  $("#export-dialog").showModal();
}

async function doExport() {
  const mode = $("input[name=exp-mode]:checked").value;
  const status = $("#exp-status");
  if (!exportCandidates(state.points, mode).length) {
    status.textContent = "Nothing to export.";
    return;
  }
  $("#exp-go").disabled = true;
  status.textContent = "Making the zip…";
  try {
    const result = await buildFieldZip({
      project: state.project, points: state.points, mode, getPhoto: (id) => db.getPhoto(id),
      surveyor: state.surveyor, prefix: state.prefix,
      onProgress: (i, n) => (status.textContent = `Making the zip… ${i} of ${n}`),
    });
    const how = await shareOrDownload(result.blob, result.name);
    if (how === "cancelled") {
      status.textContent = "Cancelled: nothing was sent.";
      $("#exp-go").disabled = false;
      return;
    }
    for (const rec of result.exported) {
      rec.exported = rec.updated;
      await db.putPoint(rec);
    }
    state.project.lastExport = new Date().toISOString();
    await db.putProject(state.project);
    $("#export-dialog").close();
    toast(how === "shared" ? `Sent ${result.name} (${result.exported.length} points, ${result.photoCount} photos)`
      : `Saved ${result.name} to Downloads. Send it to the office from the Files app.`, 8000);
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
    $("#exp-go").disabled = false;
  }
}

// ---------------------------------------------------------------- OneMap base map
function makeGeo([e0, n0]) {
  return {
    toLonLat: (x, y) => window.proj4(SVY21, "EPSG:4326", [e0 + x, n0 + y]),
    fromLonLat: (lon, lat) => {
      const [e, n] = window.proj4("EPSG:4326", SVY21, [lon, lat]);
      return [e - e0, n - n0];
    },
  };
}

function applyBasemap(changes = null) {
  if (changes) {
    Object.assign(state.basemap, changes);
    db.setSetting("basemap", state.basemap);
  }
  const b = state.basemap;
  map.setBasemap(b);
  $("#bm-on").checked = b.on;
  $("#dw-on").checked = b.drawing !== false;
  $("#bm-opacity").value = b.opacity;
  $("#bm-contrast").value = b.contrast;
  $("#bm-bright").value = b.brightness ?? 1;
  $$("#bm-styles .chip").forEach((c) => c.classList.toggle("on", c.dataset.style === b.style));
  $("#onemap-attr").hidden = !b.on;
  $("#btn-layers").classList.toggle("on", !$("#layers-panel").hidden);
}

// OneMap has no tiles for the open sea around Singapore, so single missing tiles are normal; only no connection
// at all is worth a message.
function onTileError() {
  if (!state.basemap.on || navigator.onLine || Date.now() - (onTileError.last || 0) < 60000) return;
  onTileError.last = Date.now();
  toast("No internet connection: the OneMap base map is not available. Points and the drawing still work.", 6000);
}

// ---------------------------------------------------------------- start
async function openFromLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("pack")) {
    try {
      const res = await fetch(params.get("pack"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadPack(await res.json(), { save: params.get("view") !== "1" });
      return true;
    } catch (err) {
      alert(`Could not open the pack from the link: ${err.message}`);
    }
  }
  if (params.get("project") && (await db.getProject(params.get("project")))) {
    await openProject(params.get("project"));
    return true;
  }
  if (params.has("master") && state.master) {
    await openMaster();
    return true;
  }
  return false;
}

function bind() {
  map = new PointMap($("#map"), {
    onTap: onMapTap,
    onMove: ([x, y]) => {
      if (state.mode === "place") return;
      const { e, n } = toEN(x, y);
      $("#coord").textContent = `N ${fmt(n, 1)}  E ${fmt(e, 1)}`;
    },
    onTileError,
  });

  $("#surveyor").addEventListener("change", (e) => {
    state.surveyor = e.target.value.trim();
    db.setSetting("surveyor", state.surveyor);
    renderHome();
  });
  $("#prefix").addEventListener("input", (e) => {
    $("#prefix-msg").textContent = checkPrefix(e.target.value);
  });
  $("#prefix").addEventListener("change", (e) => {
    const p = normalize(e.target.value);
    e.target.value = p;
    $("#prefix-msg").textContent = checkPrefix(p);
    if (!checkPrefix(p)) {
      state.prefix = p;
      db.setSetting("prefix", p);
    }
    renderHome();
  });
  $("#pack-file").addEventListener("change", (e) => {
    if (e.target.files[0]) openPackFile(e.target.files[0]);
    e.target.value = "";
  });
  $("#new-code").addEventListener("input", (e) => ($("#new-code-msg").textContent = e.target.value ? checkProjectCode(e.target.value) : ""));
  $("#new-project").onclick = newProject;
  $("#open-master").onclick = () => openMaster();

  $("#btn-home").onclick = goHome;
  $("#btn-list").onclick = () => {
    const panel = $("#list-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      if (window.innerWidth <= 720) $("#point-panel").hidden = true;
      renderList();
    }
  };
  $("#btn-locate").onclick = () => (state.watchId === null ? startLocate() : stopLocate());
  $("#btn-export").onclick = openExport;
  $("#exp-go").onclick = doExport;
  $("#btn-add").onclick = openNewDialog;
  $("#btn-layers").onclick = () => {
    $("#layers-panel").hidden = !$("#layers-panel").hidden;
    applyBasemap();
  };
  $("#zoom-in").onclick = () => map.zoomBy(1.6);
  $("#zoom-out").onclick = () => map.zoomBy(1 / 1.6);
  $("#zoom-fit").onclick = fitAll;
  $$("[data-close]").forEach((b) => (b.onclick = () => ($(`#${b.dataset.close}`).hidden = true)));
  $("#point-search").addEventListener("input", renderList);
  $$("#list-filters .chip").forEach((c) => (c.onclick = () => {
    state.listFilter = c.dataset.filter;
    $$("#list-filters .chip").forEach((x) => x.classList.toggle("on", x === c));
    renderList();
  }));
  $("#project-filter").addEventListener("change", async (e) => {
    if (state.view === "project") {                  // switch to another project on this phone
      await openProject(e.target.value);
      $("#list-panel").hidden = false;
      renderList();
      return;
    }
    state.projectFilter = e.target.value;            // master register: only this project's points
    refreshPoints();
    fitAll();
    renderList();
  });
  $("#nav-home").onclick = goHome;
  new MutationObserver(() => $("#btn-list").classList.toggle("on", !$("#list-panel").hidden))
    .observe($("#list-panel"), { attributes: true, attributeFilter: ["hidden"] });
  $("#pt-done").onclick = () => {
    const rec = state.current;
    closePanels();
    if (rec && !state.readonly) toast(`${rec.no} saved.`);
  };
  $("#pt-next").onclick = () => {
    closePanels();
    openNewDialog();
  };
  window.addEventListener("resize", layoutVars);

  // new point
  $$("#new-type button").forEach((b) => (b.onclick = () => setNewType(b.dataset.type)));
  $("#new-no").addEventListener("input", checkNewNumber);
  $("#new-no").addEventListener("keydown", (e) => {     // Enter saves (the first button of the form is Cancel)
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!checkNewNumber().error) {
      $("#new-dialog").close();
      createPoint();
    }
  });
  $("#new-form").addEventListener("submit", (e) => {
    if (e.submitter?.value === "ok") {
      e.preventDefault();
      if (!checkNewNumber().error) {
        $("#new-dialog").close();
        createPoint();
      }
    }
  });

  // point panel
  $("#pt-close").onclick = closePanels;
  $("#pt-gps").onclick = useGps;
  $("#pt-tap").onclick = startPlacing;
  $("#pt-nav").onclick = () => state.current && navigateTo(keyOf(state.current));
  $("#place-cancel").onclick = () => finishPlacing(false);
  $("#place-done").onclick = () => finishPlacing(true);
  $("#nav-clear").onclick = () => {
    state.target = null;
    map.target = null;
    $("#nav-bar").hidden = true;
    map.draw();
  };
  $("#pt-marker").addEventListener("change", (e) => state.current && savePoint(state.current, { marker: e.target.value }));
  for (const field of ["description", "remarks"]) {
    $(`#pt-${field}`).addEventListener("change", (e) => state.current && savePoint(state.current, { [field]: e.target.value.trim() }));
  }
  $$("#pt-status button").forEach((b) => (b.onclick = async () => {
    const rec = state.current;
    if (!rec || rec.status === b.dataset.status) return;
    const s = b.dataset.status;
    if ((s === "void" || s === "destroyed") &&
        !(await confirmBox(`Mark ${rec.no} as ${STATUS_LABELS[s].toLowerCase()}? The number stays used and will not be given again.`))) return;
    savePoint(rec, { status: s });
  }));
  $("#photo-camera").addEventListener("change", (e) => photoChosen(e.target.files[0]));
  $("#photo-gallery").addEventListener("change", (e) => photoChosen(e.target.files[0]));

  // base map
  $("#bm-on").addEventListener("change", (e) => applyBasemap({ on: e.target.checked }));
  $("#dw-on").addEventListener("change", (e) => applyBasemap({ drawing: e.target.checked }));
  $("#bm-opacity").addEventListener("input", (e) => applyBasemap({ opacity: Number(e.target.value) }));
  $("#bm-contrast").addEventListener("input", (e) => applyBasemap({ contrast: Number(e.target.value) }));
  $("#bm-bright").addEventListener("input", (e) => applyBasemap({ brightness: Number(e.target.value) }));
  $$("#bm-styles .chip").forEach((c) => (c.onclick = () => applyBasemap({ style: c.dataset.style, on: true })));
}

async function start() {
  bind();
  $("#app-version").textContent = `App version ${APP_VERSION}`;
  state.surveyor = await db.getSetting("surveyor", "");
  state.prefix = await db.getSetting("prefix", "");
  state.newType = await db.getSetting("newType", "T");
  state.officeRd = new Set(await db.getSetting("officeRd", []));
  state.retired = await db.getSetting("retired", {});
  state.master = await db.getSetting("master", null);
  state.basemap = { ...BASEMAP_DEFAULT, ...(await db.getSetting("basemap", {})) };
  $("#surveyor").value = state.surveyor;
  $("#prefix").value = state.prefix;
  await refreshKeys();
  if (navigator.storage?.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  await renderHome();
  await openFromLink();
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).get("pack")) openFromLink();
  });
}

window.addEventListener("load", start);
