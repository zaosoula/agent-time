import { ref, watch } from 'vue';

export type Appearance = 'light' | 'dark' | 'system';
export const appearance = ref<Appearance>('system');
const key = 'agent-time.appearance';
export function normalizeAppearance(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function isDarkAppearance(value: Appearance, systemDark: boolean) {
  return value === 'dark' || value === 'system' && systemDark;
}

/** A device preference only; captured data and retained page state stay untouched. */
export function startAppearance(environment: Window) {
  const media = environment.matchMedia('(prefers-color-scheme: dark)');
  appearance.value = 'system';
  try { appearance.value = normalizeAppearance(environment.localStorage.getItem(key)); } catch { /* Private windows can deny storage. */ }
  const apply = () => {
    const dark = isDarkAppearance(appearance.value, media.matches);
    environment.document.documentElement.classList.toggle('ui-dark', dark);
    environment.document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  };
  apply();
  const stop = watch(appearance, () => {
    apply();
    try { environment.localStorage.setItem(key, appearance.value); } catch { /* Still works for this window. */ }
  }, { flush: 'sync' });
  const sync = (event: StorageEvent) => {
    if (event.key === key || event.key === null) appearance.value = normalizeAppearance(event.newValue);
  };
  media.addEventListener('change', apply);
  environment.addEventListener('storage', sync);
  return () => {
    stop();
    media.removeEventListener('change', apply);
    environment.removeEventListener('storage', sync);
  };
}
