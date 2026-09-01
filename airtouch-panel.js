/**
 * AirTouch Panel — a Lovelace custom card that mimics the AirTouch 5 wall controller.
 *
 * Install:
 *   1. Copy this file to  <config>/www/airtouch-panel.js
 *   2. Settings → Dashboards → ⋮ → Resources → Add resource
 *        URL: /local/airtouch-panel.js     Type: JavaScript module
 *   3. Add a card (example):
 *
 *        type: custom:airtouch-panel
 *        unit: climate.ac_0
 *        outside_temp: sensor.outdoor_meter_temperature
 *        schedule_name: Weekday
 *        grid_options:
 *          rows: 1
 *          columns: 26
 *        zones:
 *          - { name: Living R, climate: climate.living_r,    damper: cover.living_r_damper,    control: damper }
 *          - { name: Living I, climate: climate.living_i,    damper: cover.living_i_damper,    control: damper }
 *          - { name: Paul,     climate: climate.paul_s_room, damper: cover.paul_s_room_damper, control: temp }
 *          - { name: Choy,     climate: climate.choy_room,   damper: cover.choy_room_damper,   control: damper }
 *          - { name: Master,   climate: climate.master_bed,  damper: cover.master_bed_damper,  control: temp }
 *
 *   grid_options (a sections-view property, not a card option) spans the card
 *   across a full-width dashboard row so the landscape layout isn't cropped.
 *
 * No build step, no dependencies (uses HA's built-in <ha-icon>).
 */

const VERSION = "1.0.4";

/* ---------- helpers ---------- */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, step) => Math.round(n / step) * step;
const isNA = (s) => !s || s.state === "unavailable" || s.state === "unknown";
const titlecase = (s) => String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, startAngle, endAngle) {
  const [x1, y1] = polar(cx, cy, r, endAngle);
  const [x2, y2] = polar(cx, cy, r, startAngle);
  const large = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 0 ${x2} ${y2}`;
}

const MODE_ICON = {
  cool: "mdi:snowflake",
  heat: "mdi:fire",
  dry: "mdi:water-percent",
  fan_only: "mdi:fan",
  auto: "mdi:autorenew",
  off: "mdi:power",
};
const MODE_COLOR = {
  cool: "#38bdf8",
  heat: "#fb923c",
  dry: "#a5b4fc",
  fan_only: "#67e8f9",
  auto: "#4ade80",
  off: "#8a8f98",
};

/* ---------- card ---------- */
class AirTouchPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._root = document.createElement("div");
    this._style = document.createElement("style");
    this._style.textContent = STYLE;
    this.shadowRoot.append(this._style, this._root);
    this._drag = null;         // {temp} while dragging the dial
    this._pending = {};        // optimistic values keyed by entity_id
    this._timers = {};         // debounce timers keyed by entity_id
    this._zmode = {};          // per-zone active control, "temp" | "damper", keyed by climate entity
    this._bound = false;
  }

  setConfig(config) {
    if (!config.unit) throw new Error("airtouch-panel: 'unit' (a climate entity) is required");
    this._config = {
      schedule_name: "Weekday",
      outside_temp: null,
      zones: [],
      ...config,
    };
  }

  getCardSize() { return 6; }

  static getStubConfig() {
    return {
      type: "custom:airtouch-panel",
      unit: "climate.ac_0",
      outside_temp: "sensor.outdoor_meter_temperature",
      schedule_name: "Weekday",
      grid_options: { rows: 1, columns: 26 },
      zones: [
        { name: "Living R", climate: "climate.living_r", damper: "cover.living_r_damper", control: "damper" },
        { name: "Living I", climate: "climate.living_i", damper: "cover.living_i_damper", control: "damper" },
        { name: "Paul",     climate: "climate.paul_s_room", damper: "cover.paul_s_room_damper", control: "damper" },
        { name: "Choy",     climate: "climate.choy_room", damper: "cover.choy_room_damper", control: "damper" },
        { name: "Master",   climate: "climate.master_bed", damper: "cover.master_bed_damper", control: "temp" },
      ],
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._drag) this._render();
  }

  /* ---------- service helpers ---------- */
  _call(domain, service, data) {
    this._hass.callService(domain, service, data);
  }
  _debounced(entity, fn, ms = 450) {
    clearTimeout(this._timers[entity]);
    this._timers[entity] = setTimeout(() => {
      delete this._pending[entity];
      fn();
    }, ms);
  }
  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId }, bubbles: true, composed: true,
    }));
  }
  // Which control the zone row is driving: "temp" (ITC setpoint) or "damper" (%).
  // Runtime-toggled by tapping the value; falls back to the zone's `control:` option.
  _zoneMode(z) {
    if (!z.damper) return "temp";
    return this._zmode[z.climate] || (z.control === "temp" ? "temp" : "damper");
  }

  /* ---------- interaction ---------- */
  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const hass = this._hass;

    if (act === "menu") { this._moreInfo(this._config.unit); return; }

    // block controls for unavailable entities (still allow more-info via hold/name)
    const unitActs = ["unit-power", "unit-mode", "unit-fan", "unit-temp"];
    if (unitActs.includes(act) && isNA(hass.states[this._config.unit])) return;
    if (act.startsWith("zone-") && act !== "zone-name") {
      const z = this._config.zones[Number(el.dataset.i)];
      if (isNA(hass.states[z && z.climate])) return;
    }

    if (act === "unit-power") {
      const s = hass.states[this._config.unit];
      this._call("climate", s.state === "off" ? "turn_on" : "turn_off", { entity_id: this._config.unit });
    }
    else if (act === "unit-mode") {
      const s = hass.states[this._config.unit];
      const modes = (s.attributes.hvac_modes || []).filter((m) => m !== "off");
      if (!modes.length) return;
      const cur = s.state === "off" ? modes[modes.length - 1] : s.state;
      const next = modes[(modes.indexOf(cur) + 1) % modes.length];
      this._call("climate", "set_hvac_mode", { entity_id: this._config.unit, hvac_mode: next });
    }
    else if (act === "unit-fan") {
      const s = hass.states[this._config.unit];
      const fans = s.attributes.fan_modes || [];
      if (!fans.length) return;
      const next = fans[(fans.indexOf(s.attributes.fan_mode) + 1) % fans.length];
      this._call("climate", "set_fan_mode", { entity_id: this._config.unit, fan_mode: next });
    }
    else if (act === "unit-temp") {
      const dir = Number(el.dataset.dir);
      const s = hass.states[this._config.unit];
      const step = s.attributes.target_temp_step || 1;
      const lo = s.attributes.min_temp ?? 16, hi = s.attributes.max_temp ?? 30;
      const base = this._pending[this._config.unit] ?? s.attributes.temperature ?? lo;
      const val = clamp(round(base + dir * step, step), lo, hi);
      this._pending[this._config.unit] = val;
      this._render();
      this._debounced(this._config.unit, () =>
        this._call("climate", "set_temperature", { entity_id: this._config.unit, temperature: val }));
    }
    else if (act === "menu") {
      this._moreInfo(this._config.unit);
    }
    else if (act === "zone-power") {
      const z = this._config.zones[Number(el.dataset.i)];
      const s = hass.states[z.climate];
      this._call("climate", s.state === "off" ? "turn_on" : "turn_off", { entity_id: z.climate });
    }
    else if (act === "zone-name") {
      const z = this._config.zones[Number(el.dataset.i)];
      this._moreInfo(z.climate);
    }
    else if (act === "zone-cycle") {
      // Tap the value to switch the row between damper % and ITC setpoint,
      // like tapping the figure on the real AirTouch panel. Re-asserting the
      // current value on the newly-selected control also flips the console's
      // zone control method as a side effect.
      const z = this._config.zones[Number(el.dataset.i)];
      const cs = hass.states[z.climate];
      if (!z.damper || !cs || cs.state === "off") return;
      const next = this._zoneMode(z) === "temp" ? "damper" : "temp";
      this._zmode[z.climate] = next;
      delete this._pending[z.climate];
      delete this._pending[z.damper];
      if (next === "temp") {
        const t = cs.attributes.temperature;
        if (t != null) this._debounced(z.climate, () =>
          this._call("climate", "set_temperature", { entity_id: z.climate, temperature: t }));
      } else {
        const p = (hass.states[z.damper] || {}).attributes?.current_position;
        if (p != null) this._debounced(z.damper, () =>
          this._call("cover", "set_cover_position", { entity_id: z.damper, position: p }));
      }
      this._render();
    }
    else if (act === "zone-adjust") {
      const z = this._config.zones[Number(el.dataset.i)];
      const dir = Number(el.dataset.dir);
      const cs = hass.states[z.climate];
      if (cs.state === "off") return;
      const mode = this._zoneMode(z);
      if (mode === "temp") {
        const step = cs.attributes.target_temp_step || 1;
        const lo = cs.attributes.min_temp ?? 16, hi = cs.attributes.max_temp ?? 30;
        const base = this._pending[z.climate] ?? cs.attributes.temperature ?? lo;
        const val = clamp(round(base + dir * step, step), lo, hi);
        this._pending[z.climate] = val;
        this._render();
        this._debounced(z.climate, () =>
          this._call("climate", "set_temperature", { entity_id: z.climate, temperature: val }));
      } else {
        const ds = hass.states[z.damper];
        const base = this._pending[z.damper] ?? ds.attributes.current_position ?? 0;
        const val = clamp(round(base + dir * 5, 5), 0, 100);
        this._pending[z.damper] = val;
        this._render();
        this._debounced(z.damper, () =>
          this._call("cover", "set_cover_position", { entity_id: z.damper, position: val }));
      }
    }
  }

  _onPointerDown(e) {
    const dial = e.target.closest("[data-act='dial']");
    if (!dial) return;
    const s = this._hass.states[this._config.unit];
    if (isNA(s)) return;
    e.preventDefault();
    const svg = this._root.querySelector(".dial svg");
    const lo = s.attributes.min_temp ?? 16, hi = s.attributes.max_temp ?? 30;
    const step = s.attributes.target_temp_step || 1;
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - cx;
      const py = (ev.touches ? ev.touches[0].clientY : ev.clientY) - cy;
      let ang = Math.atan2(py, px) * (180 / Math.PI) + 90;   // 0 at top, CW
      ang = (ang + 360) % 360;
      const START = 205, SWEEP = 310;                          // gauge geometry
      let rel = (ang - START + 360) % 360;
      if (rel > SWEEP) rel = rel - 360 > -30 ? SWEEP : 0;      // snap outside the gap
      const f = clamp(rel / SWEEP, 0, 1);
      const temp = clamp(round(lo + f * (hi - lo), step), lo, hi);
      this._drag = { temp };
      this._paintDial(temp);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const t = this._drag && this._drag.temp;
      this._drag = null;
      if (t != null) this._call("climate", "set_temperature", { entity_id: this._config.unit, temperature: t });
      this._render();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e);
  }

  _paintDial(temp) {
    const s = this._hass.states[this._config.unit];
    const lo = s.attributes.min_temp ?? 16, hi = s.attributes.max_temp ?? 30;
    const START = 205, SWEEP = 310;
    const f = clamp((temp - lo) / (hi - lo), 0, 1);
    const end = START + f * SWEEP;
    const val = this._root.querySelector(".dial .val");
    const knob = this._root.querySelector(".dial .knob");
    const bignum = this._root.querySelector(".setpoint .big");
    if (val) val.setAttribute("d", arcPath(100, 100, 88, START, end));
    if (knob) {
      const [kx, ky] = polar(100, 100, 88, end);
      knob.setAttribute("cx", kx); knob.setAttribute("cy", ky);
    }
    if (bignum) bignum.textContent = `${Math.round(temp)}°`;
  }

  /* ---------- render ---------- */
  _render() {
    const hass = this._hass;
    if (!hass || !this._config) return;
    const cfg = this._config;
    const u = hass.states[cfg.unit];
    if (!u) { this._root.innerHTML = `<div class="panel err">Unknown entity: ${cfg.unit}</div>`; return; }

    const uNA = isNA(u);
    const uOff = !uNA && u.state === "off";
    const mode = uNA || uOff ? "off" : u.state;
    const setTemp = this._drag ? this._drag.temp : (this._pending[cfg.unit] ?? u.attributes.temperature);
    const curTemp = u.attributes.current_temperature;
    const lo = u.attributes.min_temp ?? 16, hi = u.attributes.max_temp ?? 30;
    const f = clamp(((setTemp ?? lo) - lo) / (hi - lo), 0, 1);
    const START = 205, SWEEP = 310;
    const trackPath = arcPath(100, 100, 88, START, START + SWEEP);
    const valPath = arcPath(100, 100, 88, START, START + f * SWEEP);
    const [kx, ky] = polar(100, 100, 88, START + f * SWEEP);

    const fan = uNA ? "" : (u.attributes.fan_mode || "");
    const fanLetter = fan ? fan[0].toUpperCase() : "–";
    const fanLabel = fan ? titlecase(fan) : "";

    const ov = Number(hass.states[cfg.outside_temp]?.state);
    const outside = Number.isFinite(ov) ? Math.round(ov) : null;

    const zonesHtml = cfg.zones.map((z, i) => {
      const cs = hass.states[z.climate];
      const zNA = isNA(cs);
      const on = !zNA && cs.state !== "off";
      const roomTemp = zNA ? null : cs.attributes.current_temperature;
      const boost = !zNA && cs.attributes.preset_mode === "boost";
      const zmode = this._zoneMode(z);
      const canCycle = on && !!z.damper;
      let mid;
      if (zNA) {
        mid = `<span class="mid off">${cs ? "Unavailable" : "?"}</span>`;
      } else if (!on) {
        mid = `<span class="mid off">Off</span>`;
      } else if (zmode === "temp") {
        const t = this._pending[z.climate] ?? cs.attributes.temperature;
        mid = `<span class="mid"><button data-act="zone-adjust" data-i="${i}" data-dir="-1">−</button>
                 <span class="box val ${canCycle ? "cyc" : ""}" data-act="${canCycle ? "zone-cycle" : ""}" data-i="${i}"
                   title="${canCycle ? "Switch to damper %" : ""}">${Math.round(t)}°</span>
                 <button data-act="zone-adjust" data-i="${i}" data-dir="1">+</button></span>`;
      } else {
        const ds = hass.states[z.damper] || { attributes: {} };
        const p = this._pending[z.damper] ?? ds.attributes.current_position ?? 0;
        mid = `<span class="mid"><button data-act="zone-adjust" data-i="${i}" data-dir="-1">−</button>
                 <span class="pct val ${canCycle ? "cyc" : ""}" data-act="${canCycle ? "zone-cycle" : ""}" data-i="${i}"
                   title="${canCycle ? "Switch to temperature" : ""}">${Math.round(p)}%</span>
                 <button data-act="zone-adjust" data-i="${i}" data-dir="1">+</button></span>`;
      }
      return `
        <div class="zone ${zNA ? "na" : ""}">
          <button class="pwr ${on ? "on" : ""}" data-act="zone-power" data-i="${i}" title="Toggle ${z.name}">
            <ha-icon icon="mdi:power"></ha-icon>
          </button>
          <span class="zname" data-act="zone-name" data-i="${i}">${z.name}</span>
          ${mid}
          <span class="rtemp">${boost ? '<span class="boost">B</span>' : ""}${
            roomTemp != null ? `<ha-icon icon="mdi:thermometer"></ha-icon>${Math.round(roomTemp)}°` : ""}</span>
        </div>`;
    }).join("");

    this._root.innerHTML = `
      <div class="panel">
        <div class="topbar">
          <div class="brand"><span class="ring">a</span>irtouch</div>
          <div class="sched"><ha-icon icon="mdi:star-four-points"></ha-icon>${cfg.schedule_name}</div>
          <div class="right">
            ${outside != null ? `<span class="out"><ha-icon icon="mdi:weather-sunny"></ha-icon>${outside}°</span>` : ""}
            <button class="menu" data-act="menu"><ha-icon icon="mdi:menu"></ha-icon></button>
          </div>
        </div>

        <div class="body">
          <div class="zones">${zonesHtml}</div>

          <div class="unit ${uNA ? "na" : ""}">
            <div class="ubtns">
              <div class="ub">
                <button class="big-pwr ${!uNA && !uOff ? "on" : ""}" data-act="unit-power">
                  <ha-icon icon="mdi:power"></ha-icon>
                </button>
                <ha-icon class="timer" icon="mdi:timer-outline"></ha-icon>
              </div>
              <div class="ub">
                <span class="cap">${uNA ? "Unavailable" : uOff ? "Off" : titlecase(mode)}</span>
                <button class="knobbtn" data-act="unit-mode" style="--c:${MODE_COLOR[mode] || "#8a8f98"}">
                  <ha-icon icon="${MODE_ICON[mode] || "mdi:hvac"}"></ha-icon>
                </button>
              </div>
              <div class="ub">
                <span class="cap">${fanLabel}</span>
                <button class="knobbtn letter" data-act="unit-fan">${fanLetter}</button>
              </div>
            </div>

            <div class="setpoint">
              <div class="setto">Set To</div>
              <div class="big">${setTemp != null ? Math.round(setTemp) + "°" : "--"}</div>
              <div class="cur"><ha-icon icon="mdi:thermometer"></ha-icon>${curTemp != null ? Math.round(curTemp) + "°" : "--"}</div>
              <div class="steppers">
                <button data-act="unit-temp" data-dir="-1">−</button>
                <button data-act="unit-temp" data-dir="1">+</button>
              </div>
            </div>

            <div class="dial" data-act="dial">
              <svg viewBox="0 0 200 200">
                <path class="track" d="${trackPath}" />
                <path class="val" d="${valPath}" style="stroke:${MODE_COLOR[mode] || "#38bdf8"}" />
                <circle class="knob" cx="${kx}" cy="${ky}" r="9" />
              </svg>
            </div>
          </div>
        </div>
      </div>`;

    if (!this._bound) {
      this._root.addEventListener("click", (e) => this._onClick(e));
      this._root.addEventListener("pointerdown", (e) => this._onPointerDown(e));
      this._bound = true;
    }
  }
}

const STYLE = `
:host { display:block; }
* { box-sizing:border-box; }
.panel {
  container-type: inline-size;
  position:relative;
  width:100%;
  border-radius:20px;
  padding:18px clamp(14px,3cqw,22px) 22px;
  background:linear-gradient(180deg,#3a3d42 0%,#26282b 60%,#1d1f21 100%);
  color:#f5f6f7;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-weight:300;
  overflow:visible;
}
.panel.err { color:#ff6b6b; font-weight:400; }

.topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.brand { font-size:22px; letter-spacing:.5px; font-weight:400; }
.brand .ring {
  display:inline-block; border:2px solid #ff7a1a; border-radius:50%;
  width:1.15em; height:1.15em; line-height:1.05em; text-align:center; margin-right:1px;
}
.sched { display:flex; align-items:center; gap:6px; font-size:15px; color:#e7e8ea; }
.sched ha-icon { --mdc-icon-size:18px; color:#cfd2d6; }
.right { display:flex; align-items:center; gap:14px; }
.out { display:flex; align-items:center; gap:5px; font-size:16px; }
.out ha-icon { --mdc-icon-size:20px; color:#f2c94c; }
.menu { background:none; border:none; color:#dfe1e4; cursor:pointer; padding:2px; }
.menu ha-icon { --mdc-icon-size:26px; }

.body { display:flex; flex-wrap:wrap; gap:24px; }
.zones { flex:1 1 300px; display:flex; flex-direction:column; gap:14px; padding-top:4px; }

.zone { display:grid; grid-template-columns:auto 1fr auto auto; align-items:center; gap:12px; }
.pwr {
  width:34px; height:34px; border-radius:50%; border:none; cursor:pointer;
  background:radial-gradient(circle at 30% 28%,#4a4d52,#2c2e31);
  box-shadow:0 1px 2px rgba(0,0,0,.5), inset 0 1px 1px rgba(255,255,255,.08);
  color:#8b9096; display:flex; align-items:center; justify-content:center; flex:0 0 auto;
}
.pwr ha-icon { --mdc-icon-size:20px; }
.pwr.on {
  background:radial-gradient(circle at 30% 28%,#38c0ff,#0a8ed6);
  color:#fff; box-shadow:0 0 10px rgba(38,180,255,.5), inset 0 1px 1px rgba(255,255,255,.4);
}
.zname { font-size:21px; color:#f3f4f5; cursor:pointer; }
.mid { display:flex; align-items:center; gap:10px; font-size:19px; white-space:nowrap; }
.mid.off { color:#7f858b; }
.mid button {
  width:26px; height:26px; border-radius:50%; border:none; cursor:pointer;
  background:#34363a; color:#d7d9dc; font-size:17px; line-height:1;
  box-shadow:inset 0 1px 1px rgba(255,255,255,.06), 0 1px 2px rgba(0,0,0,.4);
}
.mid .box { min-width:44px; text-align:center; padding:2px 6px; border:1px solid #5b5e63; border-radius:7px; }
.mid .pct { min-width:52px; text-align:center; }
.mid .val.cyc { cursor:pointer; }
.mid .pct.cyc { border-bottom:1px dashed rgba(255,255,255,.35); }
.mid .box.cyc { border-style:dashed; }
.mid .val.cyc:hover { color:#fff; border-color:#38c0ff; }
.rtemp { display:flex; align-items:center; gap:3px; font-size:13px; color:#c7c9cc; }
.rtemp ha-icon { --mdc-icon-size:15px; color:#9aa0a6; }
.boost { background:#0a8ed6; color:#fff; border-radius:4px; font-size:11px; padding:1px 4px; margin-right:4px; }

.unit {
  flex:1 1 360px;
  display:grid;
  grid-template-columns:1fr auto;
  grid-template-areas:"btns btns" "set dial";
  column-gap:16px; row-gap:10px;
  align-items:start;
}
.ubtns { grid-area:btns; display:flex; gap:clamp(12px,4cqw,28px); align-items:flex-start; flex-wrap:wrap; }
.ub { display:flex; flex-direction:column; align-items:center; gap:6px; }
.ubtns .ub:first-child { flex-direction:row; align-items:center; gap:6px; }
.ub .cap { font-size:15px; color:#e6e7e9; order:-1; min-height:18px; }
.ub .timer { --mdc-icon-size:20px; color:#8b9096; }
.big-pwr {
  width:78px; height:78px; border-radius:50%; border:none; cursor:pointer;
  background:radial-gradient(circle at 32% 26%,#4a4d52,#2b2d30);
  box-shadow:0 2px 6px rgba(0,0,0,.5), inset 0 1px 2px rgba(255,255,255,.08);
  color:#9aa0a6; display:flex; align-items:center; justify-content:center;
}
.big-pwr ha-icon { --mdc-icon-size:40px; }
.big-pwr.on {
  background:radial-gradient(circle at 32% 26%,#38c0ff,#0a8ed6); color:#fff;
  box-shadow:0 0 18px rgba(38,180,255,.55), inset 0 1px 2px rgba(255,255,255,.4);
}
.knobbtn {
  width:62px; height:62px; border-radius:50%; border:none; cursor:pointer;
  background:radial-gradient(circle at 32% 26%,#3f4247,#232528);
  box-shadow:0 2px 6px rgba(0,0,0,.5), inset 0 1px 2px rgba(255,255,255,.07);
  color:var(--c,#cfd2d6); display:flex; align-items:center; justify-content:center;
  font-size:26px; font-weight:400;
}
.knobbtn ha-icon { --mdc-icon-size:34px; }
.knobbtn.letter { color:#5db7e8; }

.setpoint { grid-area:set; align-self:center; }
.setto { font-size:17px; color:#e6e7e9; }
.setpoint .big { font-size:clamp(46px,15cqw,76px); line-height:.95; font-weight:200; letter-spacing:-2px; }
.cur { display:flex; align-items:center; gap:5px; font-size:18px; color:#dfe1e4; margin-top:2px; }
.cur ha-icon { --mdc-icon-size:18px; color:#9aa0a6; }
.steppers { display:flex; gap:10px; margin-top:10px; }
.steppers button {
  width:30px; height:30px; border-radius:50%; border:none; cursor:pointer;
  background:#34363a; color:#d7d9dc; font-size:19px;
  box-shadow:inset 0 1px 1px rgba(255,255,255,.06), 0 1px 2px rgba(0,0,0,.4);
}

.dial {
  grid-area:dial; align-self:center; justify-self:end;
  width:clamp(150px,32cqw,240px); aspect-ratio:1;
  touch-action:none; cursor:pointer;
}
.dial svg { width:100%; height:100%; overflow:visible; display:block; }
.dial .track { fill:none; stroke:#111315; stroke-width:14; stroke-linecap:round; }
.dial .val   { fill:none; stroke-width:14; stroke-linecap:round; filter:drop-shadow(0 0 6px rgba(56,189,248,.5)); }
.dial .knob  { fill:#fff; filter:drop-shadow(0 1px 3px rgba(0,0,0,.6)); }

@container (max-width:640px){
  .unit { grid-template-columns:1fr; grid-template-areas:"btns" "set" "dial"; justify-items:center; }
  .setpoint { text-align:center; }
  .cur, .steppers { justify-content:center; }
  .dial { justify-self:center; }
}
@container (max-width:400px){
  .big-pwr { width:64px; height:64px; }
  .big-pwr ha-icon { --mdc-icon-size:32px; }
  .knobbtn { width:54px; height:54px; font-size:22px; }
  .knobbtn ha-icon { --mdc-icon-size:28px; }
  .zname { font-size:19px; }
  .mid { font-size:17px; }
}

/* unavailable / unknown entities */
.unit.na { opacity:.45; }
.unit.na .knobbtn, .unit.na .steppers, .unit.na .dial { pointer-events:none; }
.unit.na .dial .val, .unit.na .dial .knob { display:none; }
.unit.na .cap { color:#9aa0a6; }
.zone.na { opacity:.45; }
.zone.na .pwr { pointer-events:none; }
`;

customElements.define("airtouch-panel", AirTouchPanel);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "airtouch-panel",
  name: "AirTouch Panel",
  description: "AirTouch 5 wall-controller look-alike (zones + unit).",
  preview: false,
});
console.info(`%c AIRTOUCH-PANEL %c ${VERSION} `, "background:#0a8ed6;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
