import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventHub } from "../http/event-hub.js";
import { requestPathname } from "../http/http-server.js";
import { serveStaticFiles } from "../http/static-files.js";

test("the HTTP boundary rejects malformed request targets without throwing", () => {
  assert.equal(requestPathname({ url: "//[" }), null);
  assert.equal(requestPathname({ url: "/api/inbox?view=active" }), "/api/inbox");
});

test("production static hosting serves the SPA without following outside symlinks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prc-static-"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  context.after(() =>
    Promise.all([rm(root, { force: true, recursive: true }), rm(outside, { force: true })]),
  );
  await Promise.all([
    writeFile(path.join(root, "index.html"), "<main>Cockpit</main>"),
    writeFile(outside, "private"),
  ]);
  await symlink(outside, path.join(root, "leak.txt"));

  const spaResponse = new FakeResponse();
  assert.equal(
    await serveStaticFiles({
      request: { method: "GET", url: "/analysis" },
      response: spaResponse,
      root,
    }),
    true,
  );
  assert.equal(spaResponse.status, 200);
  assert.equal(spaResponse.body.toString(), "<main>Cockpit</main>");

  assert.equal(
    await serveStaticFiles({
      request: { method: "GET", url: "/leak.txt" },
      response: new FakeResponse(),
      root,
    }),
    false,
  );
});

test("event streams clean up closed clients and enforce a connection cap", () => {
  const hub = createEventHub({ maxClients: 1 });
  const first = new FakeResponse();
  hub.handle({ method: "GET" }, first);
  assert.match(first.body.toString(), /event: ready/);

  const rejected = new FakeResponse();
  hub.handle({ method: "GET" }, rejected);
  assert.equal(rejected.status, 503);

  first.emit("close");
  const replacement = new FakeResponse();
  hub.handle({ method: "GET" }, replacement);
  hub.publish("inbox", { changed: true });
  assert.match(replacement.body.toString(), /event: inbox/);
  hub.close();
  assert.equal(replacement.ended, true);
});

class FakeResponse extends EventEmitter {
  body = Buffer.alloc(0);
  destroyed = false;
  ended = false;
  status = null;

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(value) {
    this.body = Buffer.concat([this.body, Buffer.from(value)]);
    return true;
  }

  end(value) {
    if (value) this.write(value);
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}
