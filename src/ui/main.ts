import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { startAppearance } from './appearance.ts';
const stopAppearance = startAppearance(window);
if (import.meta.hot) import.meta.hot.dispose(stopAppearance);
createApp(App).mount('#app');
