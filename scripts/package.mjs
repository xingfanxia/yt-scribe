// Builds the Chrome Web Store upload: release/scribe-<version>.zip with only runtime files.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const zip = join(root, "release", `scribe-${version}.zip`);
mkdirSync(join(root, "release"), { recursive: true });
rmSync(zip, { force: true });
execFileSync("zip", ["-r", "-q", "-X", zip, "manifest.json", "LICENSE", "_locales", "icons", "fonts", "src", "-x", "*.DS_Store"], { cwd: root });
console.log(zip);
