// Проверка «не ставить в автоплей»: tsx scripts-dev/try-taste.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoplayTaste, mainArtist } from "../src/music/taste.js";

let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}`);
};

check("Spotify, фит", mainArtist({ author: "9mice, Kai Angel", title: "HEAVY METAL 2", sourceName: "spotify" }), "9mice");
check("YouTube-канал с исполнителем в названии", mainArtist({ author: "Rap Hits", title: "MiyaGi & Эндшпиль - Тамада (Official Video)", sourceName: "youtube" }), "MiyaGi");
check("Topic-канал", mainArtist({ author: "GONE.Fludd - Topic", title: "ДРИПСЭТ", sourceName: "youtube" }), "GONE.Fludd");

const dir = mkdtempSync(join(tmpdir(), "taste-"));
try {
  const t = new AutoplayTaste(dir);
  t.ban("MiyaGi", "1");
  check("бан по автору", t.blocked({ author: "MiyaGi, Andy Panda", title: "Kosandra", sourceName: "spotify" })?.name, "MiyaGi");
  check("бан по названию заливки", t.blocked({ author: "Хиты 2024", title: "Мияги & Эндшпиль - I Got Love", sourceName: "youtube" })?.name, "MiyaGi");
  check("другой артист проходит", t.blocked({ author: "Kai Angel", title: "chrome hearts", sourceName: "spotify" }), null);
  check("без ложных совпадений в названии", t.blocked({ author: "Kai Angel", title: "miyagi style", sourceName: "spotify" }), null);

  check("первый быстрый скип", t.quickSkip({ author: "zxcursed", title: "a", sourceName: "youtube" }).blocked, false);
  check("после одного скипа ещё ставится", t.blocked({ author: "zxcursed", title: "b" }), null);
  check("второй быстрый скип", t.quickSkip({ author: "zxcursed", title: "c", sourceName: "youtube" }).blocked, true);
  check("после двух — не ставится", t.blocked({ author: "zxcursed", title: "d" })?.why, "skips");
  t.humanPlayed({ author: "zxcursed", title: "e", sourceName: "spotify" });
  check("человек сам включил — снова ставится", t.blocked({ author: "zxcursed", title: "f" }), null);
  t.humanPlayed({ author: "MiyaGi", title: "x", sourceName: "spotify" });
  check("ручной бан от этого не снимается", t.blocked({ author: "MiyaGi", title: "y" })?.why, "ban");

  check("список", t.blockedList().map((b) => b.name), ["MiyaGi"]);
  check("вернуть по обрезанному ключу", t.unban("miag"), "MiyaGi");
  check("после возврата", t.blocked({ author: "MiyaGi", title: "y" }), null);
  t.flush();
  check("сохраняется на диск", new AutoplayTaste(dir).blockedList().length, 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
