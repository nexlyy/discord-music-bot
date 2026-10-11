import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";

const fontsDir = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
for (const w of ["Medium", "SemiBold", "Bold", "ExtraBold"]) GlobalFonts.registerFromPath(`${fontsDir}Montserrat-${w}.ttf`, `Montserrat ${w}`);

export interface WrappedData {
  title: string;
  subtitle: string;
  guildName: string;
  guildIcon: string | null;
  accent: string;
  totals: { hours: number; plays: number; tracks: number; artists: number };
  topTracks: { title: string; author: string; artworkUrl: string | null; plays: number }[];
  topArtists: { name: string; plays: number }[];
  topListener: { name: string; avatar: string | null; hours: number } | null;
  topDj: { name: string; avatar: string | null; plays: number } | null;
}

const W = 1080;
const H = 1680;
const PAD = 64;

async function fetchImage(url: string | null): Promise<Image | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function font(weight: "Medium" | "SemiBold" | "Bold" | "ExtraBold", size: number) {
  return `${size}px "Montserrat ${weight}"`;
}

function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Картинка с обрезкой «cover» в скруглённой рамке; без картинки — градиентная заглушка. */
function drawCover(ctx: SKRSContext2D, img: Image | null, x: number, y: number, size: number, r: number, accent: string) {
  ctx.save();
  roundRect(ctx, x, y, size, size, r);
  ctx.clip();
  if (img) {
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
  } else {
    const g = ctx.createLinearGradient(x, y, x + size, y + size);
    g.addColorStop(0, accent);
    g.addColorStop(1, "#1f2230");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function drawAvatar(ctx: SKRSContext2D, img: Image | null, x: number, y: number, size: number, accent: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  drawCover(ctx, img, x, y, size, 0, accent);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + 3, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.stroke();
}

const fmtInt = (n: number) => new Intl.NumberFormat("ru-RU").format(Math.round(n));

function sectionTitle(ctx: SKRSContext2D, text: string, y: number, accent: string) {
  ctx.fillStyle = accent;
  ctx.font = font("Bold", 22);
  ctx.letterSpacing = "4px";
  ctx.fillText(text.toUpperCase(), PAD, y);
  ctx.letterSpacing = "0px";
}

export async function renderWrapped(d: WrappedData): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const [hero, guildIcon, listenerAvatar, djAvatar, ...covers] = await Promise.all([
    fetchImage(d.topTracks[0]?.artworkUrl ?? null),
    fetchImage(d.guildIcon),
    fetchImage(d.topListener?.avatar ?? null),
    fetchImage(d.topDj?.avatar ?? null),
    ...d.topTracks.slice(0, 5).map((t) => fetchImage(t.artworkUrl)),
  ]);

  // Фон: размытая обложка главного трека, затемнение и цветное свечение.
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, W, H);
  if (hero) {
    ctx.save();
    ctx.filter = "blur(60px)";
    const scale = Math.max(W / hero.width, H / hero.height) * 1.2;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(hero, (W - hero.width * scale) / 2, (H - hero.height * scale) / 2, hero.width * scale, hero.height * scale);
    ctx.restore();
  }
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgba(11,13,18,0.55)");
  shade.addColorStop(0.45, "rgba(11,13,18,0.82)");
  shade.addColorStop(1, "rgba(11,13,18,0.96)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.15, 120, 10, W * 0.15, 120, 520);
  glow.addColorStop(0, `${d.accent}66`);
  glow.addColorStop(1, `${d.accent}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Шапка
  let y = PAD + 30;
  sectionTitle(ctx, d.subtitle, y, d.accent);
  y += 92;
  ctx.fillStyle = "#ffffff";
  ctx.font = font("ExtraBold", 84);
  ctx.fillText(fit(ctx, d.title, W - PAD * 2), PAD, y);
  y += 58;
  const iconSize = 44;
  let nameX = PAD;
  if (guildIcon) {
    drawAvatar(ctx, guildIcon, PAD, y - 34, iconSize, d.accent);
    nameX += iconSize + 18;
  }
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = font("SemiBold", 30);
  // В названии сервера бывают переносы и буквальные «\n» — в одну строку.
  ctx.fillText(fit(ctx, d.guildName.replace(/\\n|\s+/g, " ").trim(), W - nameX - PAD), nameX, y);

  // Цифры
  y += 50;
  const stats: [string, string][] = [
    [`${fmtInt(d.totals.hours)} ч`, "музыки"],
    [fmtInt(d.totals.plays), "треков сыграно"],
    [fmtInt(d.totals.tracks), "разных треков"],
    [fmtInt(d.totals.artists), "исполнителей"],
  ];
  const gap = 18;
  const boxW = (W - PAD * 2 - gap * 3) / 4;
  stats.forEach(([value, label], i) => {
    const x = PAD + i * (boxW + gap);
    roundRect(ctx, x, y, boxW, 140, 22);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = font("ExtraBold", 46);
    ctx.fillText(fit(ctx, value, boxW - 36), x + 22, y + 70);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = font("Medium", 20);
    ctx.fillText(fit(ctx, label, boxW - 36), x + 22, y + 108);
  });

  // Топ треков
  y += 140 + 78;
  sectionTitle(ctx, "Топ треков", y, d.accent);
  y += 26;
  const rowH = 112;
  const cover = 88;
  d.topTracks.slice(0, 5).forEach((t, i) => {
    const top = y + i * rowH;
    ctx.fillStyle = i === 0 ? d.accent : "rgba(255,255,255,0.45)";
    ctx.font = font("ExtraBold", i === 0 ? 44 : 36);
    ctx.fillText(String(i + 1), PAD, top + 62);
    drawCover(ctx, covers[i] ?? null, PAD + 56, top + 6, cover, 14, d.accent);
    const textX = PAD + 56 + cover + 24;
    const playsText = `${fmtInt(t.plays)}×`;
    ctx.font = font("Bold", 28);
    const playsW = ctx.measureText(playsText).width;
    const textW = W - PAD - textX - playsW - 24;
    ctx.fillStyle = "#ffffff";
    ctx.font = font("Bold", 32);
    ctx.fillText(fit(ctx, t.title, textW), textX, top + 46);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = font("Medium", 24);
    ctx.fillText(fit(ctx, t.author, textW), textX, top + 82);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = font("Bold", 28);
    ctx.fillText(playsText, W - PAD - playsW, top + 62);
  });
  if (d.topTracks.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = font("Medium", 26);
    ctx.fillText("Пока ничего не слушали", PAD, y + 50);
  }

  // Топ исполнителей — две колонки
  y += Math.max(1, Math.min(5, d.topTracks.length)) * rowH + 60;
  sectionTitle(ctx, "Топ исполнителей", y, d.accent);
  y += 22;
  const colW = (W - PAD * 2 - 40) / 2;
  d.topArtists.slice(0, 6).forEach((a, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    const x = PAD + col * (colW + 40);
    const top = y + row * 62;
    ctx.fillStyle = d.accent;
    ctx.font = font("ExtraBold", 30);
    ctx.fillText(`${i + 1}`, x, top + 42);
    const countText = fmtInt(a.plays);
    ctx.font = font("SemiBold", 24);
    const cw = ctx.measureText(countText).width;
    ctx.fillStyle = "#ffffff";
    ctx.font = font("Bold", 30);
    ctx.fillText(fit(ctx, a.name, colW - 48 - cw - 16), x + 44, top + 42);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = font("SemiBold", 24);
    ctx.fillText(countText, x + colW - cw, top + 42);
  });

  // Люди
  y += 3 * 62 + 52;
  const cardW = (W - PAD * 2 - 24) / 2;
  const people: [string, { name: string; avatar: string | null } | null, Image | null, string][] = [
    ["Главный слушатель", d.topListener, listenerAvatar, d.topListener ? `${fmtInt(d.topListener.hours)} ч под музыку` : "нет данных"],
    ["Главный диджей", d.topDj, djAvatar, d.topDj ? `${fmtInt(d.topDj.plays)} заказов` : "нет данных"],
  ];
  people.forEach(([label, person, img, detail], i) => {
    const x = PAD + i * (cardW + 24);
    roundRect(ctx, x, y, cardW, 150, 24);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    drawAvatar(ctx, img, x + 26, y + 31, 88, d.accent);
    const tx = x + 26 + 88 + 22;
    const tw = cardW - (tx - x) - 20;
    ctx.fillStyle = d.accent;
    ctx.font = font("Bold", 18);
    ctx.letterSpacing = "2px";
    ctx.fillText(fit(ctx, label.toUpperCase(), tw), tx, y + 52);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = "#ffffff";
    ctx.font = font("Bold", 30);
    ctx.fillText(fit(ctx, person?.name ?? "—", tw), tx, y + 92);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = font("Medium", 22);
    ctx.fillText(fit(ctx, detail, tw), tx, y + 124);
  });

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = font("Medium", 20);
  const footer = "/wrapped — итоги в любой момент";
  ctx.fillText(footer, (W - ctx.measureText(footer).width) / 2, H - 44);

  return canvas.toBuffer("image/png");
}
