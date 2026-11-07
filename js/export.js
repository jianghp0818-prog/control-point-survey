// Field export for the office, one zip per project:
//   field.json   format "cpsurvey-field": the points with their approximate SVY21 positions and field details
//   points.csv   the same as a table (opens in Excel)
//   photos/      <point no>_close.jpg, <point no>_wide.jpg, <point no>_extra1.jpg ...
// Photos that came from the office (thumbnails in a project pack) are not sent back.

export const STATUS_LABELS = { ok: "OK", disturbed: "Disturbed", destroyed: "Destroyed", void: "Void" };

const CSV_COLUMNS = [
  ["Point No.", (r) => r.no],
  ["Type", (r) => r.type],
  ["Status", (r) => STATUS_LABELS[r.status] || r.status],
  ["Date Set", (r) => r.date],
  ["Surveyor", (r) => r.surveyor],
  ["Approx. Northing", (r) => r.approx?.n?.toFixed(3)],
  ["Approx. Easting", (r) => r.approx?.e?.toFixed(3)],
  ["Approx. From", (r) => (r.approx ? (r.approx.source === "gps" ? `GPS ±${Math.round(r.approx.acc || 0)} m` : "Map") : "")],
  ["Marker", (r) => r.marker],
  ["Description", (r) => r.description],
  ["Remarks", (r) => r.remarks],
  ["Photos", (r) => r.photos.length],
  ["Last Saved", (r) => r.updated],
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function fileKey(no) {
  return no.replace(/[^\w.-]+/g, "_");
}

export function exportCandidates(points, mode) {
  return [...points.values()].filter((p) => mode === "all" ? p.origin === "field" || p.updated !== p.exported
    : p.updated !== p.exported);
}

export async function buildFieldZip({ project, points, mode, getPhoto, surveyor, prefix, onProgress }) {
  const zip = new window.JSZip();
  const list = exportCandidates(points, mode).sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));
  const out = [];
  let photoCount = 0;
  for (const [i, rec] of list.entries()) {
    const photos = [];
    const counts = {};
    for (const ph of rec.photos || []) {
      if (ph.office) continue;
      const photo = await getPhoto(ph.id);
      if (!photo) continue;
      counts[ph.kind] = (counts[ph.kind] || 0) + 1;
      const suffix = ph.kind === "extra" ? `extra${counts.extra}` : ph.kind;
      const name = `photos/${fileKey(rec.no)}_${suffix}.jpg`;
      zip.file(name, photo.blob, { compression: "STORE", date: new Date(photo.taken || Date.now()) });
      photos.push({ kind: ph.kind, file: name, taken: photo.taken });
      photoCount += 1;
    }
    const { exported, photos: _ids, ...fields } = rec;
    out.push({ ...fields, photos });
    onProgress?.(i + 1, list.length);
  }
  const exportedAt = new Date().toISOString();
  zip.file("field.json", JSON.stringify({
    format: "cpsurvey-field",
    version: 1,
    project: { code: project.code, name: project.name || "" },
    crs: "EPSG:3414",
    exported: exportedAt,
    mode,
    surveyor,
    prefix,
    device: navigator.userAgent,
    records: out,
  }, null, 1));
  const csv = [CSV_COLUMNS.map(([h]) => h).join(",")]
    .concat(out.map((r) => CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(",")))
    .join("\r\n");
  zip.file("points.csv", "﻿" + csv);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/zip" });
  return { blob, name: `${fileKey(project.code)}_field_${stamp()}.zip`, exported: list, photoCount };
}

export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: "application/zip" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      // sharing refused (e.g. file too large): save it instead
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
