import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  trimmedTextContents,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("disambiguates same-name sessions from different Telegram accounts in the sidebar", async () => {
    const defaultKey = "agent:main:telegram:direct:42";
    const cardsKey = "agent:main:telegram:cards:direct:42";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(defaultKey, "Alice", 2),
          sessionRow(cardsKey, "Alice", 1),
        ]),
      },
      sessionKey: defaultKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, defaultKey));
      const defaultRow = page.locator(`[data-session-key="${defaultKey}"]`);
      const cardsRow = page.locator(`[data-session-key="${cardsKey}"]`);
      await defaultRow.waitFor({ state: "visible", timeout: 10_000 });
      await cardsRow.waitFor({ state: "visible" });
      await expect
        .poll(() => trimmedTextContents(defaultRow.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice"]);
      await expect
        .poll(() => trimmedTextContents(cardsRow.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice · cards"]);
      await captureUiProof(page, "telegram-account-session-labels.png");
    } finally {
      await context.close();
    }
  });
});
