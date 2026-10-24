import { join } from "node:path";
import { monthKey } from "../library/history.js";
import { JsonFile } from "../store.js";

export interface QuizUserStats {
  points: number;
  games: number;
  wins: number;
  /** Угадано исполнителей и названий */
  artist: number;
  title: number;
  /** Сыграно раундов (для точности) */
  rounds: number;
}

interface QuizFile {
  users: Record<string, QuizUserStats>;
  /** Очки по месяцам для итогов месяца */
  months: Record<string, Record<string, number>>;
}

export interface GameResult {
  userId: string;
  points: number;
  artist: number;
  title: number;
}

/** Рейтинг «Угадай трек» за всё время. Хранится в data/quiz.json. */
export class QuizStore {
  private file: JsonFile<QuizFile>;
  private data: QuizFile;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "quiz.json"), () => ({ users: {}, months: {} }));
    this.data = this.file.read();
    this.data.users ??= {};
    this.data.months ??= {};
  }

  record(results: GameResult[], rounds: number) {
    if (results.length === 0 || rounds === 0) return;
    const best = Math.max(...results.map((r) => r.points));
    const month = (this.data.months[monthKey()] ??= {});
    for (const r of results) {
      const u = (this.data.users[r.userId] ??= { points: 0, games: 0, wins: 0, artist: 0, title: 0, rounds: 0 });
      u.points += r.points;
      u.games++;
      u.artist += r.artist;
      u.title += r.title;
      u.rounds += rounds;
      if (best > 0 && r.points === best) u.wins++;
      month[r.userId] = (month[r.userId] ?? 0) + r.points;
    }
    this.file.write(this.data);
  }

  top(limit = 10): [string, QuizUserStats][] {
    return Object.entries(this.data.users)
      .filter(([, u]) => u.games > 0)
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, limit);
  }

  /** Лучший игрок месяца (key = null — за всё время). */
  champion(key: string | null): { userId: string; points: number } | null {
    const table: Record<string, number> = {};
    if (key) Object.assign(table, this.data.months[key] ?? {});
    else for (const m of Object.values(this.data.months)) for (const [u, p] of Object.entries(m)) table[u] = (table[u] ?? 0) + p;
    const [userId, points] = Object.entries(table).sort((a, b) => b[1] - a[1])[0] ?? [];
    return userId && points ? { userId, points } : null;
  }
}
