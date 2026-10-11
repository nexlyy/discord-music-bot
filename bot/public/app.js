const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SOURCES = [
  ["ytm", "YouTube Music"], ["yt", "YouTube"], ["sc", "SoundCloud"], ["sp", "Spotify"],
  ["am", "Apple Music"], ["ym", "Яндекс Музыка"], ["vk", "VK Музыка"],
];
const SOURCE_MANAGER = { ytm: "youtube", yt: "youtube", sc: "soundcloud", sp: "spotify", am: "applemusic", ym: "yandexmusic", vk: "vkmusic" };
const SOURCE_LABEL = { youtube: "▶️ YouTube", soundcloud: "☁️ SoundCloud", spotify: "🟢 Spotify", applemusic: "🍎 Apple Music", yandexmusic: "🟡 Яндекс Музыка", vkmusic: "🔵 VK Музыка", http: "🔗 Ссылка", twitch: "🟪 Twitch", bandcamp: "🎸 Bandcamp" };

const state = { player: null, settings: null, sources: [], guild: null, receivedAt: 0, es: null, settingsDirty: false };

/* ------------------------------ утилиты ------------------------------ */

function fmt(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtUptime(ms) {
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m % 60} мин` : `${m} мин`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
let toastTimer;
function toast(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("err", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 5000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("Нужно войти");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

async function act(action, body = {}) {
  try {
    const r = await api(`/api/player/${action}`, { method: "POST", body });
    if (r.player) applyPlayer(r.player);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------ вход ------------------------------ */

function showLogin() {
  state.es?.close();
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-password").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login-password").value = "";
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ------------------------------ вкладки ------------------------------ */

$$("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
    location.hash = b.dataset.tab;
    if (b.dataset.tab === "status") loadStatus();
    if (b.dataset.tab === "logs") loadLogs();
    if (b.dataset.tab === "settings") fillSettings(true);
  }),
);

window.addEventListener("hashchange", () => {
  const btn = $(`#tabs button[data-tab="${location.hash.slice(1)}"]`);
  if (btn && !btn.classList.contains("active")) btn.click();
});

/* ------------------------------ плеер ------------------------------ */

function currentPosition() {
  const p = state.player;
  if (!p?.current) return 0;
  if (!p.playing || p.paused) return p.position;
  return Math.min(p.position + (Date.now() - state.receivedAt), p.current.duration || Infinity);
}

function applyPlayer(p) {
  state.player = p;
  state.receivedAt = Date.now();
  renderPlayer();
}

function renderPlayer() {
  const p = state.player;
  const s = state.settings;
  if (!p) return;
  const cur = p.current;

  $("#np-art").classList.toggle("hidden", !cur?.artworkUrl);
  $("#np-art-empty").classList.toggle("hidden", Boolean(cur?.artworkUrl));
  if (cur?.artworkUrl && $("#np-art").src !== cur.artworkUrl) $("#np-art").src = cur.artworkUrl;

  const title = $("#np-title");
  title.textContent = cur ? cur.title : "Ничего не играет";
  if (cur?.uri) title.href = cur.uri; else title.removeAttribute("href");
  $("#np-author").textContent = cur ? cur.author : p.active ? "Очередь пуста" : "Бот не в голосовом канале";
  $("#np-source").textContent = cur ? (SOURCE_LABEL[cur.sourceName] ?? cur.sourceName) : "";
  $("#np-requester").textContent = cur?.requester ? `Заказал: ${cur.requester.username}` : "";
  $("#np-dur").textContent = cur ? (cur.isStream ? "LIVE" : fmt(cur.duration)) : "0:00";

  $("#btn-toggle").textContent = p.paused || !p.playing ? "▶️" : "⏸";
  $$(".controls .ctl").forEach((b) => (b.disabled = !p.active));
  $("#t-loopq").classList.toggle("on", p.repeatMode === "queue");
  $("#t-loopt").classList.toggle("on", p.repeatMode === "track");
  $("#t-autoplay").classList.toggle("on", p.autoplay);
  $('.ctl[data-act="shuffle"]').classList.toggle("on", Boolean(p.shuffle));

  const vol = $("#vol");
  if (document.activeElement !== vol) vol.value = p.volume;
  vol.max = s?.maxVolume ?? 150;
  $("#vol-val").textContent = `${p.volume}%`;

  $("#add-voice").classList.toggle("hidden", Boolean(p.voiceChannelId));

  // очередь
  $("#q-info").textContent = p.queue.length ? `· ${p.queue.length} · ${fmt(p.queueDuration)}` : "";
  $("#q-empty").classList.toggle("hidden", p.queue.length > 0);
  $("#q-clear").disabled = p.queue.length === 0;
  const list = $("#q-list");
  list.innerHTML = p.queue
    .map(
      (t, i) => `<li class="q-item">
        <span class="q-num">${i + 1}</span>
        ${t.artworkUrl ? `<img class="q-art" src="${esc(t.artworkUrl)}" alt="" loading="lazy">` : `<div class="q-art"></div>`}
        <div class="q-text"><div class="q-title">${esc(t.title)}</div><div class="q-sub">${esc(t.author)}${t.requester ? ` · ${esc(t.requester.username)}` : ""}</div></div>
        <span class="q-dur">${t.isStream ? "LIVE" : fmt(t.duration)}</span>
        <div class="q-actions">
          <button class="icon-btn" data-q="jump" data-i="${i + 1}" title="Играть сейчас">▶</button>
          <button class="icon-btn" data-q="up" data-i="${i + 1}" title="Выше" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-q="down" data-i="${i + 1}" title="Ниже" ${i === p.queue.length - 1 ? "disabled" : ""}>↓</button>
          <button class="icon-btn" data-q="remove" data-i="${i + 1}" title="Убрать">✕</button>
        </div>
      </li>`,
    )
    .join("");
  tickProgress();
}

function tickProgress() {
  const p = state.player;
  const cur = p?.current;
  const pos = currentPosition();
  $("#np-pos").textContent = cur && !cur.isStream ? fmt(pos) : cur ? "🔴" : "0:00";
  $("#np-fill").style.width = cur && cur.duration && !cur.isStream ? `${(pos / cur.duration) * 100}%` : "0%";
}
setInterval(tickProgress, 500);

$$(".controls .ctl").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
$("#t-loopq").addEventListener("click", () => act("repeat", { mode: state.player?.repeatMode === "queue" ? "off" : "queue" }));
$("#t-loopt").addEventListener("click", () => act("repeat", { mode: state.player?.repeatMode === "track" ? "off" : "track" }));
$("#t-autoplay").addEventListener("click", () => act("autoplay", { enabled: !state.player?.autoplay }));
$("#vol").addEventListener("change", (e) => act("volume", { value: Number(e.target.value) }));
$("#vol").addEventListener("input", (e) => ($("#vol-val").textContent = `${e.target.value}%`));
$("#np-bar").addEventListener("click", (e) => {
  const cur = state.player?.current;
  if (!cur || cur.isStream) return;
  const rect = e.currentTarget.getBoundingClientRect();
  act("seek", { ms: Math.round(((e.clientX - rect.left) / rect.width) * cur.duration) });
});
$("#q-clear").addEventListener("click", () => confirm("Очистить очередь?") && act("clear"));
$("#q-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-q]");
  if (!b) return;
  const i = Number(b.dataset.i);
  if (b.dataset.q === "jump") act("jump", { index: i });
  if (b.dataset.q === "remove") act("remove", { index: i });
  if (b.dataset.q === "up") act("move", { from: i, to: i - 1 });
  if (b.dataset.q === "down") act("move", { from: i, to: i + 1 });
});

/* ------------------------------ добавление ------------------------------ */

function fillSourceSelects() {
  const available = new Set(state.sources);
  const opts = SOURCES.map(([k, label]) => {
    const on = available.size === 0 || available.has(SOURCE_MANAGER[k]);
    return `<option value="${k}" ${on ? "" : "disabled"}>${label}${on ? "" : " (не подключена)"}</option>`;
  }).join("");
  const add = $("#add-source");
  const prev = add.value;
  add.innerHTML = opts;
  add.value = prev || state.settings?.defaultSource || "ytm";
  $('#settings-form [name="defaultSource"]').innerHTML = opts;
}

function fillGuildSelects() {
  const g = state.guild;
  if (!g) return;
  if (g.name) $("#guild-name").textContent = g.name;
  if (g.icon) { $("#guild-icon").src = g.icon; $("#guild-icon").classList.remove("hidden"); }
  const voiceOpts = g.voice.map((c) => `<option value="${c.id}">🔊 ${esc(c.name)}${c.members ? ` (${c.members})` : ""}</option>`).join("");
  $("#add-voice").innerHTML = `<option value="">Канал…</option>${voiceOpts}`;
  $('#settings-form [name="stay247ChannelId"]').innerHTML = `<option value="">— не выбран —</option>${voiceOpts}`;
  $('#settings-form [name="musicTextChannelId"]').innerHTML = `<option value="">Где вызвали команду</option>${g.text.map((c) => `<option value="${c.id}"># ${esc(c.name)}</option>`).join("")}`;
}

let suggestTimer, suggestSeq = 0, suggestSel = -1, suggestItems = [];
const isUrl = (s) => /^https?:\/\//i.test(s.trim());

$("#add-query").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("#add-query").value.trim();
  if (q.length < 2 || isUrl(q)) return hideSuggest();
  suggestTimer = setTimeout(() => runSuggest(q), 300);
});
$("#add-query").addEventListener("keydown", (e) => {
  if ($("#suggest").classList.contains("hidden")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggestSel = (suggestSel + (e.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
    $$(".sg").forEach((el, i) => el.classList.toggle("sel", i === suggestSel));
  } else if (e.key === "Enter" && suggestSel >= 0) {
    e.preventDefault();
    pickSuggest(suggestSel);
  } else if (e.key === "Escape") hideSuggest();
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search-box")) hideSuggest(); });

async function runSuggest(q) {
  const seq = ++suggestSeq;
  try {
    const r = await api(`/api/search?${new URLSearchParams({ q, source: $("#add-source").value })}`);
    if (seq !== suggestSeq) return;
    suggestItems = r.tracks;
    suggestSel = -1;
    const box = $("#suggest");
    box.innerHTML = r.tracks
      .map((t, i) => `<div class="sg" data-i="${i}">
        ${t.artworkUrl ? `<img src="${esc(t.artworkUrl)}" alt="" loading="lazy">` : `<img alt="">`}
        <div class="sg-text"><div class="sg-title">${esc(t.title)}</div><div class="sg-sub">${esc(t.source.emoji)} ${esc(t.author)} · ${t.isStream ? "LIVE" : fmt(t.duration)}</div></div>
      </div>`)
      .join("");
    box.classList.toggle("hidden", r.tracks.length === 0);
  } catch {
    hideSuggest();
  }
}
function hideSuggest() { $("#suggest").classList.add("hidden"); suggestItems = []; suggestSel = -1; }
function pickSuggest(i) {
  const t = suggestItems[i];
  if (!t) return;
  hideSuggest();
  addTrack(t.uri ?? `${t.author} ${t.title}`);
}
$("#suggest").addEventListener("click", (e) => {
  const el = e.target.closest(".sg");
  if (el) pickSuggest(Number(el.dataset.i));
});

async function addTrack(query) {
  const voiceChannelId = $("#add-voice").value || undefined;
  try {
    const r = await api("/api/player/play", {
      method: "POST",
      body: { query, source: $("#add-source").value, next: $("#add-next").checked, voiceChannelId },
    });
    $("#add-query").value = "";
    toast(r.playlist ? `Добавлен плейлист «${r.playlist}»: ${r.added} шт.` : r.startedNow ? "Включаю" : "Добавлено в очередь");
  } catch (e) {
    toast(e.message, true);
  }
}
$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#add-query").value.trim();
  if (q) addTrack(q);
});

/* ------------------------------ настройки ------------------------------ */

function fillSettings(force = false) {
  const s = state.settings;
  if (!s || (state.settingsDirty && !force)) return;
  const form = $("#settings-form");
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === "checkbox") el.checked = Boolean(s[el.name]);
    else el.value = s[el.name] ?? "";
  }
  state.settingsDirty = false;
  $("#settings-dirty").textContent = "";
}

$("#settings-form").addEventListener("input", () => {
  state.settingsDirty = true;
  $("#settings-dirty").textContent = "Есть несохранённые изменения";
});

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") patch[el.name] = el.checked;
    else if (el.type === "number") patch[el.name] = Number(el.value);
    else if (el.tagName === "SELECT" && el.dataset.kind) patch[el.name] = el.value || null;
    else if (el.name === "alertWebhookUrl") patch[el.name] = el.value.trim() || null;
    else patch[el.name] = el.value;
  }
  try {
    state.settings = await api("/api/settings", { method: "PUT", body: patch });
    state.settingsDirty = false;
    fillSettings(true);
    fillSourceSelects();
    toast("Настройки сохранены");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#alert-test").addEventListener("click", async () => {
  try {
    await api("/api/alerts/test", { method: "POST" });
    toast("Отправлено. Если сообщения нет — проверь адрес вебхука и сохрани настройки.");
  } catch (e) {
    toast(e.message, true);
  }
});

/* ------------------------------ статус ------------------------------ */

function kv(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
}
const yes = (ok, a = "да", b = "нет") => `<span class="${ok ? "ok-t" : "bad-t"}">${ok ? a : b}</span>`;

async function loadStatus() {
  try {
    const s = await api("/api/status");
    const ll = s.lavalink;
    kv($("#st-bot"), [
      ["В сети", yes(s.bot.online)],
      ["Аккаунт", esc(s.bot.tag ?? "—")],
      ["Сервер", esc(s.bot.guild ?? "—")],
      ["Пинг Discord", `${s.bot.ping} мс`],
      ["Работает", fmtUptime(s.bot.uptime)],
      ["Память", `${s.bot.memoryMb} МБ`],
    ]);
    kv($("#st-ll"), [
      ["Подключён", yes(ll.connected)],
      ["Версия", esc(ll.version ?? "—")],
      ["Плееры", ll.stats ? `${ll.stats.playingPlayers} / ${ll.stats.players}` : "—"],
      ["Нагрузка CPU", ll.stats ? `${(ll.stats.cpu.lavalinkLoad * 100).toFixed(1)}%` : "—"],
      ["Память", ll.stats ? `${Math.round(ll.stats.memory.used / 1048576)} МБ` : "—"],
      ["Работает", ll.stats ? fmtUptime(ll.stats.uptime) : "—"],
      ["Вход в YouTube (OAuth)", ll.youtubeOauth === null ? "—" : yes(ll.youtubeOauth, "активен", "нет токена")],
      ["Плагины", esc(ll.plugins.map((p) => `${p.name} ${p.version}`).join(", ") || "—")],
    ]);
    const have = new Set(ll.sourceManagers);
    const show = ["youtube", "soundcloud", "spotify", "applemusic", "yandexmusic", "vkmusic", "twitch", "bandcamp", "http"];
    $("#st-sources").innerHTML = show.map((m) => `<span class="pill ${have.has(m) ? "ok" : "off"}">${SOURCE_LABEL[m] ?? m}${have.has(m) ? "" : " — нет"}</span>`).join("");
  } catch (e) {
    toast(e.message, true);
  }
}

$("#diag-run").addEventListener("click", async () => {
  const btn = $("#diag-run");
  btn.disabled = true;
  btn.textContent = "Проверяю…";
  try {
    const { results } = await api("/api/diagnostics", { method: "POST" });
    $("#diag").classList.remove("hidden");
    $("#diag tbody").innerHTML = results
      .map((r) => `<tr><td>${esc(r.label)}</td><td class="${r.skipped ? "skip-t" : r.ok ? "ok-t" : "bad-t"}">${r.skipped ? "—" : r.ok ? "✓" : "✗"} ${esc(r.detail)}</td><td class="muted">${r.ms ? `${r.ms} мс` : ""}</td></tr>`)
      .join("");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Проверить площадки";
  }
});

/* ------------------------------ логи ------------------------------ */

async function loadLogs() {
  try {
    const { logs } = await api("/api/logs");
    const box = $("#logs");
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.innerHTML = logs
      .map((l) => `<div class="log-${l.level}"><span class="log-time">${new Date(l.time).toLocaleTimeString("ru-RU")}</span> [${esc(l.scope)}] ${esc(l.message)}</div>`)
      .join("");
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch {}
}
setInterval(() => {
  if ($("#tab-logs").classList.contains("active") && $("#logs-auto").checked) loadLogs();
}, 3000);

/* ------------------------------ запуск ------------------------------ */

function connectEvents() {
  state.es?.close();
  const es = new EventSource("/api/events");
  state.es = es;
  es.onopen = () => { $("#conn-dot").className = "dot ok"; $("#conn-text").textContent = "на связи"; };
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const settingsChanged = JSON.stringify(data.settings) !== JSON.stringify(state.settings);
    state.settings = data.settings;
    document.documentElement.style.setProperty("--accent", data.settings.accentColor);
    if (settingsChanged) fillSettings();
    applyPlayer(data.player);
  };
  es.onerror = async () => {
    $("#conn-dot").className = "dot bad";
    $("#conn-text").textContent = "нет связи, переподключаюсь…";
    try { await api("/api/session"); } catch {}
  };
}

async function start() {
  try {
    await api("/api/session");
  } catch {
    return showLogin();
  }
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const [st, guild] = await Promise.all([api("/api/state"), api("/api/guild").catch(() => null)]);
  state.settings = st.settings;
  state.sources = st.sources;
  state.guild = guild;
  document.documentElement.style.setProperty("--accent", st.settings.accentColor);
  fillGuildSelects();
  fillSourceSelects();
  fillSettings(true);
  applyPlayer(st.player);
  connectEvents();
  const tab = location.hash.slice(1);
  if (tab) $(`#tabs button[data-tab="${tab}"]`)?.click();
}

start();
