import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPlainTextMock } = vi.hoisted(() => ({
  fetchPlainTextMock: vi.fn(),
}));

vi.mock("@/worker/core/fetch", () => ({
  fetchPlainText: fetchPlainTextMock,
}));

import { fetchAllJejuOpenApiItems } from "../worker/jobs/jeju-openapi";

describe("jeju openapi client", () => {
  beforeEach(() => {
    fetchPlainTextMock.mockReset();
  });

  it("paginates xml responses and appends the optional service key", async () => {
    fetchPlainTextMock
      .mockResolvedValueOnce(`
        <response>
          <header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
          <body>
            <pageNo>1</pageNo>
            <numOfRows>2</numOfRows>
            <totalCount>3</totalCount>
            <items>
              <item><stationId>1</stationId><stationNm>A</stationNm></item>
              <item><stationId>2</stationId><stationNm>B</stationNm></item>
            </items>
          </body>
        </response>
      `)
      .mockResolvedValueOnce(`
        <response>
          <header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
          <body>
            <pageNo>2</pageNo>
            <numOfRows>2</numOfRows>
            <totalCount>3</totalCount>
            <items>
              <item><stationId>3</stationId><stationNm>C</stationNm></item>
            </items>
          </body>
        </response>
      `);

    const runtime = {
      env: {
        jejuOpenApiBaseUrl: "http://example.test/api",
        jejuOpenApiServiceKey: "secret-key",
      },
    } as never;

    const items = await fetchAllJejuOpenApiItems<{ stationId: string; stationNm: string }>(
      runtime,
      "Station2",
      {},
      2,
    );

    expect(items.map((item) => item.stationId)).toEqual(["1", "2", "3"]);
    expect(fetchPlainTextMock).toHaveBeenCalledTimes(2);
    expect(fetchPlainTextMock.mock.calls[0][0]).toBe("http://example.test/api/Station2");
    expect(fetchPlainTextMock.mock.calls[0][1]).toMatchObject({
      pageNo: 1,
      numOfRows: 2,
      ServiceKey: "secret-key",
    });
  });
});
