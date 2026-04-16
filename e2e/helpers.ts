// SPDX-License-Identifier: Hippocratic-3.0
import { type Page, expect } from '@playwright/test';

const PERSISTENT_USER = {
  email: 'e2e@test.babelr.local',
  password: 'test-password-12chars',
};

/**
 * Log in as the persistent test account via the UI login form.
 */
export async function login(page: Page) {
  await page.goto('/');
  await page.locator('.auth-form').waitFor({ timeout: 5000 });
  await page.getByPlaceholder('Email').fill(PERSISTENT_USER.email);
  await page.getByPlaceholder('Password').fill(PERSISTENT_USER.password);
  await page.locator('button.auth-submit').click();
  await page.locator('.app-layout').waitFor({ timeout: 10000 });
}

/**
 * Register a fresh user via the UI. Waits for the onboarding wizard
 * to appear (displayName is null → wizard shows).
 */
export async function registerFresh(page: Page) {
  const ts = Date.now();
  await page.goto('/');
  await page.locator('.auth-form').waitFor({ timeout: 5000 });
  // Switch to Register tab
  await page.locator('.auth-tab').filter({ hasText: /register/i }).click();
  // Fill registration fields
  await page.getByPlaceholder('Username').fill(`e2e_${ts}`);
  await page.getByPlaceholder('Email').fill(`e2e_${ts}@test.babelr.local`);
  await page.getByPlaceholder('Password').fill('test-password-12chars');
  await page.locator('button.auth-submit').click();
  // Wait for onboarding wizard (new user has no displayName)
  await page.locator('.onboarding-card').waitFor({ timeout: 10000 });
}

/**
 * Complete the onboarding wizard so we land on the main ChatView.
 * Assumes the wizard is already visible.
 */
export async function completeOnboarding(page: Page) {
  await expect(page.locator('.onboarding-card')).toBeVisible();

  // Step 1: Profile — set display name
  await page.locator('.onboarding-step input[type="text"]').fill('E2E Test User');
  await page.locator('.onboarding-btn.primary').click();

  // Step 2: Language — accept default, click next
  await page.locator('.onboarding-btn.primary').click();

  // Step 3: Server — skip
  await page.locator('.onboarding-skip').click();

  // Step 4: Embeds — click next
  await page.locator('.onboarding-btn.primary').click();

  // Step 5: Done — get started
  await page.locator('.onboarding-btn.primary').click();

  await page.locator('.app-layout').waitFor({ timeout: 10000 });
}
