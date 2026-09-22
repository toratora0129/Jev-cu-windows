#!/usr/bin/env node
/**
 * プロジェクト内の skill/jev-cu を Codex のスキル用ディレクトリへインストールする。
 *
 *   node scripts/install-skill.mjs            # コピーしてインストール（既定）
 *   node scripts/install-skill.mjs --link     # シンボリックリンクでインストール（プロジェクトの元ファイルを参照）
 *   node scripts/install-skill.mjs --uninstall
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PROJECT_DIR, "skill", "jev-cu");
const DEST = path.join(os.homedir(), ".codex", "skills", "jev-cu");
const REPO_DIR_PLACEHOLDER = "{{REPO_DIR}}";
const uninstall = process.argv.includes("--uninstall");
const link = process.argv.includes("--link");

/** スキル文書の {{REPO_DIR}} をローカルのプロジェクトパスに置換する（コピー時） */
function materializeRepoDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) materializeRepoDir(p);
    else if (entry.isFile()) {
      const text = fs.readFileSync(p, "utf8");
      const replaced = text.split(REPO_DIR_PLACEHOLDER).join(PROJECT_DIR);
      if (replaced !== text) fs.writeFileSync(p, replaced);
    }
  }
}

if (uninstall) {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log(`アンインストールしました：${DEST}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(SRC, "SKILL.md"))) {
  console.error(`元のスキルが見つかりません：${SRC}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.rmSync(DEST, { recursive: true, force: true });
if (link) {
  fs.symlinkSync(SRC, DEST, "dir");
  console.log(`シンボリックリンクを作成しました：${DEST} → ${SRC}`);
} else {
  fs.cpSync(SRC, DEST, { recursive: true });
  materializeRepoDir(DEST);
  console.log(`コピーしてインストールしました：${SRC} → ${DEST}`);
}
console.log("新しいセッションで有効になります。削除する場合：node scripts/install-skill.mjs --uninstall");
