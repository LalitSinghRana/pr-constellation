import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubNotificationsClient } from "../inbox/github-notifications.js";

test("GitHub notification polling preserves cursors and follows safe pagination", async () => {
  const requests = [];
  const pages = [
    response([{ id: "1" }], {
      "last-modified": "Thu, 06 Aug 2026 08:00:00 GMT",
      link: '<https://api.github.com/notifications?page=2>; rel="next"',
      "x-poll-interval": "90",
    }),
    response([{ id: "2" }]),
  ];
  const getNotifications = createGitHubNotificationsClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return pages.shift();
    },
    getToken: async () => "secret",
  });

  const result = await getNotifications({
    lastModified: "Thu, 06 Aug 2026 07:00:00 GMT",
    since: "2026-08-06T07:00:00.000Z",
  });

  assert.deepEqual(
    result.threads.map(({ id }) => id),
    ["1", "2"],
  );
  assert.equal(result.pollIntervalSeconds, 90);
  assert.equal(requests[0].options.headers["If-Modified-Since"], "Thu, 06 Aug 2026 07:00:00 GMT");
  assert.equal("If-Modified-Since" in requests[1].options.headers, false);
  assert.match(requests[0].url, /since=2026-08-06T07%3A00%3A00.000Z/);
});

test("GitHub notification polling returns a 304 without reading a body", async () => {
  const getNotifications = createGitHubNotificationsClient({
    fetchImpl: async () => response(null, { "x-poll-interval": "120" }, 304),
    getToken: async () => "secret",
  });

  assert.deepEqual(await getNotifications({ lastModified: "cursor" }), {
    lastModified: "cursor",
    notModified: true,
    pollIntervalSeconds: 120,
    threads: [],
  });
});

function response(body, headers = {}, status = 200) {
  return {
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    async json() {
      assert.notEqual(body, null, "304 response body must not be read");
      return body;
    },
  };
}
