import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlainText } from "@/worker/core/fetch";

describe("worker fetch helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("decodes encoded service keys once before appending them to URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchPlainText("https://example.test/endpoint", {
      ServiceKey: "abc%2B123%3D",
    });

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("ServiceKey=abc%2B123%3D");
    expect(requestUrl).not.toContain("%252B");
    expect(requestUrl).not.toContain("%253D");
  });

  it("retries transient timeout failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
      .mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPlainText("https://bus.jeju.go.kr/mobile/test")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
