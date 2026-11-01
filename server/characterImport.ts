import { inflateSync } from "node:zlib";
import {
  cardSchema,
  MAX_CARD_BYTES,
  type CardFile,
} from "../shared/roleplay.js";
import { assert } from "./errors.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Buffer) {
  let crc = -1;
  for (const b of bytes) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
const decode = (b: Buffer) =>
  new TextDecoder("utf-8", { fatal: true }).decode(b);
export function extractCharacter(bytes: Buffer): {
  native?: CardFile;
  source: unknown;
  avatar: string | null;
  warnings: string[];
} {
  assert(
    bytes.length <= MAX_CARD_BYTES,
    "角色卡最多 20 MiB",
    "CARD_TOO_LARGE",
    413,
  );
  let source: unknown,
    avatar: string | null = null;
  if (bytes.subarray(0, 8).equals(signature)) {
    let at = 8,
      ended = false,
      v2: string | undefined,
      v3: string | undefined;
    const image: Buffer[] = [signature];
    while (at < bytes.length) {
      assert(at + 12 <= bytes.length, "PNG 数据不完整");
      const length = bytes.readUInt32BE(at),
        end = at + 12 + length;
      assert(end <= bytes.length, "PNG 块长度无效");
      const type = bytes.toString("ascii", at + 4, at + 8),
        data = bytes.subarray(at + 8, end - 4);
      assert(
        crc32(bytes.subarray(at + 4, end - 4)) === bytes.readUInt32BE(end - 4),
        "PNG 校验失败",
      );
      if (at === 8) {
        assert(type === "IHDR" && length === 13, "PNG 头无效");
        assert(
          data.readUInt32BE(0) * data.readUInt32BE(4) <= 16000000,
          "头像尺寸过大",
        );
      }
      if (["tEXt", "iTXt", "zTXt"].includes(type)) {
        const sep = data.indexOf(0);
        assert(sep > 0 && sep <= 79, "PNG 文本块无效");
        const key = data.toString("latin1", 0, sep);
        if (key === "chara" || key === "ccv3") {
          let text: Buffer = data.subarray(sep + 1);
          if (type === "zTXt") {
            assert(text[0] === 0, "未知 PNG 压缩方式");
            text = inflateSync(text.subarray(1), { maxOutputLength: 262144 });
          }
          if (type === "iTXt") {
            const compressed = text[0];
            assert(
              (compressed === 0 || compressed === 1) && text[1] === 0,
              "PNG 文本压缩无效",
            );
            const lang = text.indexOf(0, 2),
              translated = text.indexOf(0, lang + 1);
            assert(lang >= 2 && translated > lang, "PNG 国际文本无效");
            text = text.subarray(translated + 1);
            if (compressed)
              text = inflateSync(text, { maxOutputLength: 262144 });
          }
          assert(text.length <= 262144, "内嵌角色资料过大");
          const encoded = text.toString("ascii").trim();
          assert(
            /^[A-Za-z0-9+/=\r\n]+$/.test(encoded),
            "PNG 角色资料不是有效 Base64",
          );
          const decoded = decode(Buffer.from(encoded, "base64"));
          if (key === "ccv3") v3 = decoded;
          else v2 = decoded;
        }
      } else image.push(bytes.subarray(at, end));
      at = end;
      if (type === "IEND") {
        ended = true;
        break;
      }
    }
    assert(ended, "PNG 缺少结束块");
    const text = v3 ?? v2;
    assert(
      text,
      "这张 PNG 没有内嵌角色资料，可在编辑器中作为头像使用，请导入对应 JSON",
    );
    source = JSON.parse(text);
    avatar = `data:image/png;base64,${Buffer.concat(image).toString("base64")}`;
  } else source = JSON.parse(decode(bytes).replace(/^\uFEFF/, ""));
  const native = cardSchema.safeParse(source);
  if (native.success)
    return {
      native: native.data,
      source: native.data,
      avatar: native.data.character.avatar,
      warnings: [],
    };
  assert(
    source && typeof source === "object" && !Array.isArray(source),
    "角色卡须为 JSON 对象",
  );
  if ((source as Record<string, unknown>).spec === "coyote_roleplay_card")
    throw new Error(native.error.message);
  const obj = source as Record<string, unknown>,
    data = (
      obj.data && typeof obj.data === "object" ? obj.data : obj
    ) as Record<string, unknown>;
  assert(
    typeof data.name === "string",
    "未识别角色名称，请使用本站格式或常见 V1/V2/V3 JSON",
  );
  // Avatar is a local attachment. Never fetch URLs or send image data to text models.
  const { avatar: _avatar, ...textSource } = data;
  const text = JSON.stringify(textSource);
  assert(text.length <= 131072, "角色资料文本过大，请精简后重试");
  const warnings = ["第三方资料将由当前配置的 AI 整理，请核对后保存。"];
  if (data.character_book)
    warnings.push("世界书整理为背景文本，不执行动态触发规则。");
  if (data.extensions || data.system_prompt || data.post_history_instructions)
    warnings.push("扩展、脚本及系统提示覆盖不执行；原始资料保留在预览中。");
  if (/\{\{(?!char\}\}|user\}\})/i.test(text))
    warnings.push("包含不支持的宏，仅替换 {{char}} 和 {{user}}。");
  return { source: textSource, avatar, warnings };
}
