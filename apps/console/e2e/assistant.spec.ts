// T-148 REQ-AI-008 (ADR-028) — the Assistant's conversations against the live stack, per locale project: an uptime
// question opens a conversation whose id lands in the URL; "and last month?" is answered as the previous month's
// availability in the same conversation; a reload brings the whole thread back from the server; the conversation is
// listed, a new one can be started, and deleting it empties the list. Screenshots are the evidence
// (docs/evidence/assistant-conversations.md).
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { isLocale, translate, type Locale } from '@openmap/i18n';
import { signIn } from './auth';

const ANSWER_TIMEOUT_MS = 120_000;
const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));

function localeOf(name: string): Locale {
  if (!isLocale(name)) throw new Error('project name must be a locale: ' + name);
  return name;
}

const FOLLOW_UP: Record<Locale, string> = { en: 'And last month?', ar: 'والشهر الماضي؟' };

async function askTyped(page: Page, locale: Locale, text: string): Promise<void> {
  await page.getByLabel(translate(locale, 'assistant.ask')).fill(text);
  await page.getByRole('button', { name: translate(locale, 'assistant.send') }).click();
}

test('Assistant: a conversation survives a reload and answers "and last month?" (REQ-AI-008)', async ({ page }, testInfo) => {
  const locale = localeOf(testInfo.project.name);
  test.setTimeout(ANSWER_TIMEOUT_MS * 3);
  await page.goto('/' + locale + '/assistant');
  await signIn(page, locale);

  // Turn one: the uptime example opens a conversation; its id lands in the URL once the answer is back.
  await page.getByRole('button', { name: translate(locale, 'assistant.example.uptime') }).click();
  // Exact names: "Conversation" is also a substring of "Past conversations".
  const conversation = page.getByRole('list', { name: translate(locale, 'assistant.conversation'), exact: true });
  await expect(conversation.getByTestId('assistant-evidence').first()).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
  await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/, { timeout: ANSWER_TIMEOUT_MS });
  const conversationId = /[?&]c=([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
  expect(conversationId).not.toBe('');

  // Turn two: the follow-up is read against the first turn and comes back as last month's availability.
  await askTyped(page, locale, FOLLOW_UP[locale]);
  await expect(conversation.getByTestId('assistant-evidence')).toHaveCount(2, { timeout: ANSWER_TIMEOUT_MS });
  const second = conversation.locator(':scope > li').nth(1);
  // The question paragraph, not the follow-up chip of the first answer that reads the same.
  await expect(second.locator('p').first()).toHaveText(FOLLOW_UP[locale]);
  await expect(second.getByTestId('assistant-understood')).toContainText(
    translate(locale, 'assistant.intent.availability'),
  );
  await expect(second.getByRole('group', { name: translate(locale, 'assistant.figures') })).toBeVisible();
  await second.getByTestId('assistant-evidence').locator('summary').click();
  // The evidence shows the report call as run: two periods are read so the previous month can be answered.
  await expect(second.getByTestId('assistant-evidence').getByText('periods=2', { exact: false })).toBeVisible();
  await page.screenshot({ path: screenshotsDir + 'assistant-followup-' + locale + '.png', fullPage: true });

  // The list shows the conversation with both turns; a reload rebuilds the thread from the server.
  const list = page.getByRole('list', { name: translate(locale, 'assistant.conversationList'), exact: true });
  await expect(list.locator(':scope > li').first()).toContainText(
    translate(locale, 'assistant.turnCount', { count: '2' }),
  );
  await page.reload();
  await expect(conversation.locator(':scope > li')).toHaveCount(2, { timeout: ANSWER_TIMEOUT_MS });
  await expect(conversation.locator(':scope > li').nth(1).locator('p').first()).toHaveText(FOLLOW_UP[locale]);
  await page.screenshot({ path: screenshotsDir + 'assistant-reloaded-' + locale + '.png', fullPage: true });

  // A new conversation clears the thread and the URL; opening the old one from the list brings it back.
  await page.getByRole('button', { name: translate(locale, 'assistant.newConversation') }).click();
  await expect(page).not.toHaveURL(/[?&]c=/);
  await expect(page.getByText(translate(locale, 'assistant.empty'))).toBeVisible();
  // The list is ordered by last activity, so the conversation just held is first.
  await list.locator(':scope > li').first().getByRole('button').first().click();
  await expect(page).toHaveURL(new RegExp('c=' + conversationId));
  await expect(conversation.locator(':scope > li')).toHaveCount(2, { timeout: ANSWER_TIMEOUT_MS });

  // Deleting the open conversation leaves the list without it and the thread empty.
  const before = await list.locator(':scope > li').count();
  const first = list.locator(':scope > li').first();
  // Title, turn count and time: what tells this conversation apart from the tenant's older ones.
  const entry = ((await first.locator('button').first().textContent()) ?? '').trim();
  expect(entry).not.toBe('');
  await first.getByRole('button', { name: translate(locale, 'assistant.deleteConversation') }).click();
  await expect(page).not.toHaveURL(/[?&]c=/);
  if (before === 1) await expect(page.getByText(translate(locale, 'assistant.noConversations'))).toBeVisible();
  // The list is capped, so with more stored conversations than it shows it refills: the deleted entry is what must go.
  else await expect(list.locator(':scope > li').filter({ hasText: entry })).toHaveCount(0);
});
