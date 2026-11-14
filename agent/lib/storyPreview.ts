import {
  STORY_PREVIEW_LIMIT,
  type StoryPreview,
} from "../../shared/storyFeed.ts";

// Read a JSON string prefix through the last complete escape. Only selected
// strings are decoded. The parser does not repair or accept a final document.
function stringEnd(raw: string, from: number) {
  let end = from + 1;
  while (end < raw.length) {
    const ch = raw[end];
    if (ch === '"') return { end: end + 1, closed: true };
    if (ch.charCodeAt(0) < 32) return { end, closed: false };
    if (ch !== "\\") {
      end++;
      continue;
    }
    const escape = raw[end + 1];
    if (escape === "u") {
      if (!/^[a-f0-9]{4}$/i.test(raw.slice(end + 2, end + 6))) break;
      end += 6;
    } else if (escape && '"\\/bfnrt'.includes(escape)) end += 2;
    else break;
  }
  return { end, closed: false };
}

/** Only top-level narration/dialogue strings from an object can be previewed. */
export function storyPreview(raw: string): StoryPreview {
  const result: StoryPreview = { narration: "", dialogue: "" };
  const start = raw.search(/[^\t\r\n ]/);
  if (raw[start] !== "{") return result;
  const stack = ["}"];
  let mode: "key" | "colon" | "value" | "after" = "key";
  let key: string | undefined;
  const seen = new Set<string>();
  for (let i = start + 1; i < raw.length && stack.length;) {
    const ch = raw[i];
    if (/[\t\r\n ]/.test(ch)) {
      i++;
      continue;
    }
    if (stack.length > 1) {
      if (ch === '"') {
        const token = stringEnd(raw, i);
        if (!token.closed) break;
        i = token.end;
      } else {
        if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === stack.at(-1)) stack.pop();
        else if (ch === "}" || ch === "]") break;
        i++;
      }
      continue;
    }
    if (mode === "key") {
      if (ch !== '"') break;
      const token = stringEnd(raw, i);
      if (!token.closed) break;
      try {
        key = JSON.parse(raw.slice(i, token.end));
      } catch {
        break;
      }
      mode = "colon";
      i = token.end;
    } else if (mode === "colon") {
      if (ch !== ":") break;
      i++;
      mode = "value";
    } else if (mode === "value") {
      const target =
        key === "narration" || key === "dialogue" ? key : undefined;
      if (ch === '"') {
        const token = stringEnd(raw, i);
        if (target && !seen.has(target)) {
          try {
            const value = JSON.parse(
              raw.slice(i, token.end) + (token.closed ? "" : '"'),
            ) as string;
            result[target] = value
              .slice(0, STORY_PREVIEW_LIMIT)
              .replace(/[\uD800-\uDBFF]$/, "");
          } catch {
            break;
          }
        }
        if (!token.closed) break;
        i = token.end;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch === "{" ? "}" : "]");
        i++;
      } else {
        const match =
          /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
            raw.slice(i),
          );
        if (!match) break;
        i += match[0].length;
      }
      if (target) seen.add(target);
      mode = "after";
    } else {
      if (ch !== ",") break;
      i++;
      mode = "key";
    }
  }
  return result;
}

// Cumulative text may end halfway through a credential; withhold that suffix
// until it can be classified rather than exposing it in successive frames.
export function redactPreview(text: string, key: string) {
  if (!key) return text;
  text = text.split(key).join("[已隐藏]");
  for (let n = Math.min(text.length, key.length - 1); n > 0; n--)
    if (text.endsWith(key.slice(0, n))) return text.slice(0, -n);
  return text;
}
