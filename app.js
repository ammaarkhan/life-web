/* life · local-first tracker, synced to a private github repo.
   the page renders nothing without a token; all content lives in life-data. */

"use strict";

// ---------- constants ----------

const DATA_REPO = "ammaarkhan/life-data";
const API = `https://api.github.com/repos/${DATA_REPO}/contents`;
const LS = { token: "life.token", log: "life.log", config: "life.config" };
const PUSH_DEBOUNCE_MS = 1500;
const DAY_MS = 24 * 3600 * 1000;

// ---------- state ----------

const state = {
  token: localStorage.getItem(LS.token) || "",
  config: null, // { data, sha }
  log: null, // { data, sha, dirty }
  view: "day",
  dayISO: todayISO(),
  calMonth: null, // "2026-07"
};

// ---------- date helpers ----------

function pad(n) {
  return String(n).padStart(2, "0");
}
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayISO() {
  return iso(new Date());
}
function fromISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function weekIndex(monday, epochISO) {
  return Math.round((monday - fromISO(epochISO)) / (7 * DAY_MS));
}
function fmtLong(dISO) {
  const d = fromISO(dISO);
  const wd = d.toLocaleDateString("en-GB", { weekday: "long" }).toLowerCase();
  const mo = d.toLocaleDateString("en-GB", { month: "short" }).toLowerCase();
  return `${wd} · ${d.getDate()} ${mo}`;
}
function fmtShort(dISO) {
  const d = fromISO(dISO);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase();
  const mo = d.toLocaleDateString("en-GB", { month: "short" }).toLowerCase();
  return `${wd} ${d.getDate()} ${mo}`;
}

// ---------- schedule ----------

function gymLetters(wIdx) {
  const even = ((wIdx % 2) + 2) % 2 === 0;
  return even ? ["A", "B", "A"] : ["B", "A", "B"];
}

function dayPlan(dISO) {
  const cfg = state.config.data;
  const d = fromISO(dISO);
  const mon = mondayOf(d);
  const dow = Math.round((d - mon) / DAY_MS); // 0 mon … 6 sun
  const tpl = cfg.week[dow];
  if (tpl.type === "gym") {
    const letters = gymLetters(weekIndex(mon, cfg.epochMonday));
    const gymIdx = cfg.week.slice(0, dow).filter((x) => x.type === "gym").length;
    const letter = letters[gymIdx];
    return { type: "gym", letter, label: `gym · workout ${letter}` };
  }
  return { type: tpl.type, label: tpl.label };
}

function checklistFor(dISO) {
  const cfg = state.config.data;
  const d = fromISO(dISO);
  const dow = Math.round((d - mondayOf(d)) / DAY_MS);
  const plan = dayPlan(dISO);
  const items = [];
  for (const it of cfg.checklist) {
    if (it.weekdaysOnly && dow > 4) continue;
    if (it.fridayOnly && dow !== 4) continue;
    if (it.key === "main") {
      items.push({ key: "main", label: plan.label, main: true, plan, group: it.group });
    } else {
      items.push(it);
    }
  }
  return items;
}

// ---------- local storage ----------

function loadLocal() {
  try {
    state.config = JSON.parse(localStorage.getItem(LS.config));
  } catch (e) {
    state.config = null;
  }
  try {
    state.log = JSON.parse(localStorage.getItem(LS.log));
  } catch (e) {
    state.log = null;
  }
}
function saveConfigLocal() {
  localStorage.setItem(LS.config, JSON.stringify(state.config));
}
function saveLogLocal() {
  localStorage.setItem(LS.log, JSON.stringify(state.log));
}

// ---------- github api ----------

function b64encode(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function b64decode(s) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0))
  );
}

async function ghGet(file) {
  const res = await fetch(`${API}/${file}`, {
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: "application/vnd.github+json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = new Error(`GET ${file} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}

async function ghPut(file, data, sha, message) {
  const body = { message, content: b64encode(JSON.stringify(data, null, 2)) };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/${file}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`PUT ${file} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return j.content.sha;
}

// ---------- merge & sync ----------

function newer(x, y) {
  if (!x) return y;
  if (!y) return x;
  return (x.updatedAt || "") >= (y.updatedAt || "") ? x : y;
}

function mergeLogs(a, b) {
  const out = { version: 1, days: {}, lifts: {}, weights: {} };
  for (const part of ["days", "lifts", "weights"]) {
    const keys = new Set([
      ...Object.keys(a[part] || {}),
      ...Object.keys(b[part] || {}),
    ]);
    for (const k of keys) {
      out[part][k] = newer((a[part] || {})[k], (b[part] || {})[k]);
    }
  }
  return out;
}

function setSync(status) {
  const dot = document.getElementById("sync-dot");
  if (!dot) return;
  dot.classList.remove("syncing", "offline");
  if (status === "syncing") {
    dot.classList.add("syncing");
    dot.title = "syncing";
  } else if (status === "offline" || status === "error") {
    dot.classList.add("offline");
    dot.title = status === "error" ? "sync error" : "offline · will retry";
  } else {
    dot.title = "synced";
  }
}

async function refreshRemote() {
  if (!state.token) return;
  setSync("syncing");
  try {
    const [cfg, lg] = await Promise.all([ghGet("config.json"), ghGet("log.json")]);
    state.config = { data: cfg.data, sha: cfg.sha };
    saveConfigLocal();
    if (state.log && state.log.dirty) {
      state.log = { data: mergeLogs(state.log.data, lg.data), sha: lg.sha, dirty: true };
      saveLogLocal();
      schedulePush(0);
    } else {
      state.log = { data: lg.data, sha: lg.sha, dirty: false };
      saveLogLocal();
      setSync("idle");
    }
    render();
  } catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      setSync("error");
      if (!state.config) {
        // bad token and nothing cached: back to the gate
        state.token = "";
        localStorage.removeItem(LS.token);
        render("token not accepted, or the data repo is unreachable. try again.");
      }
    } else {
      setSync("offline");
    }
  }
}

let pushTimer = null;
function schedulePush(ms = PUSH_DEBOUNCE_MS) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushLog, ms);
}

async function pushLog() {
  if (!state.token || !state.log || !state.log.dirty) return;
  setSync("syncing");
  try {
    const sha = await ghPut(
      "log.json",
      state.log.data,
      state.log.sha,
      `log · ${new Date().toISOString()}`
    );
    state.log.sha = sha;
    state.log.dirty = false;
    saveLogLocal();
    setSync("idle");
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      // sha moved (edited elsewhere): pull, merge, retry once
      try {
        const remote = await ghGet("log.json");
        state.log.data = mergeLogs(state.log.data, remote.data);
        state.log.sha = remote.sha;
        saveLogLocal();
        const sha = await ghPut(
          "log.json",
          state.log.data,
          state.log.sha,
          `log merge · ${new Date().toISOString()}`
        );
        state.log.sha = sha;
        state.log.dirty = false;
        saveLogLocal();
        setSync("idle");
        render();
      } catch (e2) {
        setSync("offline");
      }
    } else {
      setSync("offline");
    }
  }
}

window.addEventListener("online", () => {
  if (state.log && state.log.dirty) schedulePush(0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.log && state.log.dirty) {
    schedulePush(0);
  }
});

// ---------- mutations ----------

function stamp() {
  return new Date().toISOString();
}

function dayRec(dISO) {
  const days = state.log.data.days;
  if (!days[dISO]) days[dISO] = { checks: {}, updatedAt: "" };
  return days[dISO];
}

function markDirty() {
  state.log.dirty = true;
  saveLogLocal();
  schedulePush();
}

function toggleCheck(dISO, key) {
  const rec = dayRec(dISO);
  rec.checks[key] = !rec.checks[key];
  rec.updatedAt = stamp();
  markDirty();
}

function saveLiftInput(dISO, letter, exName, value) {
  const lifts = state.log.data.lifts;
  if (!lifts[dISO]) lifts[dISO] = { date: dISO, letter, sets: {} };
  if (value.trim()) {
    lifts[dISO].sets[exName] = value.trim();
  } else {
    delete lifts[dISO].sets[exName];
  }
  lifts[dISO].letter = letter;
  lifts[dISO].updatedAt = stamp();
  if (Object.keys(lifts[dISO].sets).length === 0) delete lifts[dISO];
  markDirty();
}

function addWeight(dISO, kg, note) {
  state.log.data.weights[dISO] = {
    date: dISO,
    kg,
    note: note || undefined,
    updatedAt: stamp(),
  };
  markDirty();
}

// ---------- derived ----------

function completion(dISO) {
  const rec = (state.log.data.days || {})[dISO];
  if (!rec) return 0;
  const items = checklistFor(dISO);
  const done = items.filter((it) => rec.checks[it.key]).length;
  return items.length ? done / items.length : 0;
}

function weekStats(dISO) {
  const mon = mondayOf(fromISO(dISO));
  let gymDone = 0;
  let gymTotal = 0;
  let protein = 0;
  let steps = 0;
  for (let i = 0; i < 7; i++) {
    const dayISOx = iso(addDays(mon, i));
    const plan = dayPlan(dayISOx);
    const rec = (state.log.data.days || {})[dayISOx];
    if (plan.type === "gym") {
      gymTotal++;
      if (rec && rec.checks.main) gymDone++;
    }
    if (rec && rec.checks.p) protein++;
    if (rec && rec.checks.s) steps++;
  }
  return { gymDone, gymTotal, protein, steps };
}

function lastSession(letter, beforeISO) {
  const lifts = state.log.data.lifts || {};
  const dates = Object.keys(lifts)
    .filter((d) => lifts[d].letter === letter && d < beforeISO)
    .sort()
    .reverse();
  return dates.length ? lifts[dates[0]] : null;
}

function parseReps(value) {
  const parts = value.split(/[×x]/);
  if (parts.length < 2) return null;
  const reps = (parts.slice(1).join("×").match(/\d+/g) || []).map(Number);
  return reps.length ? reps : null;
}

function hitTop(value, ex) {
  if (!ex.repTop) return false;
  const reps = parseReps(value);
  if (!reps || reps.length < (ex.sets || 3)) return false;
  return reps.slice(0, ex.sets || 3).every((r) => r >= ex.repTop);
}

// ---------- rendering ----------

const app = document.getElementById("app");

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(gateError) {
  const mast = document.getElementById("mast");
  if (!state.token) {
    mast.hidden = true;
    renderGate(gateError);
    return;
  }
  if (!state.config || !state.log) {
    mast.hidden = true;
    app.innerHTML = `<div class="gate reveal"><p class="gate-mark">life</p><p>loading…</p></div>`;
    return;
  }
  mast.hidden = false;
  document.querySelectorAll(".views a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === state.view);
  });
  if (state.view === "day") renderDay();
  else if (state.view === "calendar") renderCalendar();
  else if (state.view === "log") renderLog();
  else renderGuide();
}

// ---- gate ----

function renderGate(error) {
  app.innerHTML = `
    <div class="gate reveal">
      <p class="gate-mark">life</p>
      <p>a private page. paste the key to open it on this device, once.</p>
      <form class="gate-form" id="gate-form">
        <input type="password" id="gate-token" placeholder="key" autocomplete="off" />
        <button class="btn" type="submit">open</button>
      </form>
      ${error ? `<p class="gate-err">${esc(error)}</p>` : ""}
    </div>`;
  document.getElementById("gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = document.getElementById("gate-token").value.trim();
    if (!t) return;
    state.token = t;
    localStorage.setItem(LS.token, t);
    render();
    refreshRemote();
  });
}

// ---- day view ----

function renderDay() {
  const dISO = state.dayISO;
  const tISO = todayISO();
  const items = checklistFor(dISO);
  const rec = (state.log.data.days || {})[dISO] || { checks: {} };
  const stats = weekStats(dISO);
  const cfg = state.config.data;

  let lastGroup = null;
  const rows = items
    .map((it) => {
      const done = rec.checks[it.key] ? " done" : "";
      const main = it.main ? " main" : "";
      let html = "";
      if (it.group && it.group !== lastGroup) {
        html += `<p class="grp">${esc(it.group)}</p>`;
        lastGroup = it.group;
      }
      html += `
      <button class="row${done}${main}" data-check="${it.key}">
        <span class="box"></span><span>${esc(it.label)}</span>
      </button>`;
      if (it.main && it.plan.type === "gym") {
        html += renderGymExpand(dISO, it.plan.letter);
      }
      if (it.expand === "meals") {
        html += renderMealsExpand();
      }
      return html;
    })
    .join("");

  app.innerHTML = `
    <div class="daynav reveal">
      <button data-shift="-1" aria-label="previous day">‹</button>
      <span class="daynav-title">${fmtLong(dISO)}</span>
      <button data-shift="1" aria-label="next day">›</button>
      ${dISO !== tISO ? `<a href="#day" class="to-today">back to today</a>` : ""}
    </div>

    <section class="sec reveal">
      <p class="lbl">gym this week · the only metric</p>
      <div class="score">
        <span class="score-num">${stats.gymDone}<i>/${stats.gymTotal}</i></span>
        <span class="score-side">protein ${stats.protein} days · steps ${stats.steps} days</span>
      </div>
    </section>

    <section class="sec reveal">
      <p class="lbl">checklist</p>
      ${rows}
    </section>`;

  app.querySelectorAll("[data-shift]").forEach((b) =>
    b.addEventListener("click", () => {
      const d = addDays(fromISO(state.dayISO), Number(b.dataset.shift));
      location.hash = `#day/${iso(d)}`;
    })
  );
  app.querySelectorAll("[data-check]").forEach((b) =>
    b.addEventListener("click", () => {
      toggleCheck(dISO, b.dataset.check);
      renderDay();
    })
  );
  wireExpands();
  app.querySelectorAll(".ex-input").forEach((inp) =>
    inp.addEventListener("change", () => {
      saveLiftInput(dISO, inp.dataset.letter, inp.dataset.ex, inp.value);
      renderDay();
    })
  );
}

const openExpands = new Set();

function renderGymExpand(dISO, letter) {
  const cfg = state.config.data;
  const exercises = cfg.workouts[letter] || [];
  const id = `gym-${letter}`;
  const open = openExpands.has(id);
  const session = (state.log.data.lifts || {})[dISO];
  const prev = lastSession(letter, dISO);

  const list = exercises
    .map((ex) => {
      const cur = session && session.sets[ex.name] ? session.sets[ex.name] : "";
      const last = prev && prev.sets[ex.name] ? prev.sets[ex.name] : "";
      const progress = last && hitTop(last, ex);
      return `
      <div class="exercise">
        <div class="ex-head">
          <span class="ex-name">${esc(ex.name)}</span>
          <span class="ex-scheme">${esc(ex.scheme)}</span>
        </div>
        <p class="ex-cue">${esc(ex.cue)}${
        ex.url
          ? ` · <a href="${esc(ex.url)}" target="_blank" rel="noopener noreferrer">form ↗</a>`
          : ""
      }${last ? ` · last: ${esc(last)}` : ""}</p>
        ${progress ? `<span class="chip">hit ${ex.repTop} on all sets · add weight today ↑</span>` : ""}
        <input class="ex-input" type="text" data-ex="${esc(ex.name)}" data-letter="${letter}"
          value="${esc(cur)}" placeholder="${last ? esc(last) : "weight × reps, reps, reps"}" />
      </div>`;
    })
    .join("");

  return `
    <button class="exp" data-expand="${id}">${open ? "hide" : "exercises + log"}</button>
    <div class="exlist" ${open ? "" : "hidden"}>
      ${list}
      <p class="note">${esc(cfg.progressionNote)}</p>
    </div>`;
}

function renderMealsExpand() {
  const cfg = state.config.data;
  const id = "meals";
  const open = openExpands.has(id);
  return `
    <button class="exp" data-expand="${id}">${open ? "hide" : "meal plan"}</button>
    <ul class="exlist" ${open ? "" : "hidden"}>
      ${cfg.meals.map((m) => `<li>${esc(m)}</li>`).join("")}
      <li class="note">${esc(cfg.mealsNote)}</li>
    </ul>`;
}

function wireExpands() {
  app.querySelectorAll("[data-expand]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.expand;
      if (openExpands.has(id)) openExpands.delete(id);
      else openExpands.add(id);
      render();
    })
  );
}

// ---- calendar ----

function renderCalendar() {
  const tISO = todayISO();
  if (!state.calMonth) state.calMonth = tISO.slice(0, 7);
  const [y, m] = state.calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // monday-first offset
  const title = first
    .toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    .toLowerCase();

  let cells = ["mo", "tu", "we", "th", "fr", "sa", "su"]
    .map((h) => `<span class="cal-h">${h}</span>`)
    .join("");
  cells += "<span></span>".repeat(lead);

  for (let day = 1; day <= daysInMonth; day++) {
    const dISO = `${y}-${pad(m)}-${pad(day)}`;
    const future = dISO > tISO;
    const p = future ? 0 : Math.round(completion(dISO) * 100);
    const cls = `cal-c${dISO === tISO ? " today" : ""}${future ? " future" : ""}`;
    cells += `
      <button class="${cls}" data-day="${dISO}" ${future ? "disabled" : ""}>
        <span class="cal-dot" style="--p:${p}"></span>
        <span class="cal-n">${day}</span>
      </button>`;
  }

  app.innerHTML = `
    <div class="cal-head reveal">
      <button data-cal="-1" aria-label="previous month">‹</button>
      <span class="cal-title">${title}</span>
      <button data-cal="1" aria-label="next month">›</button>
    </div>
    <section class="reveal">
      <div class="cal-grid">${cells}</div>
      <p class="note cal-legend">fill = share of that day's checklist done. tap a day to open it.</p>
    </section>`;

  app.querySelectorAll("[data-cal]").forEach((b) =>
    b.addEventListener("click", () => {
      const shift = Number(b.dataset.cal);
      const d = new Date(y, m - 1 + shift, 1);
      state.calMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      renderCalendar();
    })
  );
  app.querySelectorAll("[data-day]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = `#day/${b.dataset.day}`;
    })
  );
}

// ---- log ----

function renderLog() {
  const cfg = state.config.data;
  const weights = Object.values(state.log.data.weights || {}).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
  const sessions = Object.values(state.log.data.lifts || {}).sort((a, b) =>
    b.date.localeCompare(a.date)
  );

  const weightRows = weights
    .map(
      (w) => `
      <div class="log-entry">
        <span class="log-ex">${fmtShort(w.date)}${w.note ? ` · ${esc(w.note)}` : ""}</span>
        <span class="log-sets">${esc(w.kg)} kg</span>
      </div>`
    )
    .join("");

  const sessionBlocks = sessions
    .map((s) => {
      const exercises = cfg.workouts[s.letter] || [];
      const rows = exercises
        .filter((ex) => s.sets[ex.name])
        .map((ex) => {
          const v = s.sets[ex.name];
          return `
          <div class="log-entry">
            <span class="log-ex">${esc(ex.name)}</span>
            <span class="log-sets">${esc(v)}</span>
          </div>
          ${hitTop(v, ex) ? `<span class="chip">hit ${ex.repTop} on all sets · add weight next ${s.letter} session ↑</span>` : ""}`;
        })
        .join("");
      // include anything logged under names not in config (config may evolve)
      const extra = Object.keys(s.sets)
        .filter((n) => !exercises.some((ex) => ex.name === n))
        .map(
          (n) => `
          <div class="log-entry">
            <span class="log-ex">${esc(n)}</span>
            <span class="log-sets">${esc(s.sets[n])}</span>
          </div>`
        )
        .join("");
      return `
      <div class="log-session">
        <p class="log-head">workout ${s.letter} · ${fmtShort(s.date)}</p>
        ${rows}${extra}
      </div>`;
    })
    .join("");

  app.innerHTML = `
    <section class="sec reveal" style="border-top:none;padding-top:8px">
      <p class="lbl">weight</p>
      <form class="inline-form" id="weight-form">
        <input type="date" id="w-date" value="${todayISO()}" />
        <input type="number" id="w-kg" step="0.1" min="30" max="150" placeholder="kg" />
        <button class="btn" type="submit">add</button>
      </form>
      ${weightRows || `<p class="note">no entries yet.</p>`}
      <p class="note" style="margin-top:12px">${esc(cfg.weightNote)}</p>
    </section>

    <section class="sec reveal">
      <p class="lbl">lifts</p>
      ${sessionBlocks || `<p class="note">no sessions logged yet. log from a gym day's checklist.</p>`}
    </section>`;

  document.getElementById("weight-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = document.getElementById("w-date").value;
    const kg = parseFloat(document.getElementById("w-kg").value);
    if (!d || !kg) return;
    addWeight(d, kg);
    renderLog();
  });
}

// ---- guide ----

function renderGuide() {
  const cfg = state.config.data;

  const workoutBlock = (letter) => `
    <p class="log-head" style="margin-top:14px">workout ${letter}</p>
    ${cfg.workouts[letter]
      .map(
        (ex) => `
      <div class="log-entry">
        <span class="log-ex">${esc(ex.name)}${
          ex.url
            ? ` · <a href="${esc(ex.url)}" target="_blank" rel="noopener noreferrer">form ↗</a>`
            : ""
        }<br /><span class="note">${esc(ex.cue)}</span></span>
        <span class="log-sets">${esc(ex.scheme)}</span>
      </div>`
      )
      .join("")}`;

  const sections = cfg.guide
    .map(
      (sec) => `
    <section class="sec guide reveal">
      <p class="lbl">${esc(sec.title)}</p>
      ${sec.body.map((p) => `<p>${esc(p)}</p>`).join("")}
    </section>`
    )
    .join("");

  const protein = cfg.proteinGuide
    .map(
      (g) => `
      <p class="log-head" style="margin-top:14px">${esc(g.cat)}</p>
      ${g.items
        .map((it) => {
          const [name, grams] = it.split(" — ");
          return `
        <div class="log-entry">
          <span class="log-ex">${esc(name)}</span>
          <span class="log-sets">${esc(grams || "")}</span>
        </div>`;
        })
        .join("")}`
    )
    .join("");

  app.innerHTML = `
    <section class="sec guide reveal" style="border-top:none;padding-top:8px">
      <p class="lbl">the week</p>
      <p>${cfg.week
        .map((w) => `${w.day} · ${w.type === "gym" ? "gym" : esc(w.label)}`)
        .join("<br />")}</p>
      ${workoutBlock("A")}
      ${workoutBlock("B")}
      <p class="note" style="margin-top:12px">${esc(cfg.progressionNote)} form links: watch the night before, take one cue into the gym.</p>
    </section>

    <section class="sec guide reveal">
      <p class="lbl">meals</p>
      <p>${cfg.meals.map(esc).join("<br />")}</p>
      <p class="note">${esc(cfg.mealsNote)}</p>
      ${protein}
      <p class="note" style="margin-top:12px">${esc(cfg.proteinNote)}</p>
    </section>

    ${sections}

    <p class="coda-link"><button id="forget">forget this device</button></p>`;

  document.getElementById("forget").addEventListener("click", () => {
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.log);
    localStorage.removeItem(LS.config);
    location.hash = "";
    location.reload();
  });
}

// ---------- routing ----------

function route() {
  const h = location.hash.replace(/^#/, "");
  const [view, arg] = h.split("/");
  if (view === "day" && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    state.view = "day";
    state.dayISO = arg;
  } else if (["calendar", "log", "guide"].includes(view)) {
    state.view = view;
  } else {
    state.view = "day";
    state.dayISO = todayISO();
  }
  render();
}

window.addEventListener("hashchange", route);

// ---------- init ----------

loadLocal();
route();
refreshRemote();
