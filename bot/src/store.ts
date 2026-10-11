import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** JSON-файл с атомарной записью: пишем во временный файл и переименовываем. */
export class JsonFile<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: () => T,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  read(): T {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch {
      return this.fallback();
    }
  }

  write(value: T): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
