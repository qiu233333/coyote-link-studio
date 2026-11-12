import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createApplication } from "../server/app.ts";
import {
  cardTemplate,
  type RoleplaySession,
  type StoryMessage,
} from "../shared/roleplay.ts";
import type { AppSnapshot } from "../shared/types.ts";

const directory = await mkdtemp(resolve(tmpdir(), "coyote-branch-http-"));
const artifacts = resolve("artifacts", "story-branches");
const options = ["我打开西门。", "我走向东门。", "我留在原地。"];
const opening = "我观察眼前的路口。";
const future = "密码是 7319";
const westRoom = "西门密室";
let calls = 0;
let checkedBranchRequests = 0;
const providerErrors: string[] = [];
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    assert.equal(req.headers.authorization, "Bearer local-branch-fixture");
    const body = JSON.parse(raw);
    calls++;
    assert.equal(body.tools[0].function.name, "submit_roleplay");
    const context = JSON.parse(
      body.messages
        .findLast((m: { role: string }) => m.role === "user")
        .content.split("\n")
        .at(-1),
    );
    const last = context.memory.recentDialogue.at(-1).text;
    assert.equal(context.authorization, null);
    if (last === options[1]) {
      // Inspect the entire actual provider request, including all prompts and messages.
      assert.doesNotMatch(raw, /7319|西门密室|我打开西门。|我留在原地。/u);
      assert.equal(context.storyState.scene.location, "旧城岔路");
      assert.equal(context.memory.longPlot, "玩家在岔路发现两扇门。");
      checkedBranchRequests++;
    }
    assert.ok([opening, options[0], options[1]].includes(last));
    const location =
      last === opening
        ? "旧城岔路"
        : last === options[0]
          ? westRoom
          : "东门庭院";
    const narration =
      last === opening
        ? "星涟指出前方的两扇门。"
        : last === options[0]
          ? `你在${westRoom}看到一行字：${future}。`
          : "东门打开，庭院里有一棵梧桐。";
    const reply = {
      narration,
      dialogue: "接下来怎么走？",
      replyOptions:
        last === opening
          ? options
          : ["我继续往前。", "我仔细观察。", "我先休息。"],
      storyStateDelta: { scene: { location, situation: narration } },
      memory: {
        recentPlot: narration,
        longPlot: last === opening ? "玩家在岔路发现两扇门。" : narration,
        plotBackground: location,
        longDialogue: "",
      },
      control: { action: "keep" },
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: "submit_roleplay",
                    arguments: JSON.stringify(reply),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 300,
          completion_tokens: 150,
          total_tokens: 450,
        },
      }),
    );
  } catch (error) {
    providerErrors.push((error as Error).message);
    res.writeHead(500).end();
  }
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const port = (provider.address() as { port: number }).port;
const app = await createApplication({
  directory,
  aiDirectory: resolve(directory, "eve"),
  dev: false,
});
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(resolve(directory, "eve"));
  const url = await app.listen(0);
  const first = await fetch(url + "/api/state");
  const cookie = first.headers.get("set-cookie")!.split(";")[0];
  async function api<T = unknown>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const response = await fetch(url + path, {
      method,
      headers: {
        cookie,
        "X-Coyote-Request": "1",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.ok(result.ok, `${method} ${path}: ${result.error}`);
    return result.data;
  }
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await api<AppSnapshot>("/api/state")).aiRuntime.ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal((await api<AppSnapshot>("/api/state")).aiRuntime.ready, true);
  await api(
    "/api/settings",
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "branch-fixture",
      apiKey: "local-branch-fixture",
    },
    "PUT",
  );
  const card = await api<{ id: string }>("/api/roleplay/cards", {
    ...cardTemplate,
    character: { ...cardTemplate.character, firstMessage: "你站在分岔口。" },
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.COYOTE_BROWSER_PATH ??
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: true,
  });
  try {
    for (const width of [1512, 390]) {
      const sourceTitle = `岔路故事 ${width}`;
      const branchTitle = `东门分支 ${width}`;
      const source = await api<RoleplaySession>("/api/roleplay/sessions", {
        cardId: card.id,
        title: sourceTitle,
        scenario: "两扇门",
        player: { name: "旅人", identity: "访客", relationship: "" },
      });
      const path = `/api/roleplay/sessions/${source.id}`;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: "zh-CN",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const openRoleplay = async () => {
        if (width === 390)
          await page
            .getByRole("button", { name: "打开导航", exact: true })
            .click();
        await page
          .getByRole("navigation", { name: "主要模块" })
          .getByRole("button", { name: /^情景演绎/ })
          .click();
      };
      const namedStory = (title: string) =>
        page.locator(".story-list-item").filter({ hasText: title });
      const dialog = (name: string) =>
        page.getByRole("dialog", { name, exact: true });
      const quick = page.getByRole("group", { name: "快捷回复" });
      await page.goto(url);
      await openRoleplay();
      await namedStory(sourceTitle).click();
      await page
        .getByText("开场白不能作为存档节点。", { exact: true })
        .waitFor();
      const input = page.getByRole("textbox", { name: "回复剧情" });
      await input.fill(opening);
      await input.press("Enter");
      const node = page.getByRole("group", { name: "第 1 轮节点操作" });
      await node.getByRole("button", { name: "保存这一刻" }).click();
      const save = dialog("保存这一刻");
      assert.match(
        await save.getByRole("textbox", { name: "存档名称" }).inputValue(),
        /^第 1 轮/,
      );
      const emergency = page.getByRole("button", {
        name: "紧急停止",
        exact: true,
      });
      await emergency.click({ trial: true });
      const beforeSave = calls;
      await save.getByRole("textbox", { name: "存档名称" }).fill("岔路书签");
      await save.getByRole("button", { name: "保存", exact: true }).click();
      await node.getByRole("button", { name: "已存档" }).waitFor();
      await page.getByRole("button", { name: "剧情存档", exact: true }).click();
      const list = dialog("剧情存档");
      await list.getByText("岔路书签", { exact: true }).waitFor();
      await list.getByRole("button", { name: "重命名", exact: true }).click();
      const rename = dialog("重命名存档");
      await rename
        .getByRole("textbox", { name: "存档名称" })
        .fill("改名后的书签");
      await rename.getByRole("button", { name: "保存", exact: true }).click();
      await list.getByText("改名后的书签", { exact: true }).waitFor();
      await list.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      assert.equal(calls, beforeSave);
      const anchor = (
        await api<{ items: StoryMessage[] }>(path + "/messages")
      ).items.at(-1)!;

      await quick.getByRole("button", { name: /我打开西门/ }).click();
      await page
        .locator(".story-message.assistant")
        .getByText(/7319/)
        .waitFor();
      const beforeFork = calls;
      if (width === 390) {
        await page.reload();
        await openRoleplay();
        await page
          .getByRole("heading", { name: sourceTitle, exact: true })
          .waitFor();
        await node.getByRole("button", { name: "创建分支" }).click();
      } else {
        await page
          .getByRole("button", { name: "剧情存档", exact: true })
          .click();
        await list.getByRole("button", { name: "创建分支" }).click();
      }
      const branchDialog = dialog("从这里创建分支");
      assert.equal(
        await branchDialog
          .getByRole("textbox", { name: "分支名称" })
          .inputValue(),
        sourceTitle + " · 分支 1",
      );
      await branchDialog
        .getByRole("textbox", { name: "分支名称" })
        .fill(branchTitle);
      await emergency.click({ trial: true });
      const attempts: string[] = [];
      await page.route(
        `**${path}/messages/${anchor.id}/branch`,
        async (route) => {
          attempts.push(route.request().postDataJSON().requestId);
          if (width === 1512 && attempts.length === 1) {
            const result = await route.fetch();
            assert.ok(result.ok());
            await route.abort();
          } else await route.continue();
        },
      );
      const submit = branchDialog.getByRole("button", { name: "确认创建分支" });
      await submit.click();
      if (width === 1512) {
        await branchDialog.getByRole("alert").waitFor();
        await submit.click();
      }
      await page
        .getByRole("heading", { name: branchTitle, exact: true })
        .waitFor();
      if (width === 1512)
        assert.deepEqual(attempts, [attempts[0], attempts[0]]);
      assert.equal(calls, beforeFork);
      const branches = (
        await api<RoleplaySession[]>("/api/roleplay/sessions")
      ).filter((s) => s.title === branchTitle);
      assert.equal(branches.length, 1);
      const branchPath = `/api/roleplay/sessions/${branches[0].id}`;
      const detail = await api<RoleplaySession>(branchPath);
      const inherited = (
        await api<{ items: StoryMessage[] }>(branchPath + "/messages")
      ).items;
      assert.equal(
        inherited.at(-1)!.id,
        detail.storyState.lastUpdate!.messageId,
      );
      assert.notEqual(detail.storyState.lastUpdate!.messageId, anchor.id);
      assert.equal(
        await page.locator(".story-message").getByText(/7319/).count(),
        0,
      );
      assert.equal(await quick.getByRole("button").count(), 3);
      await quick.getByRole("button", { name: /我走向东门/ }).click();
      await page
        .getByText(/庭院里有一棵梧桐/)
        .first()
        .waitFor();
      await page
        .getByRole("button", { name: "返回来源故事", exact: true })
        .click();
      await page
        .locator(".story-message.assistant")
        .getByText(/7319/)
        .waitFor();
      await page.getByRole("button", { name: "剧情存档", exact: true }).click();
      await list.getByRole("button", { name: "删除存档", exact: true }).click();
      await dialog("删除存档")
        .getByRole("button", { name: "确认删除存档" })
        .click();
      await list.getByText(/还没有存档/).waitFor();
      await list.getByRole("button", { name: "关闭弹窗", exact: true }).click();
      if (width === 390)
        await page
          .getByRole("button", { name: "角色与故事", exact: true })
          .click();
      await namedStory(branchTitle).click();
      await page
        .getByRole("heading", { name: branchTitle, exact: true })
        .waitFor();
      await page.reload();
      await openRoleplay();
      await page
        .getByRole("heading", { name: branchTitle, exact: true })
        .waitFor();
      await page
        .locator(".story-message.assistant")
        .getByText(/庭院里有一棵梧桐/)
        .waitFor();
      assert.equal(calls, beforeFork + 1);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      assert.ok(await emergency.isVisible());
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: resolve(artifacts, `branch-${width}.png`),
        fullPage: true,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.equal(checkedBranchRequests, 2);
  assert.deepEqual(providerErrors, []);
  const report = {
    widths: [1512, 390],
    modelRequests: calls,
    completeBranchRequestsChecked: checkedBranchRequests,
    providerErrors,
  };
  await writeFile(
    resolve(artifacts, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((done) => provider.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
