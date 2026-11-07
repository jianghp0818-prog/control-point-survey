// Offline storage on the phone (IndexedDB).
//   projects  one entry per project code: name, drawing background and office data from the last project pack
//   points    one entry per point, key [project, no]
//   photos    compressed JPEG photos, key id; index by project
//   settings  small values: surveyor, personal prefix, base map, RD numbers known from the office, master register

const DB_NAME = "cpsurvey";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("projects", { keyPath: "code" });
        db.createObjectStore("points", { keyPath: ["project", "no"] }).createIndex("project", "project");
        db.createObjectStore("photos", { keyPath: "id" }).createIndex("project", "project");
        db.createObjectStore("settings");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  async listProjects() {
    return done((await store("projects")).getAll());
  },
  async getProject(code) {
    return done((await store("projects")).get(code));
  },
  async putProject(project) {
    return done((await store("projects", "readwrite")).put(project));
  },
  async deleteProject(code) {
    const tx = (await open()).transaction(["projects", "points", "photos"], "readwrite");
    tx.objectStore("projects").delete(code);
    for (const name of ["points", "photos"]) {
      const index = tx.objectStore(name).index("project");
      index.openKeyCursor(IDBKeyRange.only(code)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    }
    return finished(tx);
  },

  async getPoints(project) {
    return done((await store("points")).index("project").getAll(IDBKeyRange.only(project)));
  },
  async allPointKeys() {
    return done((await store("points")).getAllKeys());     // [[project, no], ...]
  },
  async putPoint(point) {
    return done((await store("points", "readwrite")).put(point));
  },
  async putPoints(points) {
    const tx = (await open()).transaction("points", "readwrite");
    for (const p of points) tx.objectStore("points").put(p);
    return finished(tx);
  },

  async getPhoto(id) {
    return done((await store("photos")).get(id));
  },
  async putPhoto(photo) {
    return done((await store("photos", "readwrite")).put(photo));
  },
  async deletePhoto(id) {
    return done((await store("photos", "readwrite")).delete(id));
  },

  async getSetting(key, fallback = null) {
    const value = await done((await store("settings")).get(key));
    return value === undefined ? fallback : value;
  },
  async setSetting(key, value) {
    return done((await store("settings", "readwrite")).put(value, key));
  },
};
