import type { Dialog, Frame, Page } from "playwright";

export async function closeBrowserPage(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

export async function withBrowserPage(
  pagePromise: Promise<Page>,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await pagePromise;
  try {
    await run(page);
  } finally {
    await closeBrowserPage(page);
  }
}

/** Reloads like the browser button; returns the dismissed prompt type, or undefined after navigation. */
export async function reloadDismissingUnloadPrompt(page: Page) {
  const session = await page.context().newCDPSession(page);
  const outcome = Promise.withResolvers<string | undefined>();
  const onDialog = (dialog: Dialog) => {
    void dialog.dismiss().then(() => outcome.resolve(dialog.type()), outcome.reject);
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      outcome.resolve(undefined);
    }
  };
  page.on("dialog", onDialog);
  page.on("framenavigated", onNavigation);
  try {
    // Cancellation has no navigation to await; observe the native outcome instead.
    await session.send("Page.reload");
    return await outcome.promise;
  } finally {
    page.off("dialog", onDialog);
    page.off("framenavigated", onNavigation);
    await session.detach();
  }
}
