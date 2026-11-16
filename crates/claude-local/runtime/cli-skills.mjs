import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function listCliSkills(directory) {
  if (typeof directory !== "string" || !directory) return { skills: [], available: false };

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { skills: [], available: true };
    return { skills: [], available: false, error: "Unable to read the CLI skills directory." };
  }

  const directoryNames = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const skills = await Promise.all(directoryNames.map(async (directoryName) => {
    try {
      const skill = await stat(path.join(directory, directoryName, "SKILL.md"));
      if (skill.isFile()) return { directoryName, updatedAt: skill.mtime.toISOString() };
    } catch {}
    return null;
  }));
  return { skills: skills.filter(Boolean), available: true };
}
