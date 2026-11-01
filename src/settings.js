// Lefty's settings, kept in a small JSON file in the app's data folder so they survive restarts:
//   mode: 'learn' (Lefty points, the user clicks) or 'auto' (Do it: Lefty clicks and types for the user)
//   size: 'small' | 'normal' | 'large' (how big Lefty is drawn on screen)
//   speak: 'off' | 'on' (Lefty reads his answers and steps out loud)
//   privateApps: process names ("keepass", "1password") where Lefty never sends a screenshot or code to the AI
// Unknown keys and values are ignored, so a damaged file only resets what it damaged.

const fs = require('fs');

const DEFAULTS = { mode: 'learn', size: 'normal', speak: 'off', privateApps: [] };
const ALLOWED = { mode: ['learn', 'auto'], size: ['small', 'normal', 'large'], speak: ['off', 'on'] };
const MAX_PRIVATE_APPS = 50;

// "KeePass.exe " -> "keepass". Null for anything that can't be a process name.
function processName(value) {
  const name = String(value == null ? '' : value).trim().toLowerCase().replace(/\.exe$/, '');
  return /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]{0,63}$/u.test(name) ? name : null;
}

function cleanApps(list) {
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter((item) => typeof item === 'string').map(processName).filter(Boolean))].slice(0, MAX_PRIVATE_APPS);
}

function clean(values) {
  const out = {};
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    if (values && allowed.includes(values[key])) out[key] = values[key];
  }
  const apps = values ? cleanApps(values.privateApps) : null;
  if (apps) out.privateApps = apps;
  return out;
}

const copy = (values) => ({ ...values, privateApps: [...values.privateApps] });

function createSettings(file) {
  let values = copy(DEFAULTS);
  try { values = { ...copy(DEFAULTS), ...clean(JSON.parse(fs.readFileSync(file, 'utf8'))) }; } catch { /* first run, or an unreadable file */ }
  return {
    get: () => copy(values),
    // Applies the allowed changes and saves them; returns all settings.
    set(changes) {
      values = { ...values, ...clean(changes) };
      try { fs.writeFileSync(file, JSON.stringify(values, null, 2)); } catch { /* read-only profile: kept for this run */ }
      return copy(values);
    },
    // Is this process on the private list? ("KeePass", "keepass.exe" and "keepass" are the same app.)
    isPrivate: (process) => Boolean(processName(process)) && values.privateApps.includes(processName(process)),
  };
}

module.exports = { createSettings, DEFAULTS, ALLOWED, processName };
