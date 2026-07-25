import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { clearTab, facebookThemeKey, getFacebookTheme, purgeTab, setFacebookTheme } from '../src/shared/storage';
import { resetChromeStorage } from './chrome-fake';

const tabId = 932;

beforeEach(resetChromeStorage);

test('setFacebookTheme acknowledges only after the small session record is durable', async () => {
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.set = async (values): Promise<void> => {
    if (facebookThemeKey(tabId) in values) await blocked;
    await realSet(values);
  };

  let settled = false;
  const pending = setFacebookTheme(tabId, { theme: 'dark', at: 1234 }).then((ok) => {
    settled = true;
    return ok;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  release();
  assert.equal(await pending, true);
  session.set = realSet;
  assert.deepEqual(await getFacebookTheme(tabId), { theme: 'dark', at: 1234 });
});

test('setFacebookTheme rejects malformed signals without writing storage', async () => {
  assert.equal(await setFacebookTheme(tabId, { theme: 'dim', at: 1234 } as never), false);
  assert.equal(await setFacebookTheme(tabId, { theme: 'light', at: Number.NaN }), false);
  assert.equal((await chrome.storage.session.get(facebookThemeKey(tabId)))[facebookThemeKey(tabId)], undefined);
});

test('a user clear preserves the current Facebook theme for the same document', async () => {
  await setFacebookTheme(tabId, { theme: 'light', at: 1234 });
  await clearTab(tabId, { preserveFacebookTheme: true });
  assert.deepEqual(await getFacebookTheme(tabId), { theme: 'light', at: 1234 });
});

test('navigation clear and purgeTab remove the Facebook theme signal', async () => {
  await setFacebookTheme(tabId, { theme: 'light', at: 1234 });
  await clearTab(tabId);
  assert.equal(await getFacebookTheme(tabId), null);

  await setFacebookTheme(tabId, { theme: 'dark', at: 5678 });
  await purgeTab(tabId);
  assert.equal(await getFacebookTheme(tabId), null);
});

test('an out-of-order older signal never clobbers a newer stored theme', async () => {
  assert.equal(await setFacebookTheme(tabId, { theme: 'dark', at: 5000 }), true);
  // A late-arriving observation with an older worker timestamp must be ignored —
  // the monotonic guard keeps the newest boundary the panel already reflected.
  await setFacebookTheme(tabId, { theme: 'light', at: 4000 });
  assert.deepEqual(await getFacebookTheme(tabId), { theme: 'dark', at: 5000 });
  // A genuinely newer observation still advances the stored theme.
  assert.equal(await setFacebookTheme(tabId, { theme: 'light', at: 6000 }), true);
  assert.deepEqual(await getFacebookTheme(tabId), { theme: 'light', at: 6000 });
});
