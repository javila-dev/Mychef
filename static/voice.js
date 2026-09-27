// Voz en la cocina: escuchar (Web Speech API), hablar (speechSynthesis) y temporizadores.
// El texto reconocido se interpreta en el servidor (/api/voice); aquí solo se oye, se habla y se cuenta.

import { $, $$, esc, icon, modal } from "./common.js";

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const VOICE_SUPPORTED = Boolean(Recognition);
export const VOICE_SECURE = window.isSecureContext;
const LANG = "es-CO";

// ---------------------------------------------------------------- hablar

let voice = null;
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  voice = voices.find((v) => v.lang === "es-CO")
    ?? voices.find((v) => v.lang === "es-US" || v.lang === "es-419" || v.lang === "es-MX")
    ?? voices.find((v) => v.lang?.startsWith("es"))
    ?? null;
}
if (window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

export function speak(text) {
  return new Promise((resolve) => {
    if (!text || !window.speechSynthesis) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? LANG;
    if (voice) u.voice = voice;
    u.rate = 1;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
    setTimeout(resolve, Math.min(20000, 1500 + text.length * 90)); // por si el navegador no avisa
  });
}
export function stopSpeaking() { window.speechSynthesis?.cancel(); }

// ---------------------------------------------------------------- escuchar una frase

export function listenOnce({ onInterim } = {}) {
  return new Promise((resolve, reject) => {
    if (!Recognition) return reject(new Error("unsupported"));
    const rec = new Recognition();
    rec.lang = LANG;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let final = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim?.(final || interim);
    };
    rec.onerror = (e) => reject(new Error(e.error || "error"));
    rec.onend = () => resolve(final.trim());
    rec.start();
    listenOnce.current = rec;
  });
}
export function stopListening() { try { listenOnce.current?.stop(); } catch { /* ya paró */ } }

// ---------------------------------------------------------------- escucha continua
// La usan el modo manos libres de las recetas y la palabra de activación («Oye casa»).

export class HandsFree {
  constructor(onPhrase, { onInterim = null } = {}) {
    this.onPhrase = onPhrase;
    this.onInterim = onInterim;
    this.active = false;
    this.paused = false;
  }
  start() {
    if (!Recognition || this.active) return;
    this.active = true;
    this._run();
  }
  _run() {
    if (!this.active) return;
    const rec = new Recognition();
    rec.lang = LANG;
    rec.continuous = true;
    rec.interimResults = Boolean(this.onInterim);
    rec.onresult = (e) => {
      if (this.paused) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (r.isFinal) this.onPhrase(text);
        else this.onInterim?.(text);
      }
    };
    rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") this.stop(); };
    // Chrome corta la escucha continua cada cierto tiempo o tras un silencio: se reanuda sola.
    rec.onend = () => { if (this.active) setTimeout(() => this._run(), 300); };
    try { rec.start(); } catch { /* reintenta en onend */ }
    this.rec = rec;
  }
  stop() {
    this.active = false;
    try { this.rec?.abort?.(); } catch { /* ya paró */ }
    try { this.rec?.stop(); } catch { /* ya paró */ }
  }
}

// ---------------------------------------------------------------- palabra de activación

function plain(text) {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:"']/g, " ").replace(/\s+/g, " ").trim();
}

// Variantes con las que el reconocedor suele escribir el saludo ("oye" → "hoy", "oie", "ok", "ey"…).
const GREETINGS = "oye|oie|oi|oy|hoy|hola|ok|okey|okay|ey|hey|e";

// ¿La frase empieza (o contiene) la palabra de activación? Devuelve lo que viene después.
export function matchWake(text, wakeWord = "Oye casa") {
  const t = plain(text);
  const words = plain(wakeWord).split(" ").filter(Boolean);
  if (!words.length) return { hit: false, rest: "" };
  const name = words[words.length - 1].replace(/[^a-z0-9ñ]/g, "");
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // El nombre final (p. ej. "casa") es lo que importa; lo anterior admite variantes de saludo.
  const lead = words.length > 1 ? `(?:${words.slice(0, -1).map(esc).join(" ")}|${GREETINGS})\\s+` : "";
  const nameAlt = name === "casa" ? "(?:casa|kasa|caza)" : esc(name);
  const re = new RegExp(`(?:^|\\s)${lead}${nameAlt}(?:\\s+|$)(.*)$`);
  const m = t.match(re);
  if (!m) return { hit: false, rest: "" };
  // Recuperar el resto con tildes desde el texto original (mismas palabras al final).
  const restWords = m[1].trim() ? m[1].trim().split(" ").length : 0;
  const original = text.trim().replace(/[¿?¡!.,;:"']+$/g, "").split(/\s+/);
  const rest = restWords ? original.slice(-restWords).join(" ").replace(/^[,.;:\s]+/, "") : "";
  return { hit: true, rest };
}

// ---------------------------------------------------------------- temporizadores

const KEY = "mychef-timers";
let timers = [];
try { timers = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { timers = []; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(timers)); } catch { /* sin almacenamiento */ } };

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function sayLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 1) return `${m} minuto${m > 1 ? "s" : ""}${sec >= 30 && m < 10 ? " y medio" : ""}`;
  return `${sec} segundos`;
}

export const Timers = {
  add(seconds, label = "", said = "") {
    timers.push({ id: Date.now(), label, said, end: Date.now() + seconds * 1000 });
    save();
    render();
  },
  cancelAll() { timers = []; save(); render(); },
  cancel(id) { timers = timers.filter((t) => t.id !== id); save(); render(); },
  describe() {
    if (!timers.length) return "No hay temporizadores.";
    return timers.map((t) => `${t.label ? `${t.label}: ` : ""}faltan ${sayLeft(t.end - Date.now())}`).join(". ") + ".";
  },
  get count() { return timers.length; },
};

function render() {
  let box = $("#timers");
  if (!box) {
    box = document.createElement("div");
    box.id = "timers";
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  box.innerHTML = timers.map((t) => `
    <div class="timer-chip" data-id="${t.id}">${icon("clock", 20)}
      <span class="t-label">${esc(t.label || "Temporizador")}</span>
      <span class="t-left">${fmtLeft(t.end - Date.now())}</span>
      <button class="t-x" data-cancel="${t.id}" aria-label="Quitar temporizador">${icon("close", 18)}</button>
    </div>`).join("");
  $$("[data-cancel]", box).forEach((b) => b.onclick = () => Timers.cancel(+b.dataset.cancel));
}

let ringing = null;
function ring(t) {
  const name = t.said ? `de ${t.said}`.replace(/^de el /, "del ") : t.label ? `de ${t.label.toLowerCase()}` : "";
  const ctx = window.AudioContext ? new AudioContext() : null;
  const beep = () => {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.55);
  };
  let n = 0;
  const loop = setInterval(() => {
    beep();
    if (++n % 4 === 0) speak(`¡Se acabó el tiempo ${name}!`);
    if (n > 60) stop();
  }, 900);
  beep();
  speak(`¡Se acabó el tiempo ${name}!`);
  const m = modal({
    size: "narrow", title: "",
    body: `<div class="done-msg"><div class="mark ring">${icon("clock", 46)}</div>
      <h2>¡Se acabó el tiempo!</h2><p class="muted">${esc(t.label || "Temporizador")}</p></div>`,
    actions: [{ label: "Detener", tone: "primary", icon: "check" }],
  });
  function stop() { clearInterval(loop); stopSpeaking(); ctx?.close(); m.close(); ringing = null; }
  m.done.then(stop);
  ringing = stop;
}

setInterval(() => {
  const now = Date.now();
  const due = timers.filter((t) => t.end <= now);
  if (due.length) {
    timers = timers.filter((t) => t.end > now);
    save();
    due.forEach((t) => { if (!ringing) ring(t); });
  }
  if (timers.length || $("#timers")?.children.length) render();
}, 1000);
render();

export function stopRinging() { ringing?.(); }

// Sonido corto de "te escucho" (como los parlantes inteligentes).
let chimeCtx = null;
export function chime() {
  try {
    chimeCtx = chimeCtx || new AudioContext();
    const t0 = chimeCtx.currentTime;
    [660, 990].forEach((f, i) => {
      const o = chimeCtx.createOscillator(), g = chimeCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.18);
      o.connect(g).connect(chimeCtx.destination);
      o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.2);
    });
  } catch { /* sin audio */ }
}
