// Point numbers (the same rules as cpsurvey/numbers.py).
//   RD  main control points: RD + 2-digit year + 3-digit sequence, e.g. RD26001; RD27001 is the first of 2027.
//       An RD number is never used twice: not in another project, not in another year. Gaps are allowed.
//   T   temporary / secondary points: T1, T2, ... unique within a project; every project starts at T1.
//   P   the surveyor's own numbers: personal prefix + sequence (JHP1) or any other text; unique within a project.
// A number once saved stays used, also when the point is later destroyed or made void.

export const TYPE_LABELS = { RD: "Main control (RD)", T: "Temporary (T)", P: "Personal" };
const RD_RE = /^RD(\d{2})(\d{3,})$/;
const T_RE = /^T(\d+)$/;
const ALLOWED_RE = /^[A-Z0-9._-]+$/;
const PROJECT_RE = /^[A-Z0-9][A-Z0-9._-]{0,23}$/;

export function normalize(no) {
  const n = String(no ?? "").replace(/\s+/g, "").toUpperCase();
  const m = n.match(T_RE);
  return m ? `T${parseInt(m[1], 10)}` : n;
}

export function typeOf(no) {
  const n = normalize(no);
  if (RD_RE.test(n)) return "RD";
  if (T_RE.test(n)) return "T";
  return "P";
}

export function rdYear(no) {
  const m = normalize(no).match(RD_RE);
  return m ? m[1] : null;
}

export function yearCode(day = new Date()) {
  return String(day.getFullYear() % 100).padStart(2, "0");
}

export function normalizeProject(code) {
  return String(code ?? "").replace(/\s+/g, "").toUpperCase();
}

export function checkProjectCode(code) {
  const c = normalizeProject(code);
  if (!c) return "Enter a project code";
  if (!PROJECT_RE.test(c)) return "Project code: letters, digits, - _ . only (up to 24)";
  return "";
}

export function checkPrefix(prefix) {
  const p = normalize(prefix);
  if (!p) return "Enter your initials";
  if (!/^[A-Z]{1,6}$/.test(p)) return "Personal prefix: letters only, up to 6";
  if (p === "T") return "T is used for temporary points";
  if (p.startsWith("RD")) return "RD is used for main control points";
  return "";
}

function maxSeq(numbers, re) {
  let best = 0;
  for (const n of numbers) {
    const m = n.match(re);
    if (m) best = Math.max(best, parseInt(m[1], 10));
  }
  return best;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The next free number of a type: RD after the highest RD of this year, T and personal after the highest in the
// project (gaps are not filled).
export function nextNumber(kind, { usedInProject = [], usedRd = [], prefix = "", day = new Date() } = {}) {
  if (kind === "RD") {
    const yy = yearCode(day);
    const seq = maxSeq(usedRd, new RegExp(`^RD${yy}(\\d{3,})$`)) + 1;
    return `RD${yy}${String(seq).padStart(3, "0")}`;
  }
  if (kind === "T") return `T${maxSeq(usedInProject, T_RE) + 1}`;
  const p = normalize(prefix);
  if (checkPrefix(p)) return "";
  return `${p}${maxSeq(usedInProject, new RegExp(`^${escapeRe(p)}(\\d+)$`)) + 1}`;
}

// {no, type, error, warning}; kind null accepts any type. usedInProject and usedRd are Sets.
export function checkNumber(no, kind, { usedInProject = new Set(), usedRd = new Set(), day = new Date() } = {}) {
  const n = normalize(no);
  const out = (error, warning = "") => ({ no: n, type: typeOf(n), error, warning });
  if (!n) return out("Enter a number");
  if (!ALLOWED_RE.test(n)) return out("Use letters, digits, - _ . only");
  const actual = typeOf(n);
  if (kind === "RD" && actual !== "RD") return out("Main control numbers are RD + year + 3 digits, e.g. RD26001");
  if (kind === "T" && actual !== "T") return out("Temporary numbers are T + a number, e.g. T12");
  if (kind === "P" && actual !== "P") return out(`${n} is a ${TYPE_LABELS[actual]} number: choose that type`);
  if (actual === "RD" && usedRd.has(n)) return out(`${n} is already used (RD numbers are never used twice)`);
  if (usedInProject.has(n)) return out(`${n} is already used in this project`);
  if (actual === "RD" && rdYear(n) !== yearCode(day)) {
    return out("", `${n} has year ${rdYear(n)}, not this year (${yearCode(day)})`);
  }
  return out("");
}

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
