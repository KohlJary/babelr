// SPDX-License-Identifier: Hippocratic-3.0
import { test, expect } from '@playwright/test';
import { login, registerFresh, completeOnboarding } from './helpers';

test.describe('View registry — surfaces render in correct containers', () => {
  test.beforeEach(async ({ page }) => {
    // Clear session so each test starts fresh
    await page.context().clearCookies();
  });
  test('settings opens as a tabbed view, not a modal overlay', async ({ page }) => {
    await login(page);

    // Click the settings gear button in the channel header
    const settingsBtn = page.locator('button').filter({ hasText: /⚙|settings/i }).first();
    if (!await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Try the gear icon button (may be an icon-only button)
      await page.locator('.channel-header button').last().click();
    } else {
      await settingsBtn.click();
    }

    await expect(page.locator('.tabbed-view')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.settings-overlay')).not.toBeVisible();
    await expect(page.locator('.tabbed-view-tab').filter({ hasText: 'Profile' })).toBeVisible();
    await expect(page.locator('.tabbed-view-tab').filter({ hasText: 'Translation' })).toBeVisible();
    await expect(page.locator('.tabbed-view-tab').filter({ hasText: 'Account' })).toBeVisible();
  });

  test('member list renders in side panel, not modal', async ({ page }) => {
    await login(page);

    // Click a server icon (not the DM icon) to switch to server mode
    const serverIcon = page.locator('.server-sidebar .server-icon:not(.dm-icon):not(.add-server):not(.manual-icon)').first();
    await expect(serverIcon).toBeVisible({ timeout: 3000 });
    await serverIcon.click();
    await page.waitForTimeout(500);

    // MemberList should be in a side-panel as the default right panel
    await expect(page.locator('.side-panel')).toBeVisible({ timeout: 5000 });
    // Should NOT be in a settings-overlay
    await expect(page.locator('.settings-overlay .discover-list')).not.toBeVisible();
  });

  test('no thread-panel-overlay in DOM', async ({ page }) => {
    await login(page);
    // Wait for app to fully render before checking
    await page.waitForTimeout(500);
    await expect(page.locator('.thread-panel-overlay')).toHaveCount(0);
  });

  test('friends opens as a view, not a modal overlay', async ({ page }) => {
    await login(page);

    // Friends button is in the DM sidebar
    const friendsBtn = page.locator('button').filter({ hasText: /friends/i }).first();
    if (await friendsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await friendsBtn.click();
      await expect(page.locator('.friends-view')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.settings-overlay')).not.toBeVisible();
    }
  });

  test('mentions opens as a ScrollListView, not a modal overlay', async ({ page }) => {
    await login(page);

    // Mentions button is the @ icon in the channel header
    const mentionsBtn = page.locator('button').filter({ hasText: '@' }).first();
    if (await mentionsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await mentionsBtn.click();
      await expect(page.locator('.scroll-list-view')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.settings-overlay')).not.toBeVisible();
    }
  });

  test('onboarding wizard has 5 progress dots', async ({ page }) => {
    await registerFresh(page);
    // registerFresh waits for .onboarding-card
    await expect(page.locator('.onboarding-progress-dot')).toHaveCount(5);
  });

  test('onboarding wizard completes all steps to ChatView', async ({ page }) => {
    await registerFresh(page);
    await completeOnboarding(page);
    await expect(page.locator('.app-layout')).toBeVisible({ timeout: 5000 });
  });
});
