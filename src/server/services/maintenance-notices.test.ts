import { describe, expect, it } from "vitest";
import {
  fetchJpMaintenanceHtml,
  jpMaintenanceLinks,
  jpMaintenanceUrl,
  parseMaintenanceNotice,
} from "./maintenance-notices";

const jpUrl = "https://news.fate-go.jp/2025/0409plmil/";
const jp = `<title>メンテナンス終了のお知らせ</title><p>日時 2025年4月9日(水) 13:00~18:00</p>
<p>▼ゲームの更新 「テストイベント」の開始</p><p>▼不具合の修正 「別のイベント」の開始</p>
<p>メンテナンスのお詫び 【対象】 メンテナンス開始前のプレイヤー 【対応内容】 聖晶石 5個 【配布方法】 プレゼントボックス</p>`;
const naUrl = "https://webview.fate-go.us/2026/1013_maintenance/";
const na = `<title>Scheduled Maintenance Completion Notice</title><div class="article"><p>- Date &amp; Time</p><p>2026-10-15 21:00 - 2026-10-16 02:00 PDT (GMT -7)</p>
<p>* Contents</p><p>Commencement of "Test Event".</p><p>Bug Fixes:</p><p>Commencement of "Unrelated Event".</p>
<p>As an apology</p><p>Applies to: Existing players Details: Saint Quartz x5 Distribution Method: Present Box Distribution Period: After maintenance, until 2027-03-31 16:59 PDT (GMT -7) We sincerely apologize.</p></div>`;
describe("maintenance evidence", () => {
  it("extracts explicit JP SQ and launch names, not bug-fix mentions", () => {
    expect(parseMaintenanceNotice(jp, jpUrl, "JP")).toMatchObject({
      amount: 5,
      endsAt: "2025-04-09T09:00:00.000Z",
      launchNames: ["テストイベント"],
    });
  });
  it("uses explicit Global timestamps and distribution start", () => {
    expect(parseMaintenanceNotice(na, naUrl, "NA")).toMatchObject({
      amount: 5,
      startsAt: "2026-10-16T04:00:00.000Z",
      endsAt: "2026-10-16T09:00:00.000Z",
      distributionStartsAt: "2026-10-16T09:00:00.000Z",
      launchNames: ["Test Event"],
    });
  });
  it.each([
    jp.replace("聖晶石 5個", "黄金の果実 5個"),
    jp.replace("聖晶石 5個", "聖晶石 5個 聖晶石 2個"),
    jp.replace("メンテナンス終了のお知らせ", "緊急メンテナンス終了のお知らせ"),
    jp.replace("メンテナンス終了のお知らせ", "メンテナンス実施のお知らせ"),
    jp.replace("4月9日", "2月30日"),
  ])("does not infer amounts, completion or invalid dates", (body) =>
    expect(parseMaintenanceNotice(body, jpUrl, "JP")).toBeNull(),
  );
  it("does not fold unscheduled Global maintenance into a routine estimate", () => {
    expect(
      parseMaintenanceNotice(
        na.replace("Scheduled Maintenance", "Unscheduled Maintenance"),
        naUrl,
        "NA",
      ),
    ).toBeNull();
  });
  it("accepts only observed links on the fixed JP publisher host", () => {
    expect(
      jpMaintenanceLinks(
        `<a href="/2025/0409plmil/">メンテナンス終了</a><a href="https://evil.test/2025/notice/">メンテナンス終了</a>`,
        "https://news.fate-go.jp/maintenance/",
      ),
    ).toEqual([jpUrl]);
    for (const url of [
      "https://evil.test/2025/notice/",
      "https://news.fate-go.jp@evil.test/2025/notice/",
      `${jpUrl}?redirect=1`,
    ])
      expect(() => jpMaintenanceUrl(url)).toThrow();
  });
  it("reads the sibling title on JP archive cards", () => {
    expect(
      jpMaintenanceLinks(
        '<ul><li><p>メンテナンス終了のお知らせ</p><a href="/2025/0409plmil/"></a></li></ul>',
        "https://news.fate-go.jp/maintenance/",
      ),
    ).toEqual([jpUrl]);
  });
  it("does not follow redirects or send credentials", async () => {
    const fetchFn = (async (_url, options) => {
      expect(options).toMatchObject({
        redirect: "manual",
        credentials: "omit",
      });
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/" },
      });
    }) as typeof fetch;
    await expect(fetchJpMaintenanceHtml(jpUrl, fetchFn)).rejects.toThrow();
  });
});
