"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/services/recurrence.ts
var recurrence_exports = {};
__export(recurrence_exports, {
  expandRecurrence: () => expandRecurrence,
  parseRRule: () => parseRRule,
  singleOccurrence: () => singleOccurrence
});
module.exports = __toCommonJS(recurrence_exports);
var DAY_MS = 864e5;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDatePart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
function keyOfUTC(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function shiftKey(key, days) {
  const p = parseDatePart(key);
  if (!p) return key;
  return keyOfUTC(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS);
}
function parseRRule(rule) {
  if (!rule || typeof rule !== "string") return null;
  const parts = {};
  for (const seg of rule.split(";")) {
    const i = seg.indexOf("=");
    if (i < 0) continue;
    parts[seg.slice(0, i).trim().toUpperCase()] = seg.slice(i + 1).trim().toUpperCase();
  }
  const freq = parts["FREQ"];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  let byday = null;
  if (parts["BYDAY"]) {
    const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const days = parts["BYDAY"].split(",").map((s) => map[s.trim()]).filter((n) => n !== void 0);
    if (days.length > 0) {
      const uniq = days.filter((n, i) => days.indexOf(n) === i).sort((a, b) => a - b);
      byday = uniq;
    }
  }
  let count = null;
  if (parts["COUNT"]) {
    const n = parseInt(parts["COUNT"], 10);
    if (Number.isInteger(n) && n > 0) count = n;
  }
  let until = null;
  if (parts["UNTIL"]) {
    const digits = parts["UNTIL"].replace(/\D/g, "");
    if (digits.length >= 8) {
      until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      if (!DATE_RE.test(until)) until = null;
    }
  }
  return { freq, byday, count, until };
}
function matchesRule(dayUTC, rule, startUTC) {
  const dt = new Date(dayUTC);
  const start = new Date(startUTC);
  switch (rule.freq) {
    case "DAILY":
      return true;
    case "WEEKLY": {
      const dow = dt.getUTCDay();
      if (rule.byday) return rule.byday.includes(dow);
      return dow === start.getUTCDay();
    }
    case "MONTHLY":
      return dt.getUTCDate() === start.getUTCDate();
    default:
      return false;
  }
}
function toExpanded(s, startAt, isRecurring) {
  const occDate = startAt.slice(0, 10);
  let endAt = s.end_at;
  if (s.end_at) {
    const sp = parseDatePart(s.start_at);
    const ep = parseDatePart(s.end_at);
    if (sp && ep) {
      const offDays = Math.round(
        (Date.UTC(ep.y, ep.m - 1, ep.d) - Date.UTC(sp.y, sp.m - 1, sp.d)) / DAY_MS
      );
      const endTime = s.end_at.length > 10 ? s.end_at.slice(10) : "";
      endAt = shiftKey(occDate, Math.max(0, offDays)) + endTime;
    }
  }
  return {
    ...s,
    start_at: startAt,
    end_at: endAt,
    is_recurring: isRecurring,
    original_id: s.id,
    occurrence_date: occDate
  };
}
function singleOccurrence(schedule) {
  return toExpanded(schedule, schedule.start_at, false);
}
function expandRecurrence(schedule, fromDate, toDate) {
  const single = () => [toExpanded(schedule, schedule.start_at, false)];
  const sp = parseDatePart(schedule.start_at);
  if (!sp) return single();
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) return single();
  const rule = parseRRule(schedule.recurrence_rule);
  if (!rule) return single();
  const timePart = schedule.start_at.length > 10 ? schedule.start_at.slice(10) : "";
  const startUTC = Date.UTC(sp.y, sp.m - 1, sp.d);
  const hardStop = startUTC + 3 * 366 * DAY_MS;
  const maxCount = rule.count ?? Infinity;
  const out = [];
  let produced = 0;
  let guard = 0;
  for (let cur = startUTC; cur <= hardStop && guard < 2200; cur += DAY_MS, guard++) {
    const key = keyOfUTC(cur);
    if (rule.until && key > rule.until) break;
    if (key > toDate) break;
    if (!matchesRule(cur, rule, startUTC)) continue;
    if (produced >= maxCount) break;
    produced++;
    if (key >= fromDate) {
      out.push(toExpanded(schedule, key + timePart, true));
    }
  }
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  expandRecurrence,
  parseRRule,
  singleOccurrence
});
