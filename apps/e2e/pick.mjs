// Chooses an option in the DavraBox dropdown (a listbox, not a native select): open the trigger, click the option by value.
export async function pickOption(page, selector, value) {
  await page.locator(selector).click();
  await page.locator(`[role=listbox] [role=option][data-value="${value}"]`).click();
}
// Same, by position in the list (0-based), for tests that only need "some other choice".
export async function pickOptionIndex(page, selector, index) {
  await page.locator(selector).click();
  await page.locator('[role=listbox] [role=option]').nth(index).click();
}
// The option values a dropdown offers, in order (opens it, reads, closes it again).
export async function listOptions(page, selector) {
  await page.locator(selector).click();
  const values = await page.locator('[role=listbox] [role=option]').evaluateAll((o) => o.map((x) => x.getAttribute('data-value')));
  await page.keyboard.press('Escape');
  await page.locator('[role=listbox]').waitFor({ state: 'detached' });
  return values;
}
