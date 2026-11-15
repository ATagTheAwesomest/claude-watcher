// Copies the shared types from the server repository into this one.
//
//   npm run sync-types -- [path to the server repository]
//
// The path defaults to ../claude-watcher-server. The types file is copied
// unchanged, so it must stay free of Node and Obsidian imports on both sides.

import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

const serverRepo = path.resolve(process.argv[2] ?? "../claude-watcher-server");
const source = path.join(serverRepo, "src", "shared", "types.ts");
const target = path.resolve("src", "shared", "types.ts");

const before = await readFile(target, "utf8").catch(() => "");
await copyFile(source, target);
const after = await readFile(target, "utf8");

console.log(before === after ? "Shared types are up to date." : `Updated ${target} from ${source}`);
