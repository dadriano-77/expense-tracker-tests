import { test, expect, Page } from '@playwright/test';

const USERNAME = `e2e_${Date.now()}`;
const PASSWORD  = 'E2eTest1!';

async function register(page: Page) {
  await page.goto('/register');
  await page.fill('#username', USERNAME);
  await page.fill('#password', PASSWORD);
  await page.fill('#confirm', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/expenses');
}

async function loginAs(page: Page, u = USERNAME, p = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', u);
  await page.fill('#password', p);
  await page.click('button[type=submit]');
  await page.waitForURL('**/expenses');
}

test.describe('Auth', () => {
  test('register creates account and redirects to expenses', async ({ page }) => {
    await register(page);
    await expect(page).toHaveURL(/\/expenses/);
    await expect(page.getByRole('heading', { name: /expenses/i })).toBeVisible();
  });

  test('login with valid credentials redirects to expenses', async ({ page }) => {
    await loginAs(page);
    await expect(page).toHaveURL(/\/expenses/);
  });

  test('login with wrong password shows error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', USERNAME);
    await page.fill('#password', 'wrongpassword');
    await page.click('button[type=submit]');
    await expect(page.locator('.error-msg')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('unauthenticated visit to /expenses redirects to login', async ({ page }) => {
    await page.goto('/expenses');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Categories', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto('/categories');
  });

  test('shows categories page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /categories/i })).toBeVisible();
  });

  test('creates a new category', async ({ page }) => {
    const name = `Cat_${Date.now()}`;
    await page.fill('input[name=name]', name);
    await page.click('button[type=submit]');
    await expect(page.locator('ul, .data-list').getByText(name)).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Expenses', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('shows expenses page with add form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /expenses/i })).toBeVisible();
    await expect(page.locator('form')).toBeVisible();
  });

  test('creates an expense after adding a category', async ({ page }) => {
    await page.goto('/categories');
    const catName = `E2eCat_${Date.now()}`;
    await page.fill('input[name=name]', catName);
    await page.click('button[type=submit]');
    await expect(page.locator('ul, .data-list').getByText(catName)).toBeVisible({ timeout: 5000 });

    await page.goto('/expenses');

    await page.selectOption('select[name=category_id]', { label: catName });
    await page.fill('input[name=amount]', '99.99');
    await page.fill('input[name=description]', 'Playwright E2E test expense');
    await page.fill('input[name=date]', '2024-03-15');
    await page.click('button[type=submit]');

    await expect(page.getByText('Playwright E2E test expense')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto('/dashboard');
  });

  test('shows dashboard heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  });
});

test.describe('Budgets', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto('/budgets');
  });

  test('shows budgets page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /budgets/i })).toBeVisible();
  });
});
