import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  handleGitHubMediaRequest,
  isAllowedGitHubMediaRedirectUrl,
  isAllowedGitHubMediaUrl,
} from "../review/github-media.js";

test("isAllowedGitHubMediaUrl accepts GitHub attachment hosts only", () => {
  assert.equal(
    isAllowedGitHubMediaUrl(
      "https://github.com/user-attachments/assets/18fdb2d9-8a16-477d-8793-8540f12fac76",
    ),
    true,
  );
  assert.equal(
    isAllowedGitHubMediaUrl("https://private-user-images.githubusercontent.com/123/shot.png"),
    true,
  );
  assert.equal(isAllowedGitHubMediaUrl("https://evil.example/github.com/x"), false);
  assert.equal(isAllowedGitHubMediaUrl("http://github.com/user-attachments/assets/abc"), false);
  assert.equal(
    isAllowedGitHubMediaUrl(
      "https://github-production-user-asset-6210df.s3.amazonaws.com/1/shot.mov",
    ),
    false,
  );
  assert.equal(
    isAllowedGitHubMediaRedirectUrl(
      "https://github-production-user-asset-6210df.s3.amazonaws.com/1/shot.mov",
    ),
    true,
  );
  assert.equal(
    isAllowedGitHubMediaRedirectUrl("https://evil-bucket.s3.amazonaws.com/shot.mov"),
    false,
  );
});

test("github media proxy rejects non-GitHub URLs", async () => {
  const { status, body } = await requestMedia("https://example.com/photo.png");
  assert.equal(status, 400);
  assert.match(body, /Unsupported media URL/);
});

test("github media proxy streams allowed GitHub attachments", async () => {
  const target = "https://github.com/user-attachments/assets/18fdb2d9-8a16-477d-8793-8540f12fac76";
  const { status, body, contentType } = await requestMedia(target, {
    fetchImpl: async (url) => {
      assert.equal(url, target);
      return {
        arrayBuffer: async () => Buffer.from("png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
        ok: true,
        status: 200,
      };
    },
    getToken: async () => "test-token",
  });
  assert.equal(status, 200);
  assert.equal(contentType, "image/png");
  assert.equal(body, "png-bytes");
});

test("github media proxy rejects oversized attachments from Content-Length", async () => {
  const target = "https://github.com/user-attachments/assets/18fdb2d9-8a16-477d-8793-8540f12fac76";
  const { status, body } = await requestMedia(target, {
    fetchImpl: async () => ({
      body: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(
                new Error("body should not be read after Content-Length rejection"),
              );
            },
          };
        },
      },
      headers: new Headers({
        "content-length": String(101 * 1024 * 1024),
        "content-type": "video/quicktime",
      }),
      ok: true,
      status: 200,
    }),
    getToken: async () => "test-token",
  });
  assert.equal(status, 413);
  assert.match(body, /too large/);
});

test("github media proxy follows GitHub attachment redirects to the user-asset bucket", async () => {
  const target = "https://github.com/user-attachments/assets/18fdb2d9-8a16-477d-8793-8540f12fac76";
  const s3 =
    "https://github-production-user-asset-6210df.s3.amazonaws.com/1/18fdb2d9-8a16-477d-8793-8540f12fac76.mov";
  const { status, body, contentType } = await requestMedia(target, {
    fetchImpl: async (url, init) => {
      if (url === target) {
        assert.match(init.headers.Authorization, /Bearer test-token/);
        return {
          headers: new Headers({ location: s3 }),
          ok: false,
          status: 302,
        };
      }
      assert.equal(url, s3);
      assert.equal(init.headers.Authorization, undefined);
      return {
        arrayBuffer: async () => Buffer.from("mov-bytes"),
        headers: new Headers({ "content-type": "video/quicktime" }),
        ok: true,
        status: 200,
      };
    },
    getToken: async () => "test-token",
  });
  assert.equal(status, 200);
  assert.equal(contentType, "video/quicktime");
  assert.equal(body, "mov-bytes");
});

async function requestMedia(target, deps = {}) {
  const server = createServer((request, response) => {
    handleGitHubMediaRequest(request, response, deps).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/github-media?url=${encodeURIComponent(target)}`,
  );
  const body = await response.text();
  server.close();
  return {
    body,
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}
