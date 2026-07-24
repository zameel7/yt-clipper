import { getVersion } from "@tauri-apps/api/app";

const REPO = "zameel7/yt-clipper";

export interface UpdateInfo {
  version: string; // latest, without leading "v"
  url: string; // GitHub release page
  notes: string;
}

// Parse "1.2.3" (ignoring any leading "v" / pre-release suffix) into numbers.
function parts(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

// Returns true if a > b.
function isNewer(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export type UpdateResult =
  | { status: "update"; info: UpdateInfo; current: string }
  | { status: "latest"; current: string }
  | { status: "error" };

// Query the latest GitHub release and compare against the running version.
// Distinguishes update-available / up-to-date / network-or-API error.
export async function checkForUpdateResult(): Promise<UpdateResult> {
  let current = "";
  try {
    current = await getVersion();
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return { status: "error" };
    const data = await res.json();
    const tag: string = data.tag_name ?? "";
    if (!tag) return { status: "error" };
    const latest = tag.replace(/^v/i, "");
    if (!isNewer(latest, current)) return { status: "latest", current };
    return {
      status: "update",
      current,
      info: {
        version: latest,
        url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
        notes: data.body ?? "",
      },
    };
  } catch {
    return { status: "error" };
  }
}

// Returns update info if a newer release exists, otherwise null. For the
// silent launch check. Never throws.
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const r = await checkForUpdateResult();
  return r.status === "update" ? r.info : null;
}
