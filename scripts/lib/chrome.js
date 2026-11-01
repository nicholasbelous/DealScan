// A small headless Chrome driver over the DevTools pipe, with no dependencies.
// Used by the browser tests and the fixture sanitizer. Runs in a throwaway profile.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IN_CI = Boolean(process.env.CI);

export function findChrome() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ];
  return candidates.find((p) => fs.existsSync(p));
}

export async function launchChrome(chromePath, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      ...(IN_CI ? ["--no-sandbox"] : []), // CI runners don't allow Chrome's sandbox
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );

  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  const waiters = [];

  chrome.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      for (const waiter of [...waiters]) {
        if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    }
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  async function newPage() {
    const { result } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = (await send("Target.attachToTarget", { targetId: result.targetId, flatten: true })).result;
    await send("Page.enable", {}, sessionId);

    return {
      send: (method, params) => send(method, params, sessionId),
      async navigate(url) {
        const loaded = new Promise((resolve) => waiters.push({ method: "Page.loadEventFired", sessionId, resolve }));
        await send("Page.navigate", { url }, sessionId);
        await loaded;
      },
      /** Evaluate an expression in the page. Throws if it throws. */
      async evaluate(expression) {
        const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (res.result?.exceptionDetails) {
          throw new Error(res.result.exceptionDetails.exception?.description ?? "page evaluation failed");
        }
        return res.result?.result?.value;
      },
    };
  }

  return {
    newPage,
    close() {
      chrome.kill();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
