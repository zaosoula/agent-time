import { shallowRef } from 'vue';

export type ActivityTarget = 'billing' | 'data' | 'storage';
export interface BackgroundActivity {
  id: number;
  label: string;
  target: ActivityTarget;
  detail: string;
  done: boolean;
  reveal?: () => void;
}

export const backgroundActivities = shallowRef<BackgroundActivity[]>([]);
let sequence = 0;

// Each operation owns its handle, so late completion cannot clear a newer job.
export function startBackgroundActivity(label: string, target: ActivityTarget, reveal?: () => void) {
  const id = ++sequence;
  backgroundActivities.value = [
    ...backgroundActivities.value.filter(item => !item.done),
    { id, label, target, detail: '', done: false, reveal },
  ];
  return {
    update(detail: string) {
      backgroundActivities.value = backgroundActivities.value.map(item =>
        item.id === id && !item.done ? { ...item, detail } : item,
      );
    },
    finish(label?: string) {
      backgroundActivities.value = label
        ? backgroundActivities.value.map(item => item.id === id ? { ...item, label, detail: '', done: true } : item)
        : backgroundActivities.value.filter(item => item.id !== id);
    },
  };
}

export function dismissBackgroundActivity(id: number) {
  backgroundActivities.value = backgroundActivities.value.filter(item => item.id !== id);
}

export function clearCompletedBackgroundActivities(target: ActivityTarget) {
  backgroundActivities.value = backgroundActivities.value.filter(item => item.target !== target || !item.done);
}
